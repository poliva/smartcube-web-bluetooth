
import { Subject } from 'rxjs';
import { ModeOfOperation } from 'aes-js';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, MacAddressProvider } from '../types';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { getCachedMacForDevice } from '../attachment/address-hints';
import { buildMoyu32MacCandidatesFromName } from '../attachment/mac-candidates';
import { probeMoyu32Mac } from '../attachment/mac-probe-moyu32';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import { CubieCube, SOLVED_FACELET } from '../cubie-cube';
import { parse2x2Facelets, to2x2Facelets } from '../facelets-2x2';
import { decodeMoyuMoveHistory } from './moyu32-move-history';
import { now, findCharacteristic, waitForAdvertisements } from '../ble-utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';

const SERVICE_UUID = '0783b03e-7735-b5a0-1760-a305d2795cb0';
const CHRT_UUID_READ = '0783b03e-7735-b5a0-1760-a305d2795cb1';
const CHRT_UUID_WRITE = '0783b03e-7735-b5a0-1760-a305d2795cb2';

/** Opcode 172 + payload to enable gyro notifications (MoYu WCU). */
const ENABLE_GYRO_PAYLOAD = Object.freeze([
    172, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]) as readonly number[];

const BASE_KEY = [21, 119, 58, 92, 103, 14, 45, 31, 23, 103, 42, 19, 155, 103, 82, 87];
const BASE_IV = [17, 35, 38, 37, 134, 42, 44, 59, 85, 6, 127, 49, 126, 103, 33, 87];

/**
 * Parse 6 MAC octets from a manufacturer data DataView into canonical `aa:bb:…` form.
 * When length >= 8, the first two bytes are treated as company ID and skipped; the next six
 * are the cube address in LSB-first wire order (reversed into display order), matching key derivation.
 */
function moyu32MacColonFromManufacturerDataView(dv: DataView): string | null {
    const n = dv.byteLength;
    if (n < 6) {
        return null;
    }
    const skipCid = n >= 8 ? 2 : 0;
    if (n < skipCid + 6) {
        return null;
    }
    const parts: string[] = [];
    for (let i = 0; i < 6; i++) {
        parts.push((dv.getUint8(skipCid + 5 - i) + 0x100).toString(16).slice(1));
    }
    return parts.join(':');
}

function parseMoyu32MacFromMf(mfData: BluetoothManufacturerData | DataView | null): string | null {
    if (!mfData) {
        return null;
    }
    if (mfData instanceof DataView) {
        return moyu32MacColonFromManufacturerDataView(mfData);
    }
    for (const id of mfData.keys()) {
        const dataView = mfData.get(id);
        if (dataView) {
            const mac = moyu32MacColonFromManufacturerDataView(dataView);
            if (mac) {
                return mac;
            }
        }
    }
    return null;
}

class Moyu32Encrypter {
    private key: number[];
    private iv: number[];

    constructor(macBytes: number[]) {
        this.key = BASE_KEY.slice();
        this.iv = BASE_IV.slice();
        for (let i = 0; i < 6; i++) {
            this.key[i] = (this.key[i] + macBytes[5 - i]) % 255;
            this.iv[i] = (this.iv[i] + macBytes[5 - i]) % 255;
        }
    }

    decrypt(data: number[]): number[] {
        const ret = data.slice();
        const cipher = new ModeOfOperation.ecb(new Uint8Array(this.key));
        if (ret.length > 16) {
            const offset = ret.length - 16;
            const block = cipher.decrypt(new Uint8Array(ret.slice(offset)));
            for (let i = 0; i < 16; i++) {
                ret[i + offset] = block[i] ^ (~~this.iv[i]);
            }
        }
        const block = cipher.decrypt(new Uint8Array(ret.slice(0, 16)));
        for (let i = 0; i < 16; i++) {
            ret[i] = block[i] ^ (~~this.iv[i]);
        }
        return ret;
    }

    encrypt(data: number[]): number[] {
        const ret = data.slice();
        const cipher = new ModeOfOperation.ecb(new Uint8Array(this.key));
        for (let i = 0; i < 16; i++) {
            ret[i] ^= ~~this.iv[i];
        }
        const block = cipher.encrypt(new Uint8Array(ret.slice(0, 16)));
        for (let i = 0; i < 16; i++) {
            ret[i] = block[i];
        }
        if (ret.length > 16) {
            const offset = ret.length - 16;
            for (let i = 0; i < 16; i++) {
                ret[i + offset] ^= ~~this.iv[i];
            }
            const block2 = cipher.encrypt(new Uint8Array(ret.slice(offset, offset + 16)));
            for (let i = 0; i < 16; i++) {
                ret[i + offset] = block2[i];
            }
        }
        return ret;
    }
}

function parseFacelet(faceletBits: string, cubeSize: 2 | 3 = 3): string {
    const state: string[] = [];
    const faces = [2, 5, 0, 3, 4, 1]; // parse in order URFDLB instead of FBUDLR
    for (let i = 0; i < 6; i++) {
        const stickersPerFace = cubeSize === 2 ? 4 : 8;
        const faceBits = stickersPerFace * 3;
        const face = faceletBits.slice(faces[i] * faceBits, (faces[i] + 1) * faceBits);
        for (let j = 0; j < stickersPerFace; j++) {
            state.push("FBUDLR".charAt(parseInt(face.slice(j * 3, 3 + j * 3), 2)));
            if (cubeSize === 3 && j === 3) {
                state.push("FBUDLR".charAt(faces[i]));
            }
        }
    }
    return state.join('');
}

const MOYU32_PROTOCOL: SmartCubeProtocolInfo = { id: 'moyu32', name: 'MoYu32' };

class Moyu32Connection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo = MOYU32_PROTOCOL;
    readonly capabilities: SmartCubeCapabilities = {
        gyroscope: false,
        battery: true,
        facelets: true,
        hardware: true,
        reset: false
    };
    events$: Subject<SmartCubeEvent>;

    private device: BluetoothDevice;
    private readChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private writeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private encrypter: Moyu32Encrypter | null = null;
    private prevCubie = new CubieCube();
    private curCubie = new CubieCube();
    private latestFacelet = SOLVED_FACELET;
    private deviceTime = 0;
    private deviceTimeOffset = 0;
    private moveCnt = -1;
    private prevMoveCnt = -1;
    // A requested MY22 snapshot may overtake its turn notification. Keep the
    // state counter separate from the last turn emitted to subscribers.
    private stateMoveCnt = -1;
    private lastBatteryLevel: number | null = null;
    private forceNextBatteryEmission = false;
    private readonly cubeSize: 2 | 3;
    private batteryInterval: ReturnType<typeof setInterval> | null = null;

    constructor(device: BluetoothDevice, mac: string) {
        this.device = device;
        this.deviceName = device.name || 'WCU_MY3';
        this.cubeSize = this.deviceName.startsWith('WCU_MY22_') ? 2 : 3;
        this.deviceMAC = mac;
        this.events$ = new Subject<SmartCubeEvent>();
    }

    private sendRequest(req: number[]): Promise<void> {
        if (!this.writeChrct) return Promise.resolve();
        const encoded = this.encrypter ? this.encrypter.encrypt(req.slice()) : req;
        return writeGattCharacteristicValue(this.writeChrct, new Uint8Array(encoded).buffer).then(() => {});
    }

    private sendSimpleRequest(opcode: number): Promise<void> {
        const req = new Array(20).fill(0);
        req[0] = opcode;
        return this.sendRequest(req);
    }

    private onStateChanged = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value || !this.encrypter) return;
        this.parseData(value);
    };

    private emitBatteryLevel(rawLevel: number, timestamp = now()): void {
        if (!Number.isFinite(rawLevel)) {
            return;
        }
        const batteryLevel = Math.min(100, Math.max(0, Math.round(rawLevel)));
        const forceEmission = this.forceNextBatteryEmission;
        this.forceNextBatteryEmission = false;
        if (!forceEmission && this.lastBatteryLevel === batteryLevel) {
            return;
        }
        this.lastBatteryLevel = batteryLevel;
        this.events$.next({
            timestamp,
            type: 'BATTERY',
            batteryLevel,
        });
    }

    private pollBattery = (): void => {
        void this.sendSimpleRequest(164);
    };

    private parseData(value: DataView): void {
        const timestamp = now();
        const raw: number[] = [];
        for (let i = 0; i < value.byteLength; i++) {
            raw[i] = value.getUint8(i);
        }
        const decoded = this.encrypter ? this.encrypter.decrypt(raw) : raw;

        if ((decoded[0] | 0) === 171) {
            if (!this.capabilities.gyroscope) {
                this.capabilities.gyroscope = true;
            }
            this.parseGyroData(decoded, timestamp);
            return;
        }

        const bits = decoded.map(b => ((b + 256) & 0xFF).toString(2).padStart(8, '0')).join('');
        const msgType = parseInt(bits.slice(0, 8), 2);

        if (msgType === 161) { // Hardware info
            let devName = '';
            for (let i = 0; i < 8; i++) {
                devName += String.fromCharCode(parseInt(bits.slice(8 + i * 8, 16 + i * 8), 2));
            }
            const hardwareVersion = parseInt(bits.slice(88, 96), 2) + "." + parseInt(bits.slice(96, 104), 2);
            const softwareVersion = parseInt(bits.slice(72, 80), 2) + "." + parseInt(bits.slice(80, 88), 2);

            this.events$.next({
                timestamp,
                type: "HARDWARE",
                hardwareName: devName.trim(),
                softwareVersion,
                hardwareVersion,
                gyroSupported: this.capabilities.gyroscope
            });
        } else if (msgType === 163) { // Facelets state
            // MY22 packs four stickers per face (72 bits), followed by the move counter.
            const stateEnd = this.cubeSize === 2 ? 80 : 152;
            const seq = parseInt(bits.slice(stateEnd, stateEnd + 8), 2);
            const facelets = parseFacelet(bits.slice(8, stateEnd), this.cubeSize);
            if (this.cubeSize === 2) {
                const cubie = parse2x2Facelets(facelets);
                if (!cubie) return;
                this.prevCubie = cubie;
            } else {
                this.prevCubie.fromFacelet(facelets);
            }
            this.latestFacelet = facelets;
            this.moveCnt = seq;
            this.stateMoveCnt = seq;
            if (this.cubeSize === 3 || this.prevMoveCnt === -1) this.prevMoveCnt = seq;

            this.events$.next({
                timestamp,
                type: "FACELETS",
                source: "device",
                serial: seq,
                facelets: this.latestFacelet
            });
        } else if (msgType === 164) { // Battery
            this.emitBatteryLevel(parseInt(bits.slice(8, 16), 2), timestamp);
        } else if (msgType === 165) { // Move
            const history = decodeMoyuMoveHistory(bits, this.cubeSize);
            if (!history) return;
            this.moveCnt = history.sequence;
            if (this.moveCnt === this.prevMoveCnt || this.prevMoveCnt === -1) return;

            // MY22: 0/1 = F/F', 2/3 = U/U', 4/5 = R/R'.
            // Confirmed by a capture of the known sequence R R' U U' F F'.
            const faces = this.cubeSize === 2 ? 'FUR' : 'FBUDLR';
            const rawDelta = (this.moveCnt - this.prevMoveCnt) & 0xff;
            // Ignore old/repeated telemetry rather than replaying almost a
            // full counter cycle after an out-of-order notification.
            if (this.cubeSize === 2 && rawDelta >= 128) return;
            const prevMoves = history.codes.map(m => faces.charAt(m >> 1) + " '".charAt(m & 1));
            const timeOffs = history.timeOffsets;
            const invalidMove = history.codes.some((m, i) =>
                (this.cubeSize === 3 || i < Math.min(rawDelta, history.codes.length)) && m >= faces.length * 2
            );

            if (!invalidMove) {
                if (rawDelta > prevMoves.length) {
                    console.warn('[Moyu32] lost move events', rawDelta - prevMoves.length);
                }
                const moveDiff = Math.min(rawDelta, prevMoves.length);
                this.prevMoveCnt = this.moveCnt;

                let calcTs = this.deviceTime + this.deviceTimeOffset;
                for (let i = moveDiff - 1; i >= 0; i--) {
                    calcTs += timeOffs[i];
                }
                if (!this.deviceTime || Math.abs(timestamp - calcTs) > 2000) {
                    this.deviceTime += timestamp - calcTs;
                }

                for (let i = moveDiff - 1; i >= 0; i--) {
                    const moveNotation = prevMoves[i].trim();
                    const m = "URFDLB".indexOf(moveNotation[0]) * 3 + " 2'".indexOf(moveNotation[1] || ' ');
                    const serial = (history.sequence - i) & 0xff;
                    const stateDelta = (serial - this.stateMoveCnt) & 0xff;
                    const applyToState = this.cubeSize === 3 || (stateDelta > 0 && stateDelta < 128);
                    if (applyToState) {
                        CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m], this.curCubie);
                        const tmp = this.curCubie;
                        this.curCubie = this.prevCubie;
                        this.prevCubie = tmp;
                        this.stateMoveCnt = serial;
                    }
                    this.deviceTime += timeOffs[i];

                    const face = Math.floor(m / 3);
                    const direction = m % 3;

                    this.events$.next({
                        timestamp,
                        type: "MOVE",
                        serial,
                        face,
                        direction,
                        move: moveNotation,
                        localTimestamp: i === 0 ? timestamp : null,
                        cubeTimestamp: this.deviceTime
                    });

                    // Older turns are still emitted with their timing, but a
                    // newer snapshot must not have those turns applied twice
                    // or be labelled with an older turn's counter.
                    if (this.stateMoveCnt === serial) {
                        this.events$.next({
                            timestamp,
                            type: "FACELETS",
                            source: "moves",
                            serial,
                            facelets: this.cubeSize === 2 ? to2x2Facelets(this.prevCubie) : this.prevCubie.toFaceCube()
                        });
                    }
                }
                this.deviceTimeOffset = timestamp - this.deviceTime;
            }
        }
    }

    private parseGyroData(decoded: number[], timestamp: number): void {
        const dv = new DataView(Uint8Array.from(decoded).buffer);
        const scale = 1073741824; // 2^30
        let w = dv.getInt32(1, true) / scale;
        let x = dv.getInt32(5, true) / scale;
        let y = dv.getInt32(9, true) / scale;
        let z = dv.getInt32(13, true) / scale;

        const len = Math.hypot(w, x, y, z);
        if (len > 0) {
            w /= len;
            x /= len;
            y /= len;
            z /= len;
        }

        this.events$.next({
            timestamp,
            type: "GYRO",
            quaternion: { x, y, z, w }
        });
    }

    private onDisconnect = (): void => {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.lastBatteryLevel = null;
        this.forceNextBatteryEmission = false;
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
    };

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
        const gatt = await this.device.gatt!.connect();
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        const chrcts = await service.getCharacteristics();
        this.readChrct = findCharacteristic(chrcts, CHRT_UUID_READ);
        this.writeChrct = findCharacteristic(chrcts, CHRT_UUID_WRITE);

        if (!this.readChrct || !this.writeChrct) {
            throw new Error(
                !this.readChrct
                    ? '[Moyu32] Cannot find required characteristics'
                    : '[Moyu32] Cannot find write characteristic'
            );
        }

        this.readChrct.addEventListener('characteristicvaluechanged', this.onStateChanged);
        await this.readChrct.startNotifications();

        // Initialize encryption with MAC
        const macBytes = this.deviceMAC.split(/[:-\s]+/).map(c => parseInt(c, 16));
        this.encrypter = new Moyu32Encrypter(macBytes);

        await this.sendSimpleRequest(161); // Request cube info
        await this.sendSimpleRequest(163); // Request cube status (facelets)
        await this.sendSimpleRequest(164); // Request battery level

        // Some MoYu32 variants require an extra request burst before
        // gyro enable + steady-state status updates begin.
        await this.sendSimpleRequest(161);
        await this.sendSimpleRequest(163);
        await this.sendSimpleRequest(164);

        this.batteryInterval = setInterval(this.pollBattery, 60_000);
        await this.sendRequest(Array.from(ENABLE_GYRO_PAYLOAD));
        await this.sendSimpleRequest(163); // Refresh cube status after enabling gyro notifications
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        switch (command.type) {
            case "REQUEST_HARDWARE":
                await this.sendSimpleRequest(161);
                break;
            case "REQUEST_FACELETS":
                await this.sendSimpleRequest(163);
                break;
            case "REQUEST_BATTERY":
                this.forceNextBatteryEmission = true;
                await this.sendSimpleRequest(164);
                break;
        }
    }

    async disconnect(): Promise<void> {
        if (this.readChrct) {
            this.readChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
            await this.readChrct.stopNotifications().catch(() => {});
            this.readChrct = null;
        }
        this.lastBatteryLevel = null;
        this.forceNextBatteryEmission = false;
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
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

async function connectMoyu32Device(
    device: BluetoothDevice,
    macProvider?: MacAddressProvider,
    context?: AttachmentContext
): Promise<SmartCubeConnection> {
    let mac = parseMoyu32MacFromMf(context?.advertisementManufacturerData ?? null);
    mac = mac || getCachedMacForDevice(device);
    if (!mac && macProvider) {
        const r = await macProvider(device, false);
        if (r) {
            mac = r;
        }
    }

    if (!mac) {
        const mfData = await waitForAdvertisements(device, context?.enableAddressSearch ? 8000 : 5000);
        mac = parseMoyu32MacFromMf(mfData);
    }

    if (!mac && context?.enableAddressSearch) {
        const candidates = buildMoyu32MacCandidatesFromName(device.name);
        const timeoutMs = 2000;
        for (let i = 0; i < candidates.length; i++) {
            if (context.signal?.aborted) {
                break;
            }
            context.onStatus?.(`Testing address (${i + 1}/${candidates.length})…`);
            try {
                if (
                    await probeMoyu32Mac(device, candidates[i]!, {
                        timeoutMs,
                        signal: context.signal,
                    })
                ) {
                    mac = candidates[i]!;
                    break;
                }
            } catch {
                /* try next */
            }
        }
    }

    if (!mac && macProvider) {
        const r = await macProvider(device, true);
        if (r) {
            mac = r;
        }
    }

    if (!mac) {
        throw new Error('Unable to determine MoYu32 cube MAC address');
    }

    const conn = new Moyu32Connection(device, mac);
    await conn.init();
    return conn;
}

const moyu32Protocol: SmartCubeProtocol = {
    nameFilters: [{ namePrefix: '^S' }, { namePrefix: 'WCU_' }, { namePrefix: 'WCU_MY3' }],
    optionalServices: [SERVICE_UUID],

    matchesDevice(device: BluetoothDevice): boolean {
        const name = device.name || '';
        return name.startsWith('^S') || name.startsWith('WCU_') || name.startsWith('WCU_MY3');
    },

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(SERVICE_UUID)) ? 110 : 0;
    },

    connect: connectMoyu32Device
};

registerProtocol(moyu32Protocol);

export { moyu32Protocol };
