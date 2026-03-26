
// Register all protocols (side-effect imports)
import './protocols/gan';
import './protocols/giiker';
import './protocols/gocube';
import './protocols/moyu-mhc';
import './protocols/moyu32';
import './protocols/qiyi';

// Re-export types and connect function
export type {
    SmartCubeEvent,
    SmartCubeEventMessage,
    SmartCubeMoveEvent,
    SmartCubeFaceletsEvent,
    SmartCubeGyroEvent,
    SmartCubeBatteryEvent,
    SmartCubeHardwareEvent,
    SmartCubeDisconnectEvent,
    SmartCubeCommand,
    SmartCubeCapabilities,
    SmartCubeConnection
} from './types';

export { connectSmartCube } from './connect';
export { removeCachedMacForDevice } from './attachment/address-hints';

export type {
    SmartCubeProtocol,
    SmartCubeNameFilter,
    AttachmentContext,
    ConnectSmartCubeOptions,
    DeviceSelectionMode
} from './protocol';
export { registerProtocol, getRegisteredProtocols } from './protocol';
