
import { now } from '../utils';

function toUuid128(uuid: string): string {
    if (/^[0-9A-Fa-f]{4}$/.exec(uuid)) {
        uuid = "0000" + uuid + "-0000-1000-8000-00805F9B34FB";
    }
    return uuid.toUpperCase();
}

function findCharacteristic(
    characteristics: BluetoothRemoteGATTCharacteristic[],
    uuid: string
): BluetoothRemoteGATTCharacteristic | null {
    const targetUuid = toUuid128(uuid);
    for (const chrct of characteristics) {
        if (toUuid128(chrct.uuid) === targetUuid) {
            return chrct;
        }
    }
    return null;
}

async function waitForAdvertisements(device: BluetoothDevice, timeoutMs = 5000): Promise<BluetoothManufacturerData | null> {
    if (typeof device.watchAdvertisements !== 'function') {
        return null;
    }
    return new Promise<BluetoothManufacturerData | null>((resolve) => {
        const abortController = new AbortController();
        const onAdvEvent = (evt: Event) => {
            device.removeEventListener('advertisementreceived', onAdvEvent);
            abortController.abort();
            resolve((evt as BluetoothAdvertisingEvent).manufacturerData);
        };
        const onAbort = () => {
            device.removeEventListener('advertisementreceived', onAdvEvent);
            abortController.abort();
            resolve(null);
        };
        device.addEventListener('advertisementreceived', onAdvEvent);
        device.watchAdvertisements({ signal: abortController.signal }).catch(onAbort);
        setTimeout(onAbort, timeoutMs);
    });
}

function extractMacFromManufacturerData(
    mfData: BluetoothManufacturerData | DataView | null,
    cicList: number[],
    reversedByteOrder = true
): string | null {
    if (!mfData) return null;

    let dataView: DataView | undefined;

    if (mfData instanceof DataView) {
        dataView = new DataView(mfData.buffer.slice(2));
    } else {
        for (const id of cicList) {
            if (mfData.has(id)) {
                dataView = mfData.get(id);
                break;
            }
        }
    }

    if (!dataView || dataView.byteLength < 6) return null;

    const mac: string[] = [];
    if (reversedByteOrder) {
        for (let i = 5; i >= 0; i--) {
            mac.push((dataView.getUint8(i) + 0x100).toString(16).slice(1));
        }
    } else {
        for (let i = dataView.byteLength - 1; i >= dataView.byteLength - 6; i--) {
            mac.push((dataView.getUint8(i) + 0x100).toString(16).slice(1));
        }
    }
    return mac.join(':');
}

export { now, findCharacteristic, waitForAdvertisements, extractMacFromManufacturerData };
