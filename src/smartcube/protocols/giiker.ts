
import { Subject } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, MacAddressProvider } from '../types';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import { CubieCube } from '../cubie-cube';
import { now, findCharacteristic } from '../ble-utils';

const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const SERVICE_UUID_DATA = '0000aadb' + UUID_SUFFIX;
const CHRCT_UUID_DATA = '0000aadc' + UUID_SUFFIX;
const SERVICE_UUID_RW = '0000aaaa' + UUID_SUFFIX;
const CHRCT_UUID_READ = '0000aaab' + UUID_SUFFIX;
const CHRCT_UUID_WRITE = '0000aaac' + UUID_SUFFIX;

const GIIKER_CFACELET = [
    [26, 15, 29], [20, 8, 9], [18, 38, 6], [24, 27, 44],
    [51, 35, 17], [45, 11, 2], [47, 0, 36], [53, 42, 33]
];

const GIIKER_EFACELET = [
    [25, 28], [23, 12], [19, 7], [21, 41],
    [32, 16], [5, 10], [3, 37], [30, 43],
    [52, 34], [48, 14], [46, 1], [50, 39]
];

const DECRYPT_KEY = [176, 81, 104, 224, 86, 137, 237, 119, 38, 26, 193, 161, 210, 126, 150, 81, 93, 13, 236, 249, 89, 235, 88, 24, 113, 81, 214, 131, 130, 199, 2, 169, 39, 165, 171, 41];
const CO_MASK = [-1, 1, -1, 1, 1, -1, 1, -1];

function toHexVal(value: DataView): number[] {
    const raw: number[] = [];
    for (let i = 0; i < 20; i++) {
        raw.push(value.getUint8(i));
    }
    if (raw[18] === 0xa7) {
        const k1 = (raw[19] >> 4) & 0xf;
        const k2 = raw[19] & 0xf;
        for (let i = 0; i < 18; i++) {
            raw[i] = (raw[i] + DECRYPT_KEY[i + k1] + DECRYPT_KEY[i + k2]) & 0xFF;
        }
    }
    const valhex: number[] = [];
    for (let i = 0; i < raw.length; i++) {
        valhex.push((raw[i] >> 4) & 0xf);
        valhex.push(raw[i] & 0xf);
    }
    return valhex;
}

function parseState(value: DataView): { facelet: string; prevMoves: string[] } {
    const valhex = toHexVal(value);

    const eo: number[] = [];
    for (let i = 0; i < 3; i++) {
        for (let mask = 8; mask !== 0; mask >>= 1) {
            eo.push((valhex[i + 28] & mask) ? 1 : 0);
        }
    }

    const cc = new CubieCube();
    for (let i = 0; i < 8; i++) {
        cc.ca[i] = (valhex[i] - 1) | (((3 + valhex[i + 8] * CO_MASK[i]) % 3) << 3);
    }
    for (let i = 0; i < 12; i++) {
        cc.ea[i] = ((valhex[i + 16] - 1) << 1) | eo[i];
    }
    const facelet = cc.toFaceCube(GIIKER_CFACELET, GIIKER_EFACELET);

    const moves = valhex.slice(32, 40);
    const prevMoves: string[] = [];
    for (let i = 0; i < moves.length; i += 2) {
        prevMoves.push("BDLURF".charAt(moves[i] - 1) + " 2'".charAt((moves[i + 1] - 1) % 7));
    }

    return { facelet, prevMoves };
}

class GiikerConnection implements SmartCubeConnection {
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
    private gatt: BluetoothRemoteGATTServer | null = null;
    private dataChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private lastFacelet: string = '';

    constructor(device: BluetoothDevice, name: string) {
        this.device = device;
        this.deviceName = name;
        this.deviceMAC = '';
        this.events$ = new Subject<SmartCubeEvent>();
    }

    private onStateChanged = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const timestamp = now();
        const { facelet, prevMoves } = parseState(value);

        if (this.lastFacelet && this.lastFacelet !== facelet && prevMoves.length > 0) {
            const moveStr = prevMoves[0].trim();
            const face = "URFDLB".indexOf(moveStr[0]);
            const direction = moveStr.length > 1 && moveStr[1] === "'" ? 1 : 0;

            this.events$.next({
                timestamp,
                type: "MOVE",
                face,
                direction,
                move: moveStr,
                localTimestamp: timestamp,
                cubeTimestamp: null
            });
        }

        this.lastFacelet = facelet;
        this.events$.next({
            timestamp,
            type: "FACELETS",
            facelets: facelet
        });
    };

    private onDisconnect = (): void => {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
    };

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);

        this.gatt = await this.device.gatt!.connect();
        const dataService = await this.gatt.getPrimaryService(SERVICE_UUID_DATA);
        this.dataChrct = await dataService.getCharacteristic(CHRCT_UUID_DATA);

        await this.dataChrct.startNotifications();
        const initialValue = await this.dataChrct.readValue();
        const { facelet } = parseState(initialValue);
        this.lastFacelet = facelet;

        const timestamp = now();
        this.events$.next({
            timestamp,
            type: "FACELETS",
            facelets: facelet
        });

        this.dataChrct.addEventListener('characteristicvaluechanged', this.onStateChanged);
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (command.type === "REQUEST_BATTERY") {
            try {
                const rwService = await this.gatt!.getPrimaryService(SERVICE_UUID_RW);
                const chrcts = await rwService.getCharacteristics();
                const readChrct = findCharacteristic(chrcts, CHRCT_UUID_READ);
                const writeChrct = findCharacteristic(chrcts, CHRCT_UUID_WRITE);
                if (readChrct && writeChrct) {
                    const batteryPromise = new Promise<number>((resolve) => {
                        const listener = (evt: Event) => {
                            const val = (evt.target as BluetoothRemoteGATTCharacteristic).value;
                            if (val) {
                                resolve(val.getUint8(1));
                            }
                            readChrct.removeEventListener('characteristicvaluechanged', listener);
                            readChrct.stopNotifications().catch(() => {});
                        };
                        readChrct.addEventListener('characteristicvaluechanged', listener);
                    });
                    await readChrct.startNotifications();
                    await writeChrct.writeValue(new Uint8Array([0xb5]).buffer);
                    const level = await batteryPromise;
                    this.events$.next({
                        timestamp: now(),
                        type: "BATTERY",
                        batteryLevel: level
                    });
                }
            } catch {
                // Battery service may not be available
            }
        } else if (command.type === "REQUEST_FACELETS") {
            if (this.lastFacelet) {
                this.events$.next({
                    timestamp: now(),
                    type: "FACELETS",
                    facelets: this.lastFacelet
                });
            }
        }
    }

    async disconnect(): Promise<void> {
        if (this.dataChrct) {
            this.dataChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
            await this.dataChrct.stopNotifications().catch(() => {});
            this.dataChrct = null;
        }
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}

const giikerProtocol: SmartCubeProtocol = {
    nameFilters: [
        { namePrefix: "Gi" },
        { namePrefix: "Mi Smart Magic Cube" },
        { namePrefix: "Hi-" }
    ],
    optionalServices: [SERVICE_UUID_DATA, SERVICE_UUID_RW],

    matchesDevice(device: BluetoothDevice): boolean {
        const name = device.name || '';
        return name.startsWith('Gi') || name.startsWith('Mi Smart Magic Cube') || name.startsWith('Hi-');
    },

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(SERVICE_UUID_DATA)) ? 115 : 0;
    },

    async connect(
        device: BluetoothDevice,
        _macProvider?: MacAddressProvider,
        _context?: AttachmentContext
    ): Promise<SmartCubeConnection> {
        const name = device.name?.startsWith('Gi') ? 'Giiker' : device.name?.startsWith('Mi') ? 'Mi Smart' : device.name || 'Unknown';
        const conn = new GiikerConnection(device, name);
        await conn.init();
        return conn;
    }
};

registerProtocol(giikerProtocol);

export { giikerProtocol };
