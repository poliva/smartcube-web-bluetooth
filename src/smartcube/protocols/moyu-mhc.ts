
import { Subject } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, MacAddressProvider } from '../types';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import { CubieCube, SOLVED_FACELET } from '../cubie-cube';
import { now, findCharacteristic } from '../ble-utils';
import {
    MoyuV1Client,
    moyuStickersToFaceletString,
    MOYU_V1_SOLVED_STICKERS,
} from './moyu-v1';

const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const SERVICE_UUID = '00001000' + UUID_SUFFIX;
const CHRCT_UUID_WRITE = '00001001' + UUID_SUFFIX;
const CHRCT_UUID_READ = '00001002' + UUID_SUFFIX;
const CHRCT_UUID_TURN = '00001003' + UUID_SUFFIX;
const CHRCT_UUID_GYRO = '00001004' + UUID_SUFFIX;

const FACE_ORDER_LEN = 6;
const DEVICE_FACE_TO_AXIS = [3, 4, 5, 1, 2, 0] as const;

function normalizeQuaternion(q: { w: number; x: number; y: number; z: number }): {
    w: number;
    x: number;
    y: number;
    z: number;
} {
    const n = Math.hypot(q.w, q.x, q.y, q.z) || 1;
    return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

const MOYU_MHC_PROTOCOL: SmartCubeProtocolInfo = { id: 'moyu-mhc', name: 'MoYu MHC' };

class MoyuMhcConnection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo = MOYU_MHC_PROTOCOL;
    readonly capabilities: SmartCubeCapabilities;
    events$: Subject<SmartCubeEvent>;

    private device: BluetoothDevice;
    private writeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private readChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private turnChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private gyroChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private v1: MoyuV1Client | null = null;
    private faceStatus = [0, 0, 0, 0, 0, 0];
    private curCubie = new CubieCube();
    private prevCubie = new CubieCube();
    private lastBatteryLevel: number | null = null;
    private batteryInterval: ReturnType<typeof setInterval> | null = null;

    constructor(device: BluetoothDevice) {
        this.device = device;
        this.deviceName = device.name || 'MHC';
        this.deviceMAC = '';
        this.events$ = new Subject<SmartCubeEvent>();
        this.capabilities = {
            gyroscope: false,
            battery: false,
            facelets: false,
            hardware: false,
            reset: false,
        };
    }

    private onTurnEvent = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        this.parseTurn(value);
    };

    private onReadEvent = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value || !this.v1) return;
        this.v1.onReadNotification(value);
    };

    private onGyroEvent = (event: Event): void => {
        const e = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!e || e.byteLength < 20) return;
        const fw = e.getFloat32(4, true);
        const fx = e.getFloat32(8, true);
        const fy = e.getFloat32(12, true);
        const fz = e.getFloat32(16, true);
        const quaternion = normalizeQuaternion({
            w: fw,
            x: fx,
            y: -fy,
            z: fz,
        });
        const timestamp = now();
        this.events$.next({
            timestamp,
            type: 'GYRO',
            quaternion,
        });
    };

    /**
     * After each move, `prevCubie` holds the latest physical state (see parseTurn swap).
     * Seed that cube from the device facelet string and align turn counters with gyro angles.
     */
    private applyCubeStateFromDevice(stickers: number[][], angles: number[]): void {
        const facelet = moyuStickersToFaceletString(stickers);
        this.prevCubie = new CubieCube();
        const parsed = this.prevCubie.fromFacelet(facelet);
        if (parsed === -1) {
            this.prevCubie = new CubieCube();
            this.curCubie = new CubieCube();
            this.faceStatus = [0, 0, 0, 0, 0, 0];
            return;
        }
        this.curCubie = new CubieCube();
        for (let i = 0; i < FACE_ORDER_LEN; i++) {
            this.faceStatus[i] = (angles[i] ?? 0) % 9;
        }
    }

    private parseTurn(data: DataView): void {
        const timestamp = now();
        if (data.byteLength < 1) return;
        const nMoves = data.getUint8(0);
        if (data.byteLength < 1 + nMoves * 6) return;

        for (let i = 0; i < nMoves; i++) {
            const offset = 1 + i * 6;
            let ts = data.getUint8(offset + 1) << 24
                | data.getUint8(offset + 0) << 16
                | data.getUint8(offset + 3) << 8
                | data.getUint8(offset + 2);
            ts = Math.round(ts / 65536 * 1000);

            const face = data.getUint8(offset + 4);
            if (face >= FACE_ORDER_LEN) continue;

            const dir = Math.round(data.getInt8(offset + 5) / 36);
            const prevRot = this.faceStatus[face]!;
            const curRot = this.faceStatus[face]! + dir;
            this.faceStatus[face] = (curRot + 9) % 9;

            const axis = DEVICE_FACE_TO_AXIS[face]!;
            let pow: number;
            if (prevRot >= 5 && curRot <= 4) {
                pow = 2;
            } else if (prevRot <= 4 && curRot >= 5) {
                pow = 0;
            } else {
                continue;
            }

            const m = axis * 3 + pow;
            const moveStr = ("URFDLB".charAt(axis) + " 2'".charAt(pow)).trim();

            CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m]!, this.curCubie);
            const faceletStr = this.curCubie.toFaceCube();

            this.events$.next({
                timestamp,
                type: "MOVE",
                face: axis,
                direction: pow === 0 ? 0 : 1,
                move: moveStr,
                localTimestamp: timestamp,
                cubeTimestamp: ts
            });

            this.events$.next({
                timestamp,
                type: "FACELETS",
                facelets: faceletStr
            });

            const tmp = this.curCubie;
            this.curCubie = this.prevCubie;
            this.prevCubie = tmp;
        }
    }

    private emitBatteryLevel(rawLevel: number, timestamp = now()): void {
        if (!Number.isFinite(rawLevel)) {
            return;
        }
        const batteryLevel = Math.min(100, Math.max(0, Math.round(rawLevel)));
        if (this.lastBatteryLevel === batteryLevel) {
            return;
        }
        this.lastBatteryLevel = batteryLevel;
        this.events$.next({
            timestamp,
            type: 'BATTERY',
            batteryLevel,
        });
    }

    private async pollBattery(): Promise<void> {
        if (!this.v1) {
            return;
        }
        try {
            const b = await this.v1.getBatteryInfo();
            this.emitBatteryLevel(b.value.percentage);
        } catch {
            /* ignore failed optional commands */
        }
    }

    private onDisconnect = (): void => {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.lastBatteryLevel = null;
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
    };

    private updateCapabilities(): void {
        const hasV1 = this.v1 !== null;
        this.capabilities.gyroscope = this.gyroChrct !== null;
        this.capabilities.battery = hasV1;
        this.capabilities.facelets = hasV1;
        this.capabilities.hardware = hasV1;
        this.capabilities.reset = hasV1;
    }

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
        const gatt = await this.device.gatt!.connect();
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        const chrcts = await service.getCharacteristics();

        this.writeChrct = findCharacteristic(chrcts, CHRCT_UUID_WRITE);
        this.readChrct = findCharacteristic(chrcts, CHRCT_UUID_READ);
        this.turnChrct = findCharacteristic(chrcts, CHRCT_UUID_TURN);
        this.gyroChrct = findCharacteristic(chrcts, CHRCT_UUID_GYRO);

        if (this.writeChrct) {
            this.v1 = new MoyuV1Client(this.writeChrct);
        }

        if (this.readChrct) {
            this.readChrct.addEventListener('characteristicvaluechanged', this.onReadEvent);
            await this.readChrct.startNotifications();
        }

        if (this.turnChrct) {
            this.turnChrct.addEventListener('characteristicvaluechanged', this.onTurnEvent);
            await this.turnChrct.startNotifications();
        }

        if (this.gyroChrct) {
            this.gyroChrct.addEventListener('characteristicvaluechanged', this.onGyroEvent);
            await this.gyroChrct.startNotifications();
        }

        this.updateCapabilities();

        if (this.v1) {
            await this.pollBattery();
            this.batteryInterval = setInterval(() => {
                void this.pollBattery();
            }, 60_000);
            try {
                const st = await this.v1.getCubeState();
                this.applyCubeStateFromDevice(st.stickers, st.angles);
                const facelets = this.prevCubie.toFaceCube();
                this.events$.next({
                    timestamp: now(),
                    type: 'FACELETS',
                    facelets,
                });
            } catch {
                this.events$.next({
                    timestamp: now(),
                    type: 'FACELETS',
                    facelets: SOLVED_FACELET,
                });
            }
        } else {
            this.events$.next({
                timestamp: now(),
                type: 'FACELETS',
                facelets: SOLVED_FACELET,
            });
        }
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (!this.v1) return;

        const ts = now();
        try {
            if (command.type === 'REQUEST_FACELETS') {
                const st = await this.v1.getCubeState();
                this.applyCubeStateFromDevice(st.stickers, st.angles);
                this.events$.next({
                    timestamp: ts,
                    type: 'FACELETS',
                    facelets: this.prevCubie.toFaceCube(),
                });
            } else if (command.type === 'REQUEST_BATTERY') {
                const b = await this.v1.getBatteryInfo();
                this.emitBatteryLevel(b.value.percentage, ts);
            } else if (command.type === 'REQUEST_HARDWARE') {
                const h = await this.v1.getHardwareInfo();
                this.events$.next({
                    timestamp: ts,
                    type: 'HARDWARE',
                    softwareVersion: `${h.major}.${h.minor}.${h.patch}`,
                    hardwareVersion: `boot:${h.bootCount}`,
                    gyroSupported: this.capabilities.gyroscope,
                });
            } else if (command.type === 'REQUEST_RESET') {
                await this.v1.setCubeState(MOYU_V1_SOLVED_STICKERS, [0, 0, 0, 0, 0, 0]);
                this.faceStatus = [0, 0, 0, 0, 0, 0];
                this.curCubie = new CubieCube();
                this.prevCubie = new CubieCube();
                this.events$.next({
                    timestamp: ts,
                    type: 'FACELETS',
                    facelets: SOLVED_FACELET,
                });
            }
        } catch {
            /* ignore failed optional commands */
        }
    }

    async disconnect(): Promise<void> {
        if (this.readChrct) {
            this.readChrct.removeEventListener('characteristicvaluechanged', this.onReadEvent);
            await this.readChrct.stopNotifications().catch(() => {});
        }
        if (this.turnChrct) {
            this.turnChrct.removeEventListener('characteristicvaluechanged', this.onTurnEvent);
            await this.turnChrct.stopNotifications().catch(() => {});
        }
        if (this.gyroChrct) {
            this.gyroChrct.removeEventListener('characteristicvaluechanged', this.onGyroEvent);
            await this.gyroChrct.stopNotifications().catch(() => {});
        }
        this.lastBatteryLevel = null;
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
        this.readChrct = null;
        this.turnChrct = null;
        this.gyroChrct = null;
        this.writeChrct = null;
        this.v1 = null;
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}

const moyuMhcProtocol: SmartCubeProtocol = {
    nameFilters: [
        { namePrefix: "MHC" }
    ],
    optionalServices: [SERVICE_UUID],

    matchesDevice(device: BluetoothDevice): boolean {
        const name = device.name || '';
        return name.startsWith('MHC');
    },

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(SERVICE_UUID)) ? 110 : 0;
    },

    async connect(
        device: BluetoothDevice,
        _macProvider?: MacAddressProvider,
        _context?: AttachmentContext
    ): Promise<SmartCubeConnection> {
        const conn = new MoyuMhcConnection(device);
        await conn.init();
        return conn;
    }
};

registerProtocol(moyuMhcProtocol);

export { moyuMhcProtocol };
