
import { Subject } from 'rxjs';
import { ModeOfOperation } from 'aes-js';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, MacAddressProvider } from '../types';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import { CubieCube } from '../cubie-cube';
import { now, findCharacteristic, waitForAdvertisements } from '../ble-utils';

const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const SERVICE_UUID = '0000fff0' + UUID_SUFFIX;
const CHRCT_UUID_CUBE = '0000fff6' + UUID_SUFFIX;

const QIYI_CIC_LIST = [0x0504];
const QIYI_KEY = [87, 177, 249, 171, 205, 90, 232, 167, 156, 185, 140, 231, 87, 140, 81, 8];

function crc16modbus(data: number[]): number {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x1) > 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
        }
    }
    return crc;
}

class QiYiEncrypter {
    private cipher: any;

    constructor() {
        this.cipher = new ModeOfOperation.ecb(new Uint8Array(QIYI_KEY));
    }

    encrypt(data: number[]): number[] {
        const result: number[] = [];
        for (let i = 0; i < data.length; i += 16) {
            const block = data.slice(i, i + 16);
            const encrypted = this.cipher.encrypt(new Uint8Array(block));
            for (let j = 0; j < 16; j++) {
                result[i + j] = encrypted[j];
            }
        }
        return result;
    }

    decrypt(data: number[]): number[] {
        const result: number[] = [];
        for (let i = 0; i < data.length; i += 16) {
            const block = data.slice(i, i + 16);
            const decrypted = this.cipher.decrypt(new Uint8Array(block));
            for (let j = 0; j < 16; j++) {
                result[i + j] = decrypted[j];
            }
        }
        return result;
    }
}

function parseFacelet(faceMsg: number[]): string {
    const ret: string[] = [];
    for (let i = 0; i < 54; i++) {
        ret.push("LRDUFB".charAt((faceMsg[i >> 1] >> ((i % 2) << 2)) & 0xf));
    }
    return ret.join("");
}

class QiYiConnection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly capabilities: SmartCubeCapabilities = {
        gyroscope: false,
        battery: true,
        facelets: true,
        hardware: false,
        reset: false
    };
    events$: Subject<SmartCubeEvent>;

    private device: BluetoothDevice;
    private cubeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private encrypter: QiYiEncrypter;
    private curCubie = new CubieCube();
    private prevCubie = new CubieCube();
    private lastTs = 0;
    private batteryLevel = 0;

    constructor(device: BluetoothDevice, mac: string) {
        this.device = device;
        this.deviceName = device.name || 'QiYi';
        this.deviceMAC = mac;
        this.events$ = new Subject<SmartCubeEvent>();
        this.encrypter = new QiYiEncrypter();
    }

    private sendMessage(content: number[]): Promise<void> {
        if (!this.cubeChrct) return Promise.reject();
        const msg = [0xfe];
        msg.push(4 + content.length);
        for (let i = 0; i < content.length; i++) {
            msg.push(content[i]);
        }
        const crc = crc16modbus(msg);
        msg.push(crc & 0xff, crc >> 8);
        const npad = (16 - msg.length % 16) % 16;
        for (let i = 0; i < npad; i++) {
            msg.push(0);
        }
        const encMsg = this.encrypter.encrypt(msg);
        return this.cubeChrct.writeValue(new Uint8Array(encMsg).buffer).then(() => {});
    }

    private sendHello(): Promise<void> {
        const macBytes = this.deviceMAC.split(/[:-\s]+/).map(c => parseInt(c, 16));
        const content = [0x00, 0x6b, 0x01, 0x00, 0x00, 0x22, 0x06, 0x00, 0x02, 0x08, 0x00];
        for (let i = 5; i >= 0; i--) {
            content.push(macBytes[i] || 0);
        }
        return this.sendMessage(content);
    }

    private onCubeEvent = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;

        const encMsg: number[] = [];
        for (let i = 0; i < value.byteLength; i++) {
            encMsg[i] = value.getUint8(i);
        }

        const msg = this.encrypter.decrypt(encMsg);
        const trimmed = msg.slice(0, msg[1]);
        if (trimmed.length < 3 || crc16modbus(trimmed) !== 0) {
            return;
        }

        this.parseCubeData(trimmed);
    };

    private parseCubeData(msg: number[]): void {
        const timestamp = now();
        if (msg[0] !== 0xfe) return;

        const opcode = msg[2];
        const ts = (msg[3] << 24 | msg[4] << 16 | msg[5] << 8 | msg[6]);

        if (opcode === 0x2) { // Hello response
            this.batteryLevel = msg[35];
            this.sendMessage(msg.slice(2, 7)).catch(() => {});
            const newFacelet = parseFacelet(msg.slice(7, 34));

            this.events$.next({
                timestamp,
                type: "FACELETS",
                facelets: newFacelet
            });

            if (this.batteryLevel > 0) {
                this.events$.next({
                    timestamp,
                    type: "BATTERY",
                    batteryLevel: this.batteryLevel
                });
            }

            this.prevCubie.fromFacelet(newFacelet);
        } else if (opcode === 0x3) { // State change (move)
            this.sendMessage(msg.slice(2, 7)).catch(() => {});

            const todoMoves: [number, number][] = [[msg[34], ts]];
            while (todoMoves.length < 10) {
                const off = 91 - 5 * todoMoves.length;
                if (off + 4 >= msg.length) break;
                const hisTs = (msg[off] << 24 | msg[off + 1] << 16 | msg[off + 2] << 8 | msg[off + 3]);
                const hisMv = msg[off + 4];
                if (hisTs <= this.lastTs) break;
                todoMoves.push([hisMv, hisTs]);
            }

            for (let i = todoMoves.length - 1; i >= 0; i--) {
                const axis = [4, 1, 3, 0, 2, 5][(todoMoves[i][0] - 1) >> 1];
                const power = [0, 2][todoMoves[i][0] & 1];
                const m = axis * 3 + power;
                const moveStr = ("URFDLB".charAt(axis) + " 2'".charAt(power)).trim();

                CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m], this.curCubie);
                const facelet = this.curCubie.toFaceCube();

                this.events$.next({
                    timestamp,
                    type: "MOVE",
                    face: axis,
                    direction: power === 0 ? 0 : 1,
                    move: moveStr,
                    localTimestamp: i === 0 ? timestamp : null,
                    cubeTimestamp: Math.trunc(todoMoves[i][1] / 1.6)
                });

                this.events$.next({
                    timestamp,
                    type: "FACELETS",
                    facelets: facelet
                });

                const tmp = this.curCubie;
                this.curCubie = this.prevCubie;
                this.prevCubie = tmp;
            }

            const newBatteryLevel = msg[35];
            if (newBatteryLevel !== this.batteryLevel) {
                this.batteryLevel = newBatteryLevel;
                this.events$.next({
                    timestamp,
                    type: "BATTERY",
                    batteryLevel: this.batteryLevel
                });
            }
        }
        this.lastTs = ts;
    }

    private onDisconnect = (): void => {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
    };

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
        const gatt = await this.device.gatt!.connect();
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        const chrcts = await service.getCharacteristics();
        this.cubeChrct = findCharacteristic(chrcts, CHRCT_UUID_CUBE);

        if (!this.cubeChrct) {
            throw new Error('[QiYi] Cannot find required characteristic');
        }

        this.cubeChrct.addEventListener('characteristicvaluechanged', this.onCubeEvent);
        await this.cubeChrct.startNotifications();
        await this.sendHello();
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (command.type === "REQUEST_FACELETS") {
            await this.sendHello();
        }
    }

    async disconnect(): Promise<void> {
        if (this.cubeChrct) {
            this.cubeChrct.removeEventListener('characteristicvaluechanged', this.onCubeEvent);
            await this.cubeChrct.stopNotifications().catch(() => {});
            this.cubeChrct = null;
        }
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}

async function connectQiYiDevice(device: BluetoothDevice, macProvider?: MacAddressProvider): Promise<SmartCubeConnection> {
    // Try to get MAC from advertisements
    const mfData = await waitForAdvertisements(device);
    let mac: string | null = null;

    if (mfData && !(mfData instanceof DataView)) {
        for (const id of QIYI_CIC_LIST) {
            if (mfData.has(id)) {
                const dataView = mfData.get(id)!;
                if (dataView.byteLength >= 6) {
                    const parts: string[] = [];
                    for (let i = 5; i >= 0; i--) {
                        parts.push((dataView.getUint8(i) + 0x100).toString(16).slice(1));
                    }
                    mac = parts.join(':');
                }
                break;
            }
        }
    } else if (mfData instanceof DataView) {
        const dataView = new DataView(mfData.buffer.slice(2));
        if (dataView.byteLength >= 6) {
            const parts: string[] = [];
            for (let i = 5; i >= 0; i--) {
                parts.push((dataView.getUint8(i) + 0x100).toString(16).slice(1));
            }
            mac = parts.join(':');
        }
    }

    if (!mac && macProvider) {
        mac = await macProvider(device, false);
    }

    // Try deriving MAC from device name as fallback
    if (!mac) {
        const name = device.name || '';
        const match = /^(QY-QYSC|XMD-TornadoV4-i)-.-([0-9A-F]{4})$/.exec(name);
        if (match) {
            mac = 'CC:A3:00:00:' + match[2].slice(0, 2) + ':' + match[2].slice(2, 4);
        }
    }

    if (!mac && macProvider) {
        mac = await macProvider(device, true);
    }

    if (!mac) {
        throw new Error('Unable to determine QiYi cube MAC address');
    }

    const conn = new QiYiConnection(device, mac);
    await conn.init();
    return conn;
}

const qiyiProtocol: SmartCubeProtocol = {
    nameFilters: [
        { namePrefix: "QY-QYSC" },
        { namePrefix: "XMD-TornadoV4-i" }
    ],
    optionalServices: [SERVICE_UUID],
    optionalManufacturerData: QIYI_CIC_LIST,

    matchesDevice(device: BluetoothDevice): boolean {
        const name = device.name || '';
        return name.startsWith('QY-QYSC') || name.startsWith('XMD-TornadoV4-i');
    },

    connect: connectQiYiDevice
};

registerProtocol(qiyiProtocol);

export { qiyiProtocol };
