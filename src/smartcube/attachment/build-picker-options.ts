import type { SmartCubeProtocol } from '../protocol';
import type { DeviceSelectionMode } from './types';
import { mergeOptionalServiceUuids } from './default-optional-services';
import { extraScanFiltersForKnownDeviceName } from './device-name-scan-filters';

function mergeManufacturerCompanyIds(protocols: SmartCubeProtocol[]): number[] {
    const all = new Set<number>();
    for (const p of protocols) {
        if (p.optionalManufacturerData) {
            for (const cic of p.optionalManufacturerData) {
                all.add(cic);
            }
        }
    }
    return Array.from(all).sort((a, b) => a - b);
}

export interface BuildRequestDeviceOptionsExtras {
    deviceName?: string;
}

/**
 * Build Web Bluetooth `requestDevice` options for the given mode.
 * Manufacturer IDs are expressed as standard `filters` entries (not non-spec top-level fields).
 */
export function buildRequestDeviceOptions(
    protocols: SmartCubeProtocol[],
    mode: DeviceSelectionMode,
    extras?: BuildRequestDeviceOptionsExtras
): RequestDeviceOptions {
    const protocolServices: string[] = [];
    for (const p of protocols) {
        for (const s of p.optionalServices) {
            protocolServices.push(s);
        }
    }
    const optionalServices = mergeOptionalServiceUuids(protocolServices);

    if (mode === 'any') {
        return {
            acceptAllDevices: true,
            optionalServices,
        };
    }

    const filters: BluetoothLEScanFilter[] = [];

    for (const p of protocols) {
        for (const f of p.nameFilters) {
            filters.push(f as BluetoothLEScanFilter);
        }
    }

    for (const f of extraScanFiltersForKnownDeviceName(extras?.deviceName)) {
        filters.push(f);
    }

    const cics = mergeManufacturerCompanyIds(protocols);
    for (const companyIdentifier of cics) {
        filters.push({
            manufacturerData: [{ companyIdentifier }],
        });
    }

    return {
        filters,
        optionalServices,
    };
}
