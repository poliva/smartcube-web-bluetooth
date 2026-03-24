import { findCharacteristic } from '../ble-utils';
import { createMoyu32SessionCrypto } from './moyu32-session-crypto';
import { isValidMoYu32DecryptedPacket } from './packet-sanity';

const MOYU32_SVC = '0783b03e-7735-b5a0-1760-a305d2795cb0';
const MOYU32_CHR_READ = '0783b03e-7735-b5a0-1760-a305d2795cb1';
const MOYU32_CHR_WRITE = '0783b03e-7735-b5a0-1760-a305d2795cb2';

/**
 * Returns true if notifications decrypt to plausible MoYu32 payloads for this MAC.
 */
export async function probeMoyu32Mac(
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
    const service = await gatt.getPrimaryService(MOYU32_SVC);
    const chrcts = await service.getCharacteristics();
    const readChrct = findCharacteristic(chrcts, MOYU32_CHR_READ);
    const writeChrct = findCharacteristic(chrcts, MOYU32_CHR_WRITE);
    if (!readChrct || !writeChrct) {
        return false;
    }

    const crypto = createMoyu32SessionCrypto(mac);
    let samples = 0;
    let good = 0;
    let stopped = false;

    const onNotify = (ev: Event): void => {
        if (stopped) {
            return;
        }
        const t = (ev.target as BluetoothRemoteGATTCharacteristic).value;
        if (!t) {
            return;
        }
        try {
            const raw: number[] = [];
            for (let i = 0; i < t.byteLength; i++) {
                raw.push(t.getUint8(i));
            }
            const dec = crypto.decrypt(raw);
            samples++;
            if (isValidMoYu32DecryptedPacket(dec)) {
                good++;
            }
        } catch {
            samples++;
        }
    };

    readChrct.addEventListener('characteristicvaluechanged', onNotify);
    await readChrct.startNotifications();

    const sendCmd = async (cmd: number): Promise<void> => {
        const t = Array(20).fill(0);
        t[0] = cmd;
        const enc = crypto.encrypt(t);
        await writeChrct.writeValue(new Uint8Array(enc).buffer);
    };

    try {
        await sendCmd(161);
        await sendCmd(163);
        await sendCmd(164);
    } catch {
        stopped = true;
        readChrct.removeEventListener('characteristicvaluechanged', onNotify);
        await readChrct.stopNotifications().catch(() => {});
        return false;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !stopped) {
        if (options?.signal?.aborted) {
            stopped = true;
            break;
        }
        if (good >= 3) {
            stopped = true;
            break;
        }
        if (samples > 8 && good === 0) {
            break;
        }
        await new Promise((r) => setTimeout(r, 120));
    }

    stopped = true;
    readChrct.removeEventListener('characteristicvaluechanged', onNotify);
    await readChrct.stopNotifications().catch(() => {});

    return good >= 3;
}
