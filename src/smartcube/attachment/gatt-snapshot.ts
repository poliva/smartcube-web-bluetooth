import { normalizeUuid } from './normalize-uuid';

const GATT_CONNECT_TIMEOUT_MS = 30_000;
const GATT_RETRY_MAX = 2;
const GATT_RETRY_BASE_DELAY_MS = 250;

function disconnectGattSafe(gatt: BluetoothRemoteGATTServer): Promise<void> {
    return Promise.resolve(
        (gatt as unknown as { disconnect(): Promise<void> }).disconnect()
    ).catch(() => {});
}

async function delay(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

async function connectGattWithTimeout(gatt: BluetoothRemoteGATTServer, timeoutMs: number): Promise<void> {
    const sym = Symbol('gattTimeout');
    try {
        await Promise.race([
            gatt.connect(),
            new Promise<never>((_, rej) => setTimeout(() => rej(sym), timeoutMs)),
        ]);
    } catch (e) {
        if (e === sym) {
            await disconnectGattSafe(gatt);
            throw new Error('GATT connection timeout');
        }
        await disconnectGattSafe(gatt).catch(() => {});
        throw e;
    }
}

/**
 * Connect GATT (if needed) and return normalized primary service UUIDs.
 * Uses a connect timeout and limited retries on transient failures.
 */
export async function collectPrimaryServiceUuids(device: BluetoothDevice): Promise<ReadonlySet<string>> {
    const gatt = device.gatt;
    if (!gatt) {
        throw new Error('GATT unavailable on this device');
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= GATT_RETRY_MAX; attempt++) {
        try {
            await connectGattWithTimeout(gatt, GATT_CONNECT_TIMEOUT_MS);
            const services = await gatt.getPrimaryServices();
            const set = new Set<string>();
            for (const s of services) {
                set.add(normalizeUuid(s.uuid));
            }
            return set;
        } catch (e) {
            lastErr = e;
            await disconnectGattSafe(gatt);
            if (attempt < GATT_RETRY_MAX) {
                await delay(GATT_RETRY_BASE_DELAY_MS * (attempt + 1));
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
