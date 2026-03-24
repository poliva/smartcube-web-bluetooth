
/** Context passed after GATT discovery so sessions can reuse known profile data. */
export interface AttachmentContext {
    /** Primary service UUIDs (normalized 128-bit uppercase) seen on this connection. */
    serviceUuids: ReadonlySet<string>;
    /** Manufacturer data from a pre-connect advertisement pass, if any. */
    advertisementManufacturerData?: BluetoothManufacturerData | null;
    /** Longer advertisement / resolution attempts for MAC (QiYi / MoYu32). */
    enableAddressSearch?: boolean;
    onStatus?: (message: string) => void;
    signal?: AbortSignal;
}

export type DeviceSelectionMode = 'filtered' | 'any';

export interface ConnectSmartCubeOptions {
    macAddressProvider?: import('../types').MacAddressProvider;
    /** `filtered`: name/manufacturer filters. `any`: accept all BLE devices (GATT profile picks the driver). */
    deviceSelection?: DeviceSelectionMode;
    /**
     * When set with `deviceSelection: 'filtered'`, adds exact-name and known-alias scan filters
     * (helps reconnect when the cube uses a non-prefix-stable advertised name).
     */
    deviceName?: string;
    /** Aborts long-running steps (e.g. MAC candidate probing). */
    signal?: AbortSignal;
    /** Called with short status messages during resolution (e.g. MAC search). */
    onStatus?: (message: string) => void;
    /**
     * When true, if advertisement and name hints fail for QiYi / MoYu32, try a bounded set of MAC candidates
     * derived from the device name (slow; default false).
     */
    enableAddressSearch?: boolean;
}
