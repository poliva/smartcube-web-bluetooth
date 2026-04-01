
import { Subject } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, MacAddressProvider } from '../types';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import { CubieCube } from '../cubie-cube';
import { now, findCharacteristic } from '../ble-utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';

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

type GiikerHexPayload = {
    valhex: number[];
    logicalBytes: number;
};

function giikerHexPayload(value: DataView): GiikerHexPayload {
    const raw: number[] = [];
    for (let i = 0; i < 20; i++) {
        raw.push(value.getUint8(i));
    }

    let logicalBytes = raw.length;
    if (raw[18] === 0xa7) {
        const k1 = (raw[19] >> 4) & 0xf;
        const k2 = raw[19] & 0xf;
        for (let i = 0; i < 18; i++) {
            raw[i] = (raw[i] + DECRYPT_KEY[i + k1] + DECRYPT_KEY[i + k2]) & 0xFF;
        }
        logicalBytes = 18;
    }

    const valhex: number[] = [];
    for (let i = 0; i < logicalBytes; i++) {
        valhex.push((raw[i] >> 4) & 0xf);
        valhex.push(raw[i] & 0xf);
    }
    return { valhex, logicalBytes };
}

function giikerMoveString(faceNibble: number, dirNibble: number): string | null {
    const face = ["?", "B", "D", "L", "U", "R", "F"][faceNibble];
    if (!face || face === "?") return null;

    // Observed mappings: 1/2 => "", 3 => "2", 4 => "'", and some firmwares use 9 for half-turn.
    const dirKey = dirNibble === 9 ? 3 : dirNibble;
    const suffix = ["", "", "2", "'"][dirKey] ?? "";
    return `${face}${suffix}`;
}

function parseState(value: DataView): { facelet: string; prevMoves: string[] } {
    const { valhex } = giikerHexPayload(value);

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

    const prevMoves: string[] = [];
    // Byte 16 is the current move (face/dir nibbles). Encrypted packets must ignore bytes 18–19.
    const faceNibble = valhex[32];
    const dirNibble = valhex[33];
    if (faceNibble !== undefined && dirNibble !== undefined) {
        const mv = giikerMoveString(faceNibble, dirNibble);
        if (mv) prevMoves.push(mv);
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
        hardware: true,
        reset: true
    };
    events$: Subject<SmartCubeEvent>;

    private device: BluetoothDevice;
    private gatt: BluetoothRemoteGATTServer | null = null;
    private dataChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private lastFacelet: string = '';
    private isReady = false;
    private pendingValues: DataView[] = [];
    private rwReadChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private rwWriteChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private batteryInterval: ReturnType<typeof setInterval> | null = null;
    private onBatteryChanged: ((evt: Event) => void) | null = null;
    private lastBatteryLevel: number | null = null;

    constructor(device: BluetoothDevice, name: string) {
        this.device = device;
        this.deviceName = name;
        this.deviceMAC = '';
        this.events$ = new Subject<SmartCubeEvent>();
    }

    private onStateChanged = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        if (!this.isReady) {
            // Copy the view, because the underlying buffer can be reused by the platform.
            const b = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            this.pendingValues.push(new DataView(b));
            return;
        }
        const timestamp = now();
        const { facelet, prevMoves } = parseState(value);

        if (this.lastFacelet && this.lastFacelet !== facelet && prevMoves.length > 0) {
            const moveStr = prevMoves[0].trim();
            const face = "URFDLB".indexOf(moveStr[0]);
            const direction = moveStr.includes("2") ? 2 : moveStr.includes("'") ? 1 : 0;

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

    private emitHardwareEvent(): void {
        this.events$.next({
            timestamp: now(),
            type: "HARDWARE",
            hardwareName: this.deviceName,
            gyroSupported: false
        });
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

    private onDisconnect = (): void => {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.isReady = false;
        this.pendingValues = [];
        this.lastBatteryLevel = null;
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
        if (this.rwReadChrct && this.onBatteryChanged) {
            this.rwReadChrct.removeEventListener('characteristicvaluechanged', this.onBatteryChanged);
        }
        this.onBatteryChanged = null;
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
    };

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);

        this.gatt = await this.device.gatt!.connect();
        const dataService = await this.gatt.getPrimaryService(SERVICE_UUID_DATA);
        this.dataChrct = await dataService.getCharacteristic(CHRCT_UUID_DATA);

        // Attach listener before notifications to reduce missed packets.
        this.dataChrct.addEventListener('characteristicvaluechanged', this.onStateChanged);
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

        // Setup periodic battery polling if the control service is available.
        try {
            const rwService = await this.gatt.getPrimaryService(SERVICE_UUID_RW);
            const chrcts = await rwService.getCharacteristics();
            this.rwReadChrct = findCharacteristic(chrcts, CHRCT_UUID_READ);
            this.rwWriteChrct = findCharacteristic(chrcts, CHRCT_UUID_WRITE);
            if (this.rwReadChrct && this.rwWriteChrct) {
                this.onBatteryChanged = (evt: Event) => {
                    const val = (evt.target as BluetoothRemoteGATTCharacteristic).value;
                    if (!val) return;
                    this.emitBatteryLevel(val.getUint8(1));
                };
                this.rwReadChrct.addEventListener('characteristicvaluechanged', this.onBatteryChanged);
                await this.rwReadChrct.startNotifications();

                const tick = () => {
                    if (!this.rwWriteChrct) return;
                    writeGattCharacteristicValue(this.rwWriteChrct, new Uint8Array([0xb5]).buffer).catch(() => {});
                };
                tick();
                this.batteryInterval = setInterval(tick, 60_000);
            }
        } catch {
            // Battery service may not be available
        }

        // Release any queued notifications that arrived during init.
        this.isReady = true;
        const queued = this.pendingValues;
        this.pendingValues = [];
        for (const dv of queued) {
            // Reuse the same logic path.
            const ts2 = now();
            const { facelet: f2, prevMoves: m2 } = parseState(dv);
            if (this.lastFacelet && this.lastFacelet !== f2 && m2.length > 0) {
                const moveStr = m2[0].trim();
                const face = "URFDLB".indexOf(moveStr[0]);
                const direction = moveStr.includes("2") ? 2 : moveStr.includes("'") ? 1 : 0;
                this.events$.next({
                    timestamp: ts2,
                    type: "MOVE",
                    face,
                    direction,
                    move: moveStr,
                    localTimestamp: ts2,
                    cubeTimestamp: null
                });
            }
            this.lastFacelet = f2;
            this.events$.next({
                timestamp: ts2,
                type: "FACELETS",
                facelets: f2
            });
        }
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (command.type === "REQUEST_BATTERY") {
            // Periodic battery polling is set up in init when available.
            if (this.rwWriteChrct) {
                await writeGattCharacteristicValue(this.rwWriteChrct, new Uint8Array([0xb5]).buffer);
            }
        } else if (command.type === "REQUEST_FACELETS") {
            if (this.lastFacelet) {
                this.events$.next({
                    timestamp: now(),
                    type: "FACELETS",
                    facelets: this.lastFacelet
                });
            }
        } else if (command.type === "REQUEST_HARDWARE") {
            this.emitHardwareEvent();
        } else if (command.type === "REQUEST_RESET") {
            if (this.rwWriteChrct) {
                await writeGattCharacteristicValue(this.rwWriteChrct, new Uint8Array([0xa1]).buffer);
            }
        }
    }

    async disconnect(): Promise<void> {
        if (this.dataChrct) {
            this.dataChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
            await this.dataChrct.stopNotifications().catch(() => {});
            this.dataChrct = null;
        }
        this.lastBatteryLevel = null;
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
        if (this.rwReadChrct) {
            if (this.onBatteryChanged) {
                this.rwReadChrct.removeEventListener('characteristicvaluechanged', this.onBatteryChanged);
            }
            await this.rwReadChrct.stopNotifications().catch(() => {});
            this.rwReadChrct = null;
        }
        this.onBatteryChanged = null;
        this.rwWriteChrct = null;
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
        const devName = device.name || '';
        const name =
            devName.startsWith('GiC') ? 'Giiker i3' :
                devName.startsWith('GiS') ? 'Giiker i3S' :
                    devName.startsWith('GiY') ? 'Giiker i3Y' :
                        devName.startsWith('Mi Smart') ? 'Mi Smart Magic Cube' :
                            devName.startsWith('Gi') ? 'Giiker i3SE' :
                                devName.startsWith('Hi-') ? 'Hi-' :
                                    devName || 'Unknown';
        const conn = new GiikerConnection(device, name);
        await conn.init();
        return conn;
    }
};

registerProtocol(giikerProtocol);

export { giikerProtocol };
