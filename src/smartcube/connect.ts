
import { SmartCubeConnection, MacAddressProvider } from './types';
import { getRegisteredProtocols } from './protocol';

async function connectSmartCube(customMacAddressProvider?: MacAddressProvider): Promise<SmartCubeConnection> {
    const protocols = getRegisteredProtocols();

    if (protocols.length === 0) {
        throw new Error('No smartcube protocols registered');
    }

    const allFilters: BluetoothLEScanFilter[] = [];
    const allServices = new Set<string>();
    const allCICs = new Set<number>();

    for (const protocol of protocols) {
        for (const filter of protocol.nameFilters) {
            allFilters.push(filter);
        }
        for (const service of protocol.optionalServices) {
            allServices.add(service);
        }
        if (protocol.optionalManufacturerData) {
            for (const cic of protocol.optionalManufacturerData) {
                allCICs.add(cic);
            }
        }
    }

    const requestOptions: RequestDeviceOptions = {
        filters: allFilters,
        optionalServices: Array.from(allServices),
    };

    if (allCICs.size > 0) {
        (requestOptions as any).optionalManufacturerData = Array.from(allCICs);
    }

    const device = await navigator.bluetooth.requestDevice(requestOptions);

    for (const protocol of protocols) {
        if (protocol.matchesDevice(device)) {
            return protocol.connect(device, customMacAddressProvider);
        }
    }

    throw new Error("Selected device doesn't match any registered smartcube protocol");
}

export { connectSmartCube };
