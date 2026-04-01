import { AES } from 'aes-js';
import { decompressFromEncodedURIComponent } from 'lz-string';
import { Subject } from 'rxjs';
import * as def from './gan-cube-definitions';
import type { GanCubeCommand, GanCubeConnection, GanCubeEvent } from './gan-cube-protocol';
import { now } from './utils';

type AesBlockCipher = AES & { decrypt(block: number[]): number[] };

class GanGen1Aes {
    private readonly aes: AesBlockCipher;

    constructor(keyBytes: Uint8Array) {
        this.aes = new AES([...keyBytes]) as AesBlockCipher;
    }

    decrypt(data: Uint8Array): Uint8Array {
        if (data.length < 16) throw new Error('Invalid data length');
        const t = Array.from(data);
        if (t.length > 16) {
            const i = t.length - 16;
            const n = this.aes.decrypt(t.slice(i, i + 16));
            for (let r = 0; r < 16; r++) t[r + i] = n[r]!;
        }
        const s = this.aes.decrypt(t.slice(0, 16));
        for (let r = 0; r < 16; r++) t[r] = s[r]!;
        return new Uint8Array(t);
    }
}

function deriveGen1Key(fwVersion: number, hw: DataView): Uint8Array | null {
    const idx = (fwVersion >> 8) & 255;
    const compressed = def.GAN_GEN1_COMPRESSED_KEYS[idx] ?? def.GAN_GEN1_COMPRESSED_KEYS[0];
    if (!compressed) return null;
    const json = decompressFromEncodedURIComponent(compressed);
    if (!json) return null;
    let arr: number[];
    try {
        arr = JSON.parse(json) as number[];
    } catch {
        return null;
    }
    if (!Array.isArray(arr) || arr.length < 6) return null;
    if (hw.byteLength < 6) return null;
    for (let s = 0; s < 6; s++) {
        arr[s] = (arr[s]! + hw.getUint8(5 - s)!) & 255;
    }
    if (arr.length < 16) return null;
    return new Uint8Array(arr.slice(0, 16));
}

function gyroFromState(t: Uint8Array): { x: number; y: number; z: number; w: number } | null {
    if (t.length < 6) return null;
    let x0 = t[0]! | (t[1]! << 8);
    let x1 = t[2]! | (t[3]! << 8);
    let x2 = t[4]! | (t[5]! << 8);
    if (x0 > 32767) x0 -= 65536;
    if (x1 > 32767) x1 -= 65536;
    if (x2 > 32767) x2 -= 65536;
    const r = x0 / 16384;
    const s = x1 / 16384;
    const a = x2 / 16384;
    const o = 1 - r * r - s * s - a * a;
    return { x: r, y: a, z: -s, w: o > 0 ? Math.sqrt(o) : 0 };
}

function parseGen1Facelets(t: Uint8Array): string {
    const out: string[] = [];
    for (let i = 0; i < t.length - 2; i += 3) {
        const n = (t[1 ^ i]! << 16) | (t[(i + 1) ^ 1]! << 8) | t[(i + 2) ^ 1]!;
        for (let r = 21; r >= 0; r -= 3) {
            out.push('URFDLB'.charAt((n >> r) & 7));
            if (r === 12) out.push('URFDLB'.charAt(i / 3));
        }
    }
    return out.join('');
}

/** Placeholder cubelets state when gen1 only supplies a facelet string. */
const GEN1_SOLVED_STATE = {
    CP: [0, 1, 2, 3, 4, 5, 6, 7],
    CO: [0, 0, 0, 0, 0, 0, 0, 0],
    EP: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    EO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

/**
 * GAN 356i “API v1”: primary service `fff0` + Device Information for key derivation.
 */
export class GanGen1CubeConnection implements GanCubeConnection {
    readonly deviceMAC = '';

    readonly events$: Subject<GanCubeEvent>;

    private readonly encrypter: GanGen1Aes;
    private readonly device: BluetoothDevice;
    private readonly chrState: BluetoothRemoteGATTCharacteristic;
    private readonly chrMoves: BluetoothRemoteGATTCharacteristic;
    private readonly chrFacelets: BluetoothRemoteGATTCharacteristic;
    private readonly chrBattery: BluetoothRemoteGATTCharacteristic;
    private readonly chrGyroNotify: BluetoothRemoteGATTCharacteristic;

    private polling = false;
    private prevMoveCnt = -1;
    private movePollTicks = 0;
    private batteryPollTicks = 0;
    private pollFailures = 0;
    private teardown = false;
    private lastBatteryLevel: number | null = null;

    private readonly onGattDisconnected: () => void;

    private constructor(
        device: BluetoothDevice,
        encrypter: GanGen1Aes,
        events$: Subject<GanCubeEvent>,
        chrState: BluetoothRemoteGATTCharacteristic,
        chrMoves: BluetoothRemoteGATTCharacteristic,
        chrFacelets: BluetoothRemoteGATTCharacteristic,
        chrBattery: BluetoothRemoteGATTCharacteristic,
        chrGyroNotify: BluetoothRemoteGATTCharacteristic
    ) {
        this.device = device;
        this.encrypter = encrypter;
        this.events$ = events$;
        this.chrState = chrState;
        this.chrMoves = chrMoves;
        this.chrFacelets = chrFacelets;
        this.chrBattery = chrBattery;
        this.chrGyroNotify = chrGyroNotify;

        this.onGattDisconnected = () => void this.handleDisconnect();
        this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    }

    get deviceName(): string {
        return this.device.name || 'GAN356i v1';
    }

    static async create(device: BluetoothDevice): Promise<GanGen1CubeConnection> {
        const gatt = device.gatt;
        if (!gatt?.connected) {
            throw new Error('GATT must be connected before GAN gen1 setup');
        }

        const deviceInfo = await gatt.getPrimaryService(def.GAN_GEN1_DEVICE_INFO_SERVICE);
        const fwChar = await deviceInfo.getCharacteristic(def.GAN_GEN1_CHR_FIRMWARE);
        const hwChar = await deviceInfo.getCharacteristic(def.GAN_GEN1_CHR_HARDWARE);
        const fw = await fwChar.readValue();
        const n =
            fw.byteLength >= 3
                ? (fw.getUint8(0) << 16) | (fw.getUint8(1) << 8) | fw.getUint8(2)
                : 0;
        if (!(n > 65543 && (16776704 & n) === 65536)) {
            throw new Error(`Invalid firmware version: 0x${n.toString(16)}`);
        }
        const hwRaw = await hwChar.readValue();
        const keyArr = deriveGen1Key(n, hwRaw);
        if (!keyArr) {
            throw new Error('Invalid encryption key');
        }

        const encrypter = new GanGen1Aes(keyArr);
        const primary = await gatt.getPrimaryService(def.GAN_GEN1_PRIMARY_SERVICE);
        const chrState = await primary.getCharacteristic(def.GAN_GEN1_CHR_STATE);
        const chrMoves = await primary.getCharacteristic(def.GAN_GEN1_CHR_MOVES);
        const chrFacelets = await primary.getCharacteristic(def.GAN_GEN1_CHR_FACELETS);
        const chrBattery = await primary.getCharacteristic(def.GAN_GEN1_CHR_BATTERY);
        const chrGyroNotify = await primary.getCharacteristic(def.GAN_GEN1_CHR_GYRO_NOTIFY);

        const events$ = new Subject<GanCubeEvent>();
        const conn = new GanGen1CubeConnection(
            device,
            encrypter,
            events$,
            chrState,
            chrMoves,
            chrFacelets,
            chrBattery,
            chrGyroNotify
        );

        chrGyroNotify.addEventListener('characteristicvaluechanged', conn.onGyroNotify);
        await chrGyroNotify.startNotifications();

        await conn.readInitialState();
        await conn.readBattery();
        conn.polling = true;
        conn.schedulePoll(0);

        return conn;
    }

    private onGyroNotify = (evt: Event): void => {
        try {
            const chr = evt.target as BluetoothRemoteGATTCharacteristic;
            const e = chr.value;
            if (!e || e.byteLength < 16) return;
            const dec = this.encrypter.decrypt(new Uint8Array(e.buffer, e.byteOffset, e.byteLength));
            const q = gyroFromState(dec);
            if (q) {
                this.events$.next({ type: 'GYRO', timestamp: now(), quaternion: q });
            }
        } catch {
            /* ignore corrupt frame */
        }
    };

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
            type: 'BATTERY',
            batteryLevel,
            timestamp,
        });
    }

    private async readBattery(): Promise<void> {
        try {
            const e = await this.chrBattery.readValue();
            const t = this.encrypter.decrypt(new Uint8Array(e.buffer, e.byteOffset, e.byteLength));
            if (t.length < 8) return;
            this.emitBatteryLevel(t[7]!);
        } catch {
            /* ignore */
        }
    }

    private async readInitialState(): Promise<void> {
        try {
            const e = await this.chrFacelets.readValue();
            const t = this.encrypter.decrypt(new Uint8Array(e.buffer, e.byteOffset, e.byteLength));
            this.events$.next({
                timestamp: now(),
                type: 'FACELETS',
                serial: 0,
                facelets: parseGen1Facelets(t),
                state: {
                    CP: [...GEN1_SOLVED_STATE.CP],
                    CO: [...GEN1_SOLVED_STATE.CO],
                    EP: [...GEN1_SOLVED_STATE.EP],
                    EO: [...GEN1_SOLVED_STATE.EO],
                },
            });
        } catch {
            /* ignore */
        }
    }

    private schedulePoll(delayMs: number): void {
        if (!this.polling || this.teardown) return;
        setTimeout(() => void this.pollLoop(), delayMs);
    }

    private async pollLoop(): Promise<void> {
        if (!this.polling || this.teardown) return;
        try {
            const e = await this.chrState.readValue();
            const t = this.encrypter.decrypt(new Uint8Array(e.buffer, e.byteOffset, e.byteLength));
            this.pollFailures = 0;
            const q = gyroFromState(t);
            if (q) {
                this.events$.next({ type: 'GYRO', timestamp: now(), quaternion: q });
            }
            const moveCnt = t[12]!;
            if (this.prevMoveCnt === -1) {
                this.prevMoveCnt = moveCnt;
            } else if (moveCnt !== this.prevMoveCnt) {
                let o = (moveCnt - this.prevMoveCnt) & 255;
                if (o > 6) o = 6;
                const moves: string[] = [];
                for (let l = 0; l < 6; l++) {
                    const u = t[13 + l]!;
                    moves.unshift('URFDLB'.charAt(~~(u / 3)) + " 2'".charAt(u % 3));
                }
                const moveData = await this.chrMoves.readValue();
                const mt = this.encrypter.decrypt(
                    new Uint8Array(moveData.buffer, moveData.byteOffset, moveData.byteLength)
                );
                const stamps: number[] = [];
                for (let r = 0; r < 9; r++) {
                    stamps.unshift(mt[2 * r + 1]! | (mt[2 * r + 2]! << 8));
                }
                const ts = now();
                for (let r = o - 1; r >= 0; r--) {
                    const d = moves[r]?.trim();
                    if (!d) continue;
                    const f = 'URFDLB'.indexOf(d[0]!);
                    const h = d.endsWith("'") ? 1 : 0;
                    this.events$.next({
                        timestamp: ts,
                        type: 'MOVE',
                        serial: (moveCnt - r) & 255,
                        face: f,
                        direction: h,
                        move: d,
                        cubeTimestamp: stamps[r] ?? null,
                        localTimestamp: ts,
                    });
                }
                this.prevMoveCnt = moveCnt;
            }
            this.movePollTicks++;
            if (this.movePollTicks >= 50) {
                this.movePollTicks = 0;
                await this.readInitialState();
            }
            this.batteryPollTicks += 30;
            if (this.batteryPollTicks >= 60_000) {
                this.batteryPollTicks = 0;
                await this.readBattery();
            }
            this.schedulePoll(30);
        } catch {
            this.pollFailures++;
            const wait = Math.min(500 * 2 ** Math.min(this.pollFailures, 4), 2000);
            this.schedulePoll(wait);
        }
    }

    private async handleDisconnect(): Promise<void> {
        if (this.teardown) return;
        this.teardown = true;
        this.polling = false;
        this.lastBatteryLevel = null;
        this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
        try {
            this.chrGyroNotify.removeEventListener('characteristicvaluechanged', this.onGyroNotify);
            await this.chrGyroNotify.stopNotifications().catch(() => {});
        } catch {
            /* ignore */
        }
        this.events$.next({ timestamp: now(), type: 'DISCONNECT' });
        this.events$.complete();
    }

    async sendCubeCommand(command: GanCubeCommand): Promise<void> {
        switch (command.type) {
            case 'REQUEST_BATTERY':
                await this.readBattery();
                break;
            case 'REQUEST_FACELETS':
                await this.readInitialState();
                break;
            default:
                break;
        }
    }

    async disconnect(): Promise<void> {
        await this.handleDisconnect();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}
