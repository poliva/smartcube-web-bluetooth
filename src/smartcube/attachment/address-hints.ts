import * as ganDef from '../../gan-cube-definitions';

const STORAGE_PREFIX = 'smartcube-ble-mac:';

export function getCachedMacForDevice(device: BluetoothDevice): string | null {
    if (typeof localStorage === 'undefined') {
        return null;
    }
    try {
        return localStorage.getItem(STORAGE_PREFIX + device.id);
    } catch {
        return null;
    }
}

export function setCachedMacForDevice(device: BluetoothDevice, mac: string): void {
    if (typeof localStorage === 'undefined') {
        return;
    }
    try {
        localStorage.setItem(STORAGE_PREFIX + device.id, mac);
    } catch {
        /* ignore quota */
    }
}

function mergeManufacturerDataInto(
    acc: Map<number, DataView>,
    mf: BluetoothManufacturerData | null | undefined
): void {
    if (!mf || typeof mf.keys !== 'function') {
        return;
    }
    for (const id of mf.keys()) {
        const v = mf.get(id);
        if (v) {
            acc.set(
                id,
                new DataView(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
            );
        }
    }
}

/**
 * Wait for manufacturer data from advertisements (single shared listener).
 * Merges all packets until timeout: the first BLE advertisement often has an empty
 * manufacturerData map; MAC-bearing data appears on later frames.
 */
export async function waitForManufacturerData(
    device: BluetoothDevice,
    timeoutMs = 8000
): Promise<BluetoothManufacturerData | null> {
    if (typeof device.watchAdvertisements !== 'function') {
        return null;
    }
    const name = (device.name || '').trim();
    /** MoYu32-style names rarely expose useful MF in the picker; keep connect snappy. */
    const emptyFirstAdvExit = name.startsWith('WCU_');

    return new Promise<BluetoothManufacturerData | null>((resolve) => {
        const abortController = new AbortController();
        const merged = new Map<number, DataView>();
        let sawAdvertisement = false;
        let finished = false;

        const cleanup = (): void => {
            device.removeEventListener('advertisementreceived', onAdvEvent);
            abortController.abort();
            clearTimeout(maxTimer);
        };

        const finish = (value: BluetoothManufacturerData | null): void => {
            if (finished) {
                return;
            }
            finished = true;
            cleanup();
            resolve(value);
        };

        const onAdvEvent = (evt: Event): void => {
            const adv = evt as BluetoothAdvertisingEvent;
            mergeManufacturerDataInto(merged, adv.manufacturerData ?? null);
            const isFirstAdv = !sawAdvertisement;
            sawAdvertisement = true;

            if (merged.size > 0) {
                finish(merged as unknown as BluetoothManufacturerData);
                return;
            }
            if (emptyFirstAdvExit && isFirstAdv) {
                finish(null);
            }
        };

        const maxTimer = setTimeout(() => {
            finish(merged.size > 0 ? (merged as unknown as BluetoothManufacturerData) : null);
        }, timeoutMs);

        device.addEventListener('advertisementreceived', onAdvEvent);
        device.watchAdvertisements({ signal: abortController.signal }).catch(() => {
            clearTimeout(maxTimer);
            finish(null);
        });
    });
}

/** GAN-style MAC from manufacturer data (last 6 bytes, reversed order in payload). */
export function macFromGanManufacturerData(mf: BluetoothManufacturerData | DataView): string | null {
    function getBytes(manufacturerData: BluetoothManufacturerData | DataView): DataView | undefined {
        if (manufacturerData instanceof DataView) {
            return new DataView(manufacturerData.buffer.slice(2, 11));
        }
        for (const id of ganDef.GAN_CIC_LIST) {
            if (manufacturerData.has(id)) {
                return new DataView(manufacturerData.get(id)!.buffer.slice(0, 9));
            }
        }
        return undefined;
    }
    const dataView = getBytes(mf);
    if (!dataView || dataView.byteLength < 6) {
        return null;
    }
    const mac: string[] = [];
    for (let i = 1; i <= 6; i++) {
        mac.push(dataView.getUint8(dataView.byteLength - i).toString(16).toUpperCase().padStart(2, '0'));
    }
    return mac.join(':');
}
