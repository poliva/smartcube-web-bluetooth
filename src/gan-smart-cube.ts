
import * as def from './gan-cube-definitions';
import { GanGen2CubeEncrypter, GanGen3CubeEncrypter, GanGen4CubeEncrypter } from './gan-cube-encrypter';
import { GanGen1CubeConnection } from './gan-gen1';
import { macStringToSaltOrThrow } from './gan-mac-salt';
import {
    isValidGanGen2Packet,
    isValidGanGen3Packet,
    isValidGanGen4Packet,
} from './gan-gen234-packet-validate';
import { normalizeUuid } from './smartcube/attachment/normalize-uuid';
import {
    BluetoothDeviceWithMAC,
    GanCubeConnection,
    GanCubeCommand,
    GanCubeEvent,
    GanCubeMove,
    GanCubeClassicConnection,
    GanGen2ProtocolDriver,
    GanGen3ProtocolDriver,
    GanGen4ProtocolDriver
} from './gan-cube-protocol';

/** Iterate over all known GAN cube CICs to find Manufacturer Specific Data */
function getManufacturerDataBytes(manufacturerData: BluetoothManufacturerData | DataView): DataView | undefined {
    // Workaround for Bluefy browser which may return raw DataView directly instead of Map
    if (manufacturerData instanceof DataView) {
        return new DataView(manufacturerData.buffer.slice(2, 11));
    }
    for (var id of def.GAN_CIC_LIST) {
        if (manufacturerData.has(id)) {
            return new DataView(manufacturerData.get(id)!.buffer.slice(0, 9));
        }
    }
    return;
}

/** Extract MAC from last 6 bytes of Manufacturer Specific Data */
function extractMAC(manufacturerData: BluetoothManufacturerData): string {
    var mac: Array<string> = [];
    var dataView = getManufacturerDataBytes(manufacturerData);
    if (dataView && dataView.byteLength >= 6) {
        for (let i = 1; i <= 6; i++) {
            mac.push(dataView.getUint8(dataView.byteLength - i).toString(16).toUpperCase().padStart(2, "0"));
        }
    }
    return mac.join(":");
}

/** If browser supports Web Bluetooth watchAdvertisements() API, try to retrieve MAC address automatically */
async function autoRetrieveMacAddress(device: BluetoothDevice): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
        if (typeof device.watchAdvertisements != 'function') {
            resolve(null);
        }
        var abortController = new AbortController();
        var onAdvEvent = (evt: Event) => {
            device.removeEventListener("advertisementreceived", onAdvEvent);
            abortController.abort();
            var mac = extractMAC((evt as BluetoothAdvertisingEvent).manufacturerData);
            resolve(mac || null);
        };
        var onAbort = () => {
            device.removeEventListener("advertisementreceived", onAdvEvent);
            abortController.abort();
            resolve(null);
        };
        device.addEventListener("advertisementreceived", onAdvEvent);
        device.watchAdvertisements({ signal: abortController.signal }).catch(onAbort);
        setTimeout(onAbort, 5000);
    });
}

function hasGanGen1Profile(serviceUuids: ReadonlySet<string>): boolean {
    const primary = normalizeUuid(def.GAN_GEN1_PRIMARY_SERVICE);
    const deviceInfo = normalizeUuid(def.GAN_GEN1_DEVICE_INFO_SERVICE);
    return serviceUuids.has(primary) && serviceUuids.has(deviceInfo);
}

/**
 * Type representing function interface to implement custom MAC address provider
 * @param device Current BluetoothDevice selected by user.
 * @param isFallbackCall Flag indicating this is final and last resort call for MAC address.
 *                       If this flag is not set, custom provider can return null instead of MAC,
 *                       in such case library will try to read MAC automatically.
 */
type MacAddressProvider = (device: BluetoothDevice, isFallbackCall?: boolean) => Promise<string | null>;

/**
 * Initiate new connection with the GAN Smart Cube device
 * @param customMacAddressProvider Optional custom provider for cube MAC address
 * @returns Object representing connection API and state
 */
async function connectGanCube(customMacAddressProvider?: MacAddressProvider): Promise<GanCubeConnection> {

    // Request user for the bluetooth device (popup selection dialog)
    const nameFilters: BluetoothLEScanFilter[] = [
        { namePrefix: "GAN" },
        { namePrefix: "MG" },
        { namePrefix: "AiCube" },
    ];
    const cicFilters: BluetoothLEScanFilter[] = def.GAN_CIC_LIST.map((companyIdentifier) => ({
        manufacturerData: [{ companyIdentifier }],
    }));
    var device: BluetoothDeviceWithMAC = await navigator.bluetooth.requestDevice(
        {
            filters: [...nameFilters, ...cicFilters],
            optionalServices: [
                def.GAN_GEN1_PRIMARY_SERVICE,
                def.GAN_GEN1_DEVICE_INFO_SERVICE,
                def.GAN_GEN2_SERVICE,
                def.GAN_GEN3_SERVICE,
                def.GAN_GEN4_SERVICE,
                "0000180a-0000-1000-8000-00805f9b34fb",
                "00001800-0000-1000-8000-00805f9b34fb",
            ],
        }
    );

    // Connect to GATT and get primary services
    var gatt = await device.gatt!.connect();
    var services = await gatt.getPrimaryServices();
    const serviceUuidSet = new Set(services.map((s) => normalizeUuid(s.uuid)));

    if (hasGanGen1Profile(serviceUuidSet)) {
        return GanGen1CubeConnection.create(device);
    }

    // Retrieve cube MAC address needed for key salting
    var mac = customMacAddressProvider && await customMacAddressProvider(device, false)
        || await autoRetrieveMacAddress(device)
        || customMacAddressProvider && await customMacAddressProvider(device, true);

    if (!mac)
        throw new Error('Unable to determine cube MAC address, connection is not possible!');
    device.mac = mac;

    // Create encryption salt from MAC address bytes placed in reverse order
    var salt = macStringToSaltOrThrow(mac);

    const g2 = normalizeUuid(def.GAN_GEN2_SERVICE);
    const g3 = normalizeUuid(def.GAN_GEN3_SERVICE);
    const g4 = normalizeUuid(def.GAN_GEN4_SERVICE);
    type Pick = 'g2' | 'g3' | 'g4' | null;
    let pick: Pick = null;
    if (serviceUuidSet.has(g2)) pick = 'g2';
    else if (serviceUuidSet.has(g3)) pick = 'g3';
    else if (serviceUuidSet.has(g4)) pick = 'g4';

    var conn: GanCubeConnection | null = null;

    // Resolve type of connected cube device and setup appropriate encryption / protocol driver
    if (pick === 'g2') {
        const service = await gatt.getPrimaryService(def.GAN_GEN2_SERVICE);
        let commandCharacteristic = await service.getCharacteristic(def.GAN_GEN2_COMMAND_CHARACTERISTIC);
        let stateCharacteristic = await service.getCharacteristic(def.GAN_GEN2_STATE_CHARACTERISTIC);
        let key = device.name?.startsWith('AiCube') ? def.GAN_ENCRYPTION_KEYS[1] : def.GAN_ENCRYPTION_KEYS[0];
        let encrypter = new GanGen2CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
        let driver = new GanGen2ProtocolDriver();
        conn = await GanCubeClassicConnection.create(device, commandCharacteristic, stateCharacteristic, encrypter, driver, {
            validateDecrypted: isValidGanGen2Packet,
        });
    } else if (pick === 'g3') {
        const service = await gatt.getPrimaryService(def.GAN_GEN3_SERVICE);
        let commandCharacteristic = await service.getCharacteristic(def.GAN_GEN3_COMMAND_CHARACTERISTIC);
        let stateCharacteristic = await service.getCharacteristic(def.GAN_GEN3_STATE_CHARACTERISTIC);
        let key = def.GAN_ENCRYPTION_KEYS[0];
        let encrypter = new GanGen3CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
        let driver = new GanGen3ProtocolDriver();
        conn = await GanCubeClassicConnection.create(device, commandCharacteristic, stateCharacteristic, encrypter, driver, {
            validateDecrypted: isValidGanGen3Packet,
        });
    } else if (pick === 'g4') {
        const service = await gatt.getPrimaryService(def.GAN_GEN4_SERVICE);
        let commandCharacteristic = await service.getCharacteristic(def.GAN_GEN4_COMMAND_CHARACTERISTIC);
        let stateCharacteristic = await service.getCharacteristic(def.GAN_GEN4_STATE_CHARACTERISTIC);
        let key = def.GAN_ENCRYPTION_KEYS[0];
        let encrypter = new GanGen4CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
        let driver = new GanGen4ProtocolDriver();
        conn = await GanCubeClassicConnection.create(device, commandCharacteristic, stateCharacteristic, encrypter, driver, {
            validateDecrypted: isValidGanGen4Packet,
        });
    }

    if (!conn)
        throw new Error("Can't find target BLE services - wrong or unsupported cube device model");

    return conn;

}

export type {
    MacAddressProvider,
    GanCubeConnection,
    GanCubeCommand,
    GanCubeEvent,
    GanCubeMove
};

export {
    connectGanCube
};
