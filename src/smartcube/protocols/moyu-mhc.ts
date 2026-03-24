
import { Subject } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, MacAddressProvider } from '../types';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import { CubieCube, SOLVED_FACELET } from '../cubie-cube';
import { now, findCharacteristic } from '../ble-utils';

const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const SERVICE_UUID = '00001000' + UUID_SUFFIX;
const CHRCT_UUID_WRITE = '00001001' + UUID_SUFFIX;
const CHRCT_UUID_READ = '00001002' + UUID_SUFFIX;
const CHRCT_UUID_TURN = '00001003' + UUID_SUFFIX;
const CHRCT_UUID_GYRO = '00001004' + UUID_SUFFIX;

class MoyuMhcConnection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly capabilities: SmartCubeCapabilities = {
        gyroscope: false,
        battery: false,
        facelets: false,
        hardware: false,
        reset: false
    };
    events$: Subject<SmartCubeEvent>;

    private device: BluetoothDevice;
    private readChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private turnChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private gyroChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private faceStatus = [0, 0, 0, 0, 0, 0];
    private curCubie = new CubieCube();
    private prevCubie = new CubieCube();

    constructor(device: BluetoothDevice) {
        this.device = device;
        this.deviceName = device.name || 'MHC';
        this.deviceMAC = '';
        this.events$ = new Subject<SmartCubeEvent>();
    }

    private onTurnEvent = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        this.parseTurn(value);
    };

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
            const dir = Math.round(data.getUint8(offset + 5) / 36);
            const prevRot = this.faceStatus[face];
            const curRot = this.faceStatus[face] + dir;
            this.faceStatus[face] = (curRot + 9) % 9;

            const axis = [3, 4, 5, 1, 2, 0][face];
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

            CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m], this.curCubie);
            const facelet = this.curCubie.toFaceCube();

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
                facelets: facelet
            });

            const tmp = this.curCubie;
            this.curCubie = this.prevCubie;
            this.prevCubie = tmp;
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
        const chrcts = await service.getCharacteristics();

        this.readChrct = findCharacteristic(chrcts, CHRCT_UUID_READ);
        this.turnChrct = findCharacteristic(chrcts, CHRCT_UUID_TURN);
        this.gyroChrct = findCharacteristic(chrcts, CHRCT_UUID_GYRO);

        if (this.readChrct) {
            await this.readChrct.startNotifications();
        }
        if (this.turnChrct) {
            this.turnChrct.addEventListener('characteristicvaluechanged', this.onTurnEvent);
            await this.turnChrct.startNotifications();
        }
        if (this.gyroChrct) {
            await this.gyroChrct.startNotifications();
        }

        this.events$.next({
            timestamp: now(),
            type: "FACELETS",
            facelets: SOLVED_FACELET
        });
    }

    async sendCommand(_command: SmartCubeCommand): Promise<void> {
        // MoYu MHC doesn't support request commands
    }

    async disconnect(): Promise<void> {
        if (this.readChrct) {
            await this.readChrct.stopNotifications().catch(() => {});
        }
        if (this.turnChrct) {
            this.turnChrct.removeEventListener('characteristicvaluechanged', this.onTurnEvent);
            await this.turnChrct.stopNotifications().catch(() => {});
        }
        if (this.gyroChrct) {
            await this.gyroChrct.stopNotifications().catch(() => {});
        }
        this.readChrct = null;
        this.turnChrct = null;
        this.gyroChrct = null;
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
