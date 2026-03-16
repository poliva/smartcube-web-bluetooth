
import { SmartCubeConnection, MacAddressProvider } from './types';

interface SmartCubeProtocol {
    nameFilters: Array<{ namePrefix: string }>;
    optionalServices: string[];
    optionalManufacturerData?: number[];
    matchesDevice(device: BluetoothDevice): boolean;
    connect(device: BluetoothDevice, macProvider?: MacAddressProvider): Promise<SmartCubeConnection>;
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
