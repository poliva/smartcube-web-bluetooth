
import { buildRequestDeviceOptions } from './attachment/build-picker-options';
import { collectPrimaryServiceUuids } from './attachment/gatt-snapshot';
import { resolveProtocolByGatt } from './attachment/profile-rank';
import { waitForManufacturerData, setCachedMacForDevice } from './attachment/address-hints';
import type { ConnectSmartCubeOptions, DeviceSelectionMode } from './attachment/types';
import type { MacAddressProvider, SmartCubeConnection } from './types';
import { getRegisteredProtocols } from './protocol';

function isMacAddressProvider(x: unknown): x is MacAddressProvider {
    return typeof x === 'function';
}

function normalizeOptions(
    arg?: MacAddressProvider | ConnectSmartCubeOptions
): ConnectSmartCubeOptions {
    if (arg === undefined) {
        return {};
    }
    if (isMacAddressProvider(arg)) {
        return { macAddressProvider: arg };
    }
    return arg;
}

export async function connectSmartCube(
    arg?: MacAddressProvider | ConnectSmartCubeOptions
): Promise<SmartCubeConnection> {
    const opts = normalizeOptions(arg);
    const protocols = getRegisteredProtocols();

    if (protocols.length === 0) {
        throw new Error('No smartcube protocols registered');
    }

    const mode: DeviceSelectionMode = opts.deviceSelection ?? 'filtered';
    const requestOptions = buildRequestDeviceOptions(protocols, mode, {
        deviceName: opts.deviceName,
    });
    opts.onStatus?.('Select your cube…');

    const device = await navigator.bluetooth.requestDevice(requestOptions);

    opts.onStatus?.('Reading advertisements…');
    const advertisementManufacturerData = await waitForManufacturerData(
        device,
        opts.enableAddressSearch ? 12000 : 4000
    );

    opts.onStatus?.('Connecting…');
    const serviceUuids = await collectPrimaryServiceUuids(device);

    const protocol = resolveProtocolByGatt(protocols, serviceUuids, device);

    if (!protocol) {
        try {
            device.gatt?.disconnect();
        } catch {
            /* ignore */
        }
        throw new Error("Selected device doesn't match any registered smartcube protocol");
    }

    const context = {
        serviceUuids,
        advertisementManufacturerData,
        enableAddressSearch: opts.enableAddressSearch === true,
        onStatus: opts.onStatus,
        signal: opts.signal,
    };

    let conn: SmartCubeConnection;
    try {
        conn = await protocol.connect(device, opts.macAddressProvider, context);
    } catch (e) {
        try {
            device.gatt?.disconnect();
        } catch {
            /* ignore */
        }
        throw e;
    }
    if (conn.deviceMAC) {
        setCachedMacForDevice(device, conn.deviceMAC);
    }
    return conn;
}

