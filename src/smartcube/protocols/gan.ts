
import { Subject, map } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, MacAddressProvider } from '../types';
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

function getManufacturerDataBytes(manufacturerData: BluetoothManufacturerData | DataView): DataView | undefined {
    if (manufacturerData instanceof DataView) {
        return new DataView(manufacturerData.buffer.slice(2, 11));
    }
    for (const id of def.GAN_CIC_LIST) {
        if (manufacturerData.has(id)) {
            return new DataView(manufacturerData.get(id)!.buffer.slice(0, 9));
        }
    }
    return;
}

function extractMAC(manufacturerData: BluetoothManufacturerData): string {
    const mac: string[] = [];
    const dataView = getManufacturerDataBytes(manufacturerData);
    if (dataView && dataView.byteLength >= 6) {
        for (let i = 1; i <= 6; i++) {
            mac.push(dataView.getUint8(dataView.byteLength - i).toString(16).toUpperCase().padStart(2, "0"));
        }
    }
    return mac.join(":");
}

async function autoRetrieveMacAddress(device: BluetoothDevice): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
        if (typeof device.watchAdvertisements != 'function') {
            resolve(null);
        }
        const abortController = new AbortController();
        const onAdvEvent = (evt: Event) => {
            device.removeEventListener("advertisementreceived", onAdvEvent);
            abortController.abort();
            const mac = extractMAC((evt as BluetoothAdvertisingEvent).manufacturerData);
            resolve(mac || null);
        };
        const onAbort = () => {
            device.removeEventListener("advertisementreceived", onAdvEvent);
            abortController.abort();
            resolve(null);
        };
        device.addEventListener("advertisementreceived", onAdvEvent);
        device.watchAdvertisements({ signal: abortController.signal }).catch(onAbort);
        setTimeout(onAbort, 10000);
    });
}

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

async function connectGanDevice(device: BluetoothDevice, macProvider?: MacAddressProvider): Promise<SmartCubeConnection> {
    const bleDevice = device as BluetoothDeviceWithMAC;

    const mac = (macProvider && await macProvider(device, false))
        || await autoRetrieveMacAddress(device)
        || (macProvider && await macProvider(device, true));

    if (!mac) {
        throw new Error('Unable to determine cube MAC address, connection is not possible!');
    }
    bleDevice.mac = mac;

    const salt = new Uint8Array(mac.split(/[:-\s]+/).map(c => parseInt(c, 16)).reverse());
    const gatt = await device.gatt!.connect();
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

    connect: connectGanDevice
};

registerProtocol(ganProtocol);

export { ganProtocol };
