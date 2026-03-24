
import { Subject } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, MacAddressProvider } from '../types';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import { CubieCube } from '../cubie-cube';
import { now } from '../ble-utils';

const UUID_SUFFIX = '-b5a3-f393-e0a9-e50e24dcca9e';
const SERVICE_UUID = '6e400001' + UUID_SUFFIX;
const CHRCT_UUID_WRITE = '6e400002' + UUID_SUFFIX;
const CHRCT_UUID_READ = '6e400003' + UUID_SUFFIX;

const WRITE_BATTERY = 50;
const WRITE_STATE = 51;

const AXIS_PERM = [5, 2, 0, 3, 1, 4];
const FACE_PERM = [0, 1, 2, 5, 8, 7, 6, 3];
const FACE_OFFSET = [0, 0, 6, 2, 0, 0];

class GoCubeConnection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly capabilities: SmartCubeCapabilities = {
        gyroscope: false,
        battery: true,
        facelets: true,
        hardware: false,
        reset: false
    };
    events$: Subject<SmartCubeEvent>;

    private device: BluetoothDevice;
    private readChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private writeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private curCubie = new CubieCube();
    private prevCubie = new CubieCube();
    private moveCntFree = 100;
    private batteryLevel = 100;

    constructor(device: BluetoothDevice, name: string) {
        this.device = device;
        this.deviceName = name;
        this.deviceMAC = '';
        this.events$ = new Subject<SmartCubeEvent>();
    }

    private onStateChanged = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        this.parseData(value);
    };

    private parseData(value: DataView): void {
        const timestamp = now();
        if (value.byteLength < 4) return;
        if (value.getUint8(0) !== 0x2a ||
            value.getUint8(value.byteLength - 2) !== 0x0d ||
            value.getUint8(value.byteLength - 1) !== 0x0a) {
            return;
        }

        const msgType = value.getUint8(2);
        const msgLen = value.byteLength - 6;

        if (msgType === 1) { // Move
            for (let i = 0; i < msgLen; i += 2) {
                const axis = AXIS_PERM[value.getUint8(3 + i) >> 1];
                const power = [0, 2][value.getUint8(3 + i) & 1];
                const m = axis * 3 + power;
                const moveStr = ("URFDLB".charAt(axis) + " 2'".charAt(power)).trim();

                CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m], this.curCubie);
                const facelet = this.curCubie.toFaceCube();

                this.events$.next({
                    timestamp,
                    type: "MOVE",
                    face: axis,
                    direction: power === 0 ? 0 : 1,
                    move: moveStr,
                    localTimestamp: timestamp,
                    cubeTimestamp: null
                });

                this.events$.next({
                    timestamp,
                    type: "FACELETS",
                    facelets: facelet
                });

                const tmp = this.curCubie;
                this.curCubie = this.prevCubie;
                this.prevCubie = tmp;

                if (++this.moveCntFree > 20) {
                    this.moveCntFree = 0;
                    this.writeChrct?.writeValue(new Uint8Array([WRITE_STATE]).buffer).catch(() => {});
                }
            }
        } else if (msgType === 2) { // Cube state
            const facelet: string[] = [];
            for (let a = 0; a < 6; a++) {
                const axis = AXIS_PERM[a] * 9;
                const aoff = FACE_OFFSET[a];
                facelet[axis + 4] = "BFUDRL".charAt(value.getUint8(3 + a * 9));
                for (let i = 0; i < 8; i++) {
                    facelet[axis + FACE_PERM[(i + aoff) % 8]] = "BFUDRL".charAt(value.getUint8(3 + a * 9 + i + 1));
                }
            }
            const newFacelet = facelet.join('');
            const curFacelet = this.prevCubie.toFaceCube();
            if (newFacelet !== curFacelet) {
                this.curCubie.fromFacelet(newFacelet);
                const tmp = this.curCubie;
                this.curCubie = this.prevCubie;
                this.prevCubie = tmp;
            }
        } else if (msgType === 5) { // Battery
            this.batteryLevel = value.getUint8(3);
            this.events$.next({
                timestamp,
                type: "BATTERY",
                batteryLevel: this.batteryLevel
            });
        }
    }

    private onDisconnect = (): void => {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
    };

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
        const gatt = await this.device.gatt!.connect();
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        this.writeChrct = await service.getCharacteristic(CHRCT_UUID_WRITE);
        this.readChrct = await service.getCharacteristic(CHRCT_UUID_READ);
        await this.readChrct.startNotifications();
        this.readChrct.addEventListener('characteristicvaluechanged', this.onStateChanged);
        await this.writeChrct.writeValue(new Uint8Array([WRITE_STATE]).buffer);
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (command.type === "REQUEST_BATTERY" && this.writeChrct) {
            await this.writeChrct.writeValue(new Uint8Array([WRITE_BATTERY]).buffer);
        } else if (command.type === "REQUEST_FACELETS" && this.writeChrct) {
            await this.writeChrct.writeValue(new Uint8Array([WRITE_STATE]).buffer);
        }
    }

    async disconnect(): Promise<void> {
        if (this.readChrct) {
            this.readChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
            await this.readChrct.stopNotifications().catch(() => {});
            this.readChrct = null;
        }
        this.writeChrct = null;
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}

const goCubeProtocol: SmartCubeProtocol = {
    nameFilters: [
        { namePrefix: 'GoCube_' },
        { namePrefix: 'GoCube' },
        { namePrefix: 'Rubiks' }
    ],
    optionalServices: [SERVICE_UUID],

    matchesDevice(device: BluetoothDevice): boolean {
        const name = device.name || '';
        return name.startsWith('GoCube') || name.startsWith('Rubiks');
    },

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(SERVICE_UUID)) ? 110 : 0;
    },

    async connect(
        device: BluetoothDevice,
        _macProvider?: MacAddressProvider,
        _context?: AttachmentContext
    ): Promise<SmartCubeConnection> {
        const name = device.name?.startsWith('GoCube') ? 'GoCube' : 'Rubiks Connected';
        const conn = new GoCubeConnection(device, name);
        await conn.init();
        return conn;
    }
};

registerProtocol(goCubeProtocol);

export { goCubeProtocol };
