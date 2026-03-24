
import type { AttachmentContext } from './attachment/types';
import { SmartCubeConnection, MacAddressProvider } from './types';

/** Single OR branch for `requestDevice` (`namePrefix`, exact `name`, or both via multiple entries). */
export type SmartCubeNameFilter =
    | { namePrefix: string }
    | { name: string };

interface SmartCubeProtocol {
    nameFilters: SmartCubeNameFilter[];
    optionalServices: string[];
    optionalManufacturerData?: number[];
    matchesDevice(device: BluetoothDevice): boolean;
    /**
     * Higher scores win when choosing a driver from primary service UUIDs.
     * Use 0 when this profile does not match the GATT snapshot.
     */
    gattAffinity(serviceUuids: ReadonlySet<string>, device: BluetoothDevice): number;
    connect(
        device: BluetoothDevice,
        macProvider?: MacAddressProvider,
        context?: AttachmentContext
    ): Promise<SmartCubeConnection>;
}

const protocolRegistry: SmartCubeProtocol[] = [];

function registerProtocol(protocol: SmartCubeProtocol): void {
    protocolRegistry.push(protocol);
}

function getRegisteredProtocols(): SmartCubeProtocol[] {
    return protocolRegistry;
}

export type { SmartCubeProtocol };
export { registerProtocol, getRegisteredProtocols };
export type { AttachmentContext, ConnectSmartCubeOptions, DeviceSelectionMode } from './attachment/types';
