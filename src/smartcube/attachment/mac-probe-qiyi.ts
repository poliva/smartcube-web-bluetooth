import { ModeOfOperation } from 'aes-js';
import { findCharacteristic } from '../ble-utils';
import { isValidQiYiDecryptedPacket } from './packet-sanity';

const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const QIYI_SVC = '0000fff0' + UUID_SUFFIX;
const QIYI_CHR = '0000fff6' + UUID_SUFFIX;
const QIYI_KEY = [87, 177, 249, 171, 205, 90, 232, 167, 156, 185, 140, 231, 87, 140, 81, 8];

function crc16modbus(data: number[]): number {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i]!;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) > 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
        }
    }
    return crc;
}

/** Same wire as QiYiConnection.sendHello → sendMessage (wake cube for MAC validation). */
function buildEncryptedQiYiHello(mac: string): ArrayBuffer {
    const macBytes = mac.split(/[:-\s]+/).map((x) => parseInt(x, 16));
    const content = [0x00, 0x6b, 0x01, 0x00, 0x00, 0x22, 0x06, 0x00, 0x02, 0x08, 0x00];
    for (let i = 5; i >= 0; i--) {
        content.push(macBytes[i] ?? 0);
    }
    const msg: number[] = [0xfe];
    msg.push(4 + content.length);
    for (let k = 0; k < content.length; k++) {
        msg.push(content[k]!);
    }
    const crc = crc16modbus(msg);
    msg.push(crc & 0xff, crc >> 8);
    const npad = (16 - (msg.length % 16)) % 16;
    for (let p = 0; p < npad; p++) {
        msg.push(0);
    }
    return encryptBlocks(new Uint8Array(msg));
}

function encryptBlocks(plain: Uint8Array): ArrayBuffer {
    const cipher = new ModeOfOperation.ecb(new Uint8Array(QIYI_KEY));
    const out = new Uint8Array(plain.length);
    for (let i = 0; i < plain.length; i += 16) {
        const block = cipher.encrypt(plain.subarray(i, i + 16));
        out.set(block, i);
    }
    return out.buffer;
}

function decryptBlocks(enc: ArrayBuffer | ArrayBufferView): Uint8Array {
    const view = enc instanceof ArrayBuffer ? new Uint8Array(enc) : new Uint8Array(enc.buffer, enc.byteOffset, enc.byteLength);
    const cipher = new ModeOfOperation.ecb(new Uint8Array(QIYI_KEY));
    const out = new Uint8Array(view.length);
    for (let i = 0; i < view.length; i += 16) {
        const block = cipher.decrypt(view.subarray(i, i + 16));
        out.set(block, i);
    }
    return out;
}

/**
 * Returns true if notifications decrypt to plausible QiYi payloads for this MAC.
 */
export async function probeQiYiMac(
    device: BluetoothDevice,
    mac: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<boolean> {
    const timeoutMs = options?.timeoutMs ?? 8000;
    const gatt = device.gatt;
    if (!gatt) {
        return false;
    }
    if (!gatt.connected) {
        await gatt.connect();
    }
    const service = await gatt.getPrimaryService(QIYI_SVC);
    const chrcts = await service.getCharacteristics();
    const chrct = findCharacteristic(chrcts, QIYI_CHR);
    if (!chrct) {
        return false;
    }

    let stopped = false;
    let ok = false;

    const onNotify = (ev: Event): void => {
        if (stopped) {
            return;
        }
        const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
        if (!v) {
            return;
        }
        try {
            const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
            const dec = decryptBlocks(raw);
            if (isValidQiYiDecryptedPacket(dec)) {
                ok = true;
                stopped = true;
            }
        } catch {
            /* ignore */
        }
    };

    chrct.addEventListener('characteristicvaluechanged', onNotify);
    await chrct.startNotifications();

    const wake = (): void => {
        if (stopped) {
            return;
        }
        try {
            void chrct.writeValue(buildEncryptedQiYiHello(mac));
        } catch {
            /* ignore */
        }
    };

    const iv = setInterval(wake, 100);
    wake();

    await new Promise<void>((resolve) => {
        const maxTimer = setTimeout(() => resolve(), timeoutMs);
        const poll = setInterval(() => {
            if (ok || options?.signal?.aborted) {
                clearInterval(poll);
                clearTimeout(maxTimer);
                resolve();
            }
        }, 40);
    });

    clearInterval(iv);
    stopped = true;
    chrct.removeEventListener('characteristicvaluechanged', onNotify);
    await chrct.stopNotifications().catch(() => {});

    return ok;
}
