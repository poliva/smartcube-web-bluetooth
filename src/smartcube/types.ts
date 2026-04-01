
import { Observable } from 'rxjs';

type SmartCubeMoveEvent = {
    type: "MOVE";
    face: number;
    direction: number;
    move: string;
    localTimestamp: number | null;
    cubeTimestamp: number | null;
};

type SmartCubeFaceletsEvent = {
    type: "FACELETS";
    facelets: string;
};

type SmartCubeGyroEvent = {
    type: "GYRO";
    quaternion: { x: number; y: number; z: number; w: number };
    velocity?: { x: number; y: number; z: number };
};

type SmartCubeBatteryEvent = {
    type: "BATTERY";
    batteryLevel: number;
};

type SmartCubeProtocolInfo = {
    id: string;
    name: string;
};

type SmartCubeHardwareEvent = {
    type: "HARDWARE";
    hardwareName?: string;
    softwareVersion?: string;
    hardwareVersion?: string;
    productDate?: string;
    gyroSupported?: boolean;
};

type SmartCubeDisconnectEvent = {
    type: "DISCONNECT";
};

type SmartCubeEventMessage =
    | SmartCubeMoveEvent
    | SmartCubeFaceletsEvent
    | SmartCubeGyroEvent
    | SmartCubeBatteryEvent
    | SmartCubeHardwareEvent
    | SmartCubeDisconnectEvent;

type SmartCubeEvent = { timestamp: number } & SmartCubeEventMessage;

type SmartCubeCommand =
    | { type: "REQUEST_FACELETS" }
    | { type: "REQUEST_BATTERY" }
    | { type: "REQUEST_HARDWARE" }
    | { type: "REQUEST_RESET" };

interface SmartCubeCapabilities {
    gyroscope: boolean;
    battery: boolean;
    facelets: boolean;
    hardware: boolean;
    reset: boolean;
}

interface SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo;
    readonly capabilities: SmartCubeCapabilities;
    events$: Observable<SmartCubeEvent>;
    sendCommand(command: SmartCubeCommand): Promise<void>;
    disconnect(): Promise<void>;
}

type MacAddressProvider = (device: BluetoothDevice, isFallbackCall?: boolean) => Promise<string | null>;

export type {
    SmartCubeEvent,
    SmartCubeEventMessage,
    SmartCubeMoveEvent,
    SmartCubeFaceletsEvent,
    SmartCubeGyroEvent,
    SmartCubeBatteryEvent,
    SmartCubeProtocolInfo,
    SmartCubeHardwareEvent,
    SmartCubeDisconnectEvent,
    SmartCubeCommand,
    SmartCubeCapabilities,
    SmartCubeConnection,
    MacAddressProvider
};
