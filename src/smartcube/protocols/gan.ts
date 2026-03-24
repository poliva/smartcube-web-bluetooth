import { Subject, map } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, MacAddressProvider } from '../types';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { getCachedMacForDevice, macFromGanManufacturerData, waitForManufacturerData } from '../attachment/address-hints';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import * as def from '../../gan-cube-definitions';
import { GanGen2CubeEncrypter, GanGen3CubeEncrypter, GanGen4CubeEncrypter } from '../../gan-cube-encrypter';
import {
    BluetoothDeviceWithMAC,
    GanCubeConnection,
    GanCubeEvent,
    GanCubeClassicConnection,
    GanGen2ProtocolDriver,
    GanGen3ProtocolDriver,
    GanGen4ProtocolDriver
} from '../../gan-cube-protocol';

function ganEventToSmartEvent(event: GanCubeEvent): SmartCubeEvent {
    switch (event.type) {
        case "MOVE":
            return {
                timestamp: event.timestamp,
                type: "MOVE",
                face: event.face,
                direction: event.direction,
                move: event.move,
                localTimestamp: event.localTimestamp,
                cubeTimestamp: event.cubeTimestamp
            };
        case "FACELETS":
            return {
                timestamp: event.timestamp,
                type: "FACELETS",
                facelets: event.facelets
            };
        case "GYRO":
            return {
                timestamp: event.timestamp,
                type: "GYRO",
                quaternion: event.quaternion,
                velocity: event.velocity
            };
        case "BATTERY":
            return {
                timestamp: event.timestamp,
                type: "BATTERY",
                batteryLevel: event.batteryLevel
            };
        case "HARDWARE":
            return {
                timestamp: event.timestamp,
                type: "HARDWARE",
                hardwareName: event.hardwareName,
                softwareVersion: event.softwareVersion,
                hardwareVersion: event.hardwareVersion,
                productDate: event.productDate,
                gyroSupported: event.gyroSupported
            };
        case "DISCONNECT":
            return {
                timestamp: event.timestamp,
                type: "DISCONNECT"
            };
    }
}

class GanSmartCubeConnection implements SmartCubeConnection {
    private ganConn: GanCubeConnection;
    private deviceMac: string;
    events$: Subject<SmartCubeEvent>;

    readonly capabilities: SmartCubeCapabilities = {
        gyroscope: true,
        battery: true,
        facelets: true,
        hardware: true,
        reset: true
    };

    constructor(ganConn: GanCubeConnection, mac: string) {
        this.ganConn = ganConn;
        this.deviceMac = mac;
        this.events$ = new Subject<SmartCubeEvent>();
        ganConn.events$.pipe(
            map(ganEventToSmartEvent)
        ).subscribe({
            next: e => this.events$.next(e),
            complete: () => this.events$.complete()
        });
    }

    get deviceName(): string {
        return this.ganConn.deviceName;
    }

    get deviceMAC(): string {
        return this.deviceMac;
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        return this.ganConn.sendCubeCommand(command);
    }

    async disconnect(): Promise<void> {
        return this.ganConn.disconnect();
    }
}

async function connectGanDevice(
    device: BluetoothDevice,
    macProvider?: MacAddressProvider,
    context?: AttachmentContext
): Promise<SmartCubeConnection> {
    const bleDevice = device as BluetoothDeviceWithMAC;

    let mac: string | null = null;
    if (context?.advertisementManufacturerData) {
        mac = macFromGanManufacturerData(context.advertisementManufacturerData);
    }
    mac = mac || getCachedMacForDevice(device);
    if (!mac && macProvider) {
        const r = await macProvider(device, false);
        if (r) {
            mac = r;
        }
    }
    if (!mac) {
        const mf = await waitForManufacturerData(device, 10000);
        if (mf) {
            mac = macFromGanManufacturerData(mf);
        }
    }
    if (!mac && macProvider) {
        const r = await macProvider(device, true);
        if (r) {
            mac = r;
        }
    }

    if (!mac) {
        throw new Error('Unable to determine cube MAC address, connection is not possible!');
    }
    bleDevice.mac = mac;

    const salt = new Uint8Array(mac.split(/[:-\s]+/).map(c => parseInt(c, 16)).reverse());
    const gatt = device.gatt!;
    if (!gatt.connected) {
        await gatt.connect();
    }
    const services = await gatt.getPrimaryServices();

    let ganConn: GanCubeConnection | null = null;

    for (const service of services) {
        const serviceUUID = service.uuid.toLowerCase();
        if (serviceUUID == def.GAN_GEN2_SERVICE) {
            const commandCharacteristic = await service.getCharacteristic(def.GAN_GEN2_COMMAND_CHARACTERISTIC);
            const stateCharacteristic = await service.getCharacteristic(def.GAN_GEN2_STATE_CHARACTERISTIC);
            const key = device.name?.startsWith('AiCube') ? def.GAN_ENCRYPTION_KEYS[1] : def.GAN_ENCRYPTION_KEYS[0];
            const encrypter = new GanGen2CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
            const driver = new GanGen2ProtocolDriver();
            ganConn = await GanCubeClassicConnection.create(bleDevice, commandCharacteristic, stateCharacteristic, encrypter, driver);
            break;
        } else if (serviceUUID == def.GAN_GEN3_SERVICE) {
            const commandCharacteristic = await service.getCharacteristic(def.GAN_GEN3_COMMAND_CHARACTERISTIC);
            const stateCharacteristic = await service.getCharacteristic(def.GAN_GEN3_STATE_CHARACTERISTIC);
            const key = def.GAN_ENCRYPTION_KEYS[0];
            const encrypter = new GanGen3CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
            const driver = new GanGen3ProtocolDriver();
            ganConn = await GanCubeClassicConnection.create(bleDevice, commandCharacteristic, stateCharacteristic, encrypter, driver);
            break;
        } else if (serviceUUID == def.GAN_GEN4_SERVICE) {
            const commandCharacteristic = await service.getCharacteristic(def.GAN_GEN4_COMMAND_CHARACTERISTIC);
            const stateCharacteristic = await service.getCharacteristic(def.GAN_GEN4_STATE_CHARACTERISTIC);
            const key = def.GAN_ENCRYPTION_KEYS[0];
            const encrypter = new GanGen4CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
            const driver = new GanGen4ProtocolDriver();
            ganConn = await GanCubeClassicConnection.create(bleDevice, commandCharacteristic, stateCharacteristic, encrypter, driver);
            break;
        }
    }

    if (!ganConn) {
        throw new Error("Can't find target BLE services - wrong or unsupported cube device model");
    }

    return new GanSmartCubeConnection(ganConn, mac);
}

const ganProtocol: SmartCubeProtocol = {
    nameFilters: [
        { namePrefix: "GAN" },
        { namePrefix: "MG" },
        { namePrefix: "AiCube" }
    ],
    optionalServices: [def.GAN_GEN2_SERVICE, def.GAN_GEN3_SERVICE, def.GAN_GEN4_SERVICE],
    optionalManufacturerData: def.GAN_CIC_LIST,

    matchesDevice(device: BluetoothDevice): boolean {
        const name = device.name || '';
        return name.startsWith('GAN') || name.startsWith('MG') || name.startsWith('AiCube');
    },

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        const g2 = normalizeUuid(def.GAN_GEN2_SERVICE);
        const g3 = normalizeUuid(def.GAN_GEN3_SERVICE);
        const g4 = normalizeUuid(def.GAN_GEN4_SERVICE);
        const deviceInfo = normalizeUuid('0000180a-0000-1000-8000-00805f9b34fb');
        const bonus = serviceUuids.has(deviceInfo) ? 5 : 0;
        if (serviceUuids.has(g4)) {
            return 120 + bonus;
        }
        if (serviceUuids.has(g3)) {
            return 120 + bonus;
        }
        if (serviceUuids.has(g2)) {
            return 120 + bonus;
        }
        return 0;
    },

    connect: connectGanDevice
};

registerProtocol(ganProtocol);

export { ganProtocol };
