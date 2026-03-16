
import { Subject } from 'rxjs';
import { ModeOfOperation } from 'aes-js';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, MacAddressProvider } from '../types';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import { CubieCube, SOLVED_FACELET } from '../cubie-cube';
import { now, findCharacteristic, waitForAdvertisements } from '../ble-utils';

const SERVICE_UUID = '0783b03e-7735-b5a0-1760-a305d2795cb0';
const CHRT_UUID_READ = '0783b03e-7735-b5a0-1760-a305d2795cb1';
const CHRT_UUID_WRITE = '0783b03e-7735-b5a0-1760-a305d2795cb2';

const BASE_KEY = [21, 119, 58, 92, 103, 14, 45, 31, 23, 103, 42, 19, 155, 103, 82, 87];
const BASE_IV = [17, 35, 38, 37, 134, 42, 44, 59, 85, 6, 127, 49, 126, 103, 33, 87];

// CIC range 0x0100..0xFF00
const MOYU32_CIC_LIST = Array(255).fill(undefined).map((_v: undefined, i: number) => (i + 1) << 8);

class Moyu32Encrypter {
    private key: number[];
    private iv: number[];

    constructor(macBytes: number[]) {
        this.key = BASE_KEY.slice();
        this.iv = BASE_IV.slice();
        for (let i = 0; i < 6; i++) {
            this.key[i] = (this.key[i] + macBytes[5 - i]) % 255;
            this.iv[i] = (this.iv[i] + macBytes[5 - i]) % 255;
        }
    }

    decrypt(data: number[]): number[] {
        const ret = data.slice();
        const cipher = new ModeOfOperation.ecb(new Uint8Array(this.key));
        if (ret.length > 16) {
            const offset = ret.length - 16;
            const block = cipher.decrypt(new Uint8Array(ret.slice(offset)));
            for (let i = 0; i < 16; i++) {
                ret[i + offset] = block[i] ^ (~~this.iv[i]);
            }
        }
        const block = cipher.decrypt(new Uint8Array(ret.slice(0, 16)));
        for (let i = 0; i < 16; i++) {
            ret[i] = block[i] ^ (~~this.iv[i]);
        }
        return ret;
    }

    encrypt(data: number[]): number[] {
        const ret = data.slice();
        const cipher = new ModeOfOperation.ecb(new Uint8Array(this.key));
        for (let i = 0; i < 16; i++) {
            ret[i] ^= ~~this.iv[i];
        }
        const block = cipher.encrypt(new Uint8Array(ret.slice(0, 16)));
        for (let i = 0; i < 16; i++) {
            ret[i] = block[i];
        }
        if (ret.length > 16) {
            const offset = ret.length - 16;
            for (let i = 0; i < 16; i++) {
                ret[i + offset] ^= ~~this.iv[i];
            }
            const block2 = cipher.encrypt(new Uint8Array(ret.slice(offset, offset + 16)));
            for (let i = 0; i < 16; i++) {
                ret[i + offset] = block2[i];
            }
        }
        return ret;
    }
}

function parseFacelet(faceletBits: string): string {
    const state: string[] = [];
    const faces = [2, 5, 0, 3, 4, 1]; // parse in order URFDLB instead of FBUDLR
    for (let i = 0; i < 6; i++) {
        const face = faceletBits.slice(faces[i] * 24, 24 + faces[i] * 24);
        for (let j = 0; j < 8; j++) {
            state.push("FBUDLR".charAt(parseInt(face.slice(j * 3, 3 + j * 3), 2)));
            if (j === 3) {
                state.push("FBUDLR".charAt(faces[i]));
            }
        }
    }
    return state.join('');
}

class Moyu32Connection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly capabilities: SmartCubeCapabilities = {
        gyroscope: false,
        battery: true,
        facelets: true,
        hardware: true,
        reset: false
    };
    events$: Subject<SmartCubeEvent>;

    private device: BluetoothDevice;
    private readChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private writeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private encrypter: Moyu32Encrypter | null = null;
    private prevCubie = new CubieCube();
    private curCubie = new CubieCube();
    private latestFacelet = SOLVED_FACELET;
    private deviceTime = 0;
    private deviceTimeOffset = 0;
    private moveCnt = -1;
    private prevMoveCnt = -1;
    private batteryLevel = 0;

    constructor(device: BluetoothDevice, mac: string) {
        this.device = device;
        this.deviceName = device.name || 'WCU_MY3';
        this.deviceMAC = mac;
        this.events$ = new Subject<SmartCubeEvent>();
    }

    private sendRequest(req: number[]): Promise<void> {
        if (!this.writeChrct) return Promise.resolve();
        const encoded = this.encrypter ? this.encrypter.encrypt(req.slice()) : req;
        return this.writeChrct.writeValue(new Uint8Array(encoded).buffer).then(() => {});
    }

    private sendSimpleRequest(opcode: number): Promise<void> {
        const req = new Array(20).fill(0);
        req[0] = opcode;
        return this.sendRequest(req);
    }

    private onStateChanged = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value || !this.encrypter) return;
        this.parseData(value);
    };

    private parseData(value: DataView): void {
        const timestamp = now();
        const raw: number[] = [];
        for (let i = 0; i < value.byteLength; i++) {
            raw[i] = value.getUint8(i);
        }
        const decoded = this.encrypter ? this.encrypter.decrypt(raw) : raw;
        const bits = decoded.map(b => ((b + 256) & 0xFF).toString(2).padStart(8, '0')).join('');
        const msgType = parseInt(bits.slice(0, 8), 2);

        if (msgType === 161) { // Hardware info
            let devName = '';
            for (let i = 0; i < 8; i++) {
                devName += String.fromCharCode(parseInt(bits.slice(8 + i * 8, 16 + i * 8), 2));
            }
            const hardwareVersion = parseInt(bits.slice(88, 96), 2) + "." + parseInt(bits.slice(96, 104), 2);
            const softwareVersion = parseInt(bits.slice(72, 80), 2) + "." + parseInt(bits.slice(80, 88), 2);

            this.events$.next({
                timestamp,
                type: "HARDWARE",
                hardwareName: devName.trim(),
                softwareVersion,
                hardwareVersion
            });
        } else if (msgType === 163) { // Facelets state
            if (this.prevMoveCnt === -1) {
                this.moveCnt = parseInt(bits.slice(152, 160), 2);
                this.latestFacelet = parseFacelet(bits.slice(8, 152));
                this.prevCubie.fromFacelet(this.latestFacelet);
                this.prevMoveCnt = this.moveCnt;

                this.events$.next({
                    timestamp,
                    type: "FACELETS",
                    facelets: this.latestFacelet
                });
            }
        } else if (msgType === 164) { // Battery
            this.batteryLevel = parseInt(bits.slice(8, 16), 2);
            this.events$.next({
                timestamp,
                type: "BATTERY",
                batteryLevel: this.batteryLevel
            });
        } else if (msgType === 165) { // Move
            this.moveCnt = parseInt(bits.slice(88, 96), 2);
            if (this.moveCnt === this.prevMoveCnt || this.prevMoveCnt === -1) return;

            const prevMoves: string[] = [];
            const timeOffs: number[] = [];
            let invalidMove = false;
            for (let i = 0; i < 5; i++) {
                const m = parseInt(bits.slice(96 + i * 5, 101 + i * 5), 2);
                timeOffs[i] = parseInt(bits.slice(8 + i * 16, 24 + i * 16), 2);
                prevMoves[i] = "FBUDLR".charAt(m >> 1) + " '".charAt(m & 1);
                if (m >= 12) {
                    prevMoves[i] = "U ";
                    invalidMove = true;
                }
            }

            if (!invalidMove) {
                const moveDiff = Math.min((this.moveCnt - this.prevMoveCnt) & 0xff, prevMoves.length);
                this.prevMoveCnt = this.moveCnt;

                let calcTs = this.deviceTime + this.deviceTimeOffset;
                for (let i = moveDiff - 1; i >= 0; i--) {
                    calcTs += timeOffs[i];
                }
                if (!this.deviceTime || Math.abs(timestamp - calcTs) > 2000) {
                    this.deviceTime += timestamp - calcTs;
                }

                for (let i = moveDiff - 1; i >= 0; i--) {
                    const moveNotation = prevMoves[i].trim();
                    const m = "URFDLB".indexOf(moveNotation[0]) * 3 + " 2'".indexOf(moveNotation[1] || ' ');

                    CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m], this.curCubie);
                    this.deviceTime += timeOffs[i];

                    const face = "URFDLB".indexOf(moveNotation[0]);
                    const direction = moveNotation[1] === "'" ? 1 : 0;

                    this.events$.next({
                        timestamp,
                        type: "MOVE",
                        face,
                        direction,
                        move: moveNotation,
                        localTimestamp: i === 0 ? timestamp : null,
                        cubeTimestamp: this.deviceTime
                    });

                    this.events$.next({
                        timestamp,
                        type: "FACELETS",
                        facelets: this.curCubie.toFaceCube()
                    });

                    const tmp = this.curCubie;
                    this.curCubie = this.prevCubie;
                    this.prevCubie = tmp;
                }
                this.deviceTimeOffset = timestamp - this.deviceTime;
            }
        }
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
        this.readChrct = findCharacteristic(chrcts, CHRT_UUID_READ);
        this.writeChrct = findCharacteristic(chrcts, CHRT_UUID_WRITE);

        if (!this.readChrct) {
            throw new Error('[Moyu32] Cannot find required characteristics');
        }

        this.readChrct.addEventListener('characteristicvaluechanged', this.onStateChanged);
        await this.readChrct.startNotifications();

        // Initialize encryption with MAC
        const macBytes = this.deviceMAC.split(/[:-\s]+/).map(c => parseInt(c, 16));
        this.encrypter = new Moyu32Encrypter(macBytes);

        await this.sendSimpleRequest(161); // Request cube info
        await this.sendSimpleRequest(163); // Request cube status (facelets)
        await this.sendSimpleRequest(164); // Request battery level
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        switch (command.type) {
            case "REQUEST_HARDWARE":
                await this.sendSimpleRequest(161);
                break;
            case "REQUEST_FACELETS":
                await this.sendSimpleRequest(163);
                break;
            case "REQUEST_BATTERY":
                await this.sendSimpleRequest(164);
                break;
        }
    }

    async disconnect(): Promise<void> {
        if (this.readChrct) {
            this.readChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
            await this.readChrct.stopNotifications().catch(() => {});
            this.readChrct = null;
        }
        this.writeChrct = null;
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}

async function connectMoyu32Device(device: BluetoothDevice, macProvider?: MacAddressProvider): Promise<SmartCubeConnection> {
    // Try to get MAC from advertisements
    const mfData = await waitForAdvertisements(device);
    let mac: string | null = null;

    if (mfData) {
        if (mfData instanceof DataView) {
            const dataView = new DataView(mfData.buffer.slice(2));
            if (dataView.byteLength >= 6) {
                const parts: string[] = [];
                for (let i = 0; i < 6; i++) {
                    parts.push((dataView.getUint8(dataView.byteLength - i - 1) + 0x100).toString(16).slice(1));
                }
                mac = parts.join(':');
            }
        } else {
            for (const id of MOYU32_CIC_LIST) {
                if (mfData.has(id)) {
                    const dataView = mfData.get(id)!;
                    if (dataView.byteLength >= 6) {
                        const parts: string[] = [];
                        for (let i = 0; i < 6; i++) {
                            parts.push((dataView.getUint8(dataView.byteLength - i - 1) + 0x100).toString(16).slice(1));
                        }
                        mac = parts.join(':');
                    }
                    break;
                }
            }
        }
    }

    if (!mac && macProvider) {
        mac = await macProvider(device, false);
    }

    // Try to derive MAC from device name as fallback
    if (!mac) {
        const name = device.name || '';
        const match = /^WCU_MY32_([0-9A-F]{4})$/.exec(name);
        if (match) {
            mac = 'CF:30:16:00:' + match[1].slice(0, 2) + ':' + match[1].slice(2, 4);
        }
    }

    if (!mac && macProvider) {
        mac = await macProvider(device, true);
    }

    if (!mac) {
        throw new Error('Unable to determine MoYu32 cube MAC address');
    }

    const conn = new Moyu32Connection(device, mac);
    await conn.init();
    return conn;
}

const moyu32Protocol: SmartCubeProtocol = {
    nameFilters: [
        { namePrefix: "WCU_MY3" }
    ],
    optionalServices: [SERVICE_UUID],
    optionalManufacturerData: MOYU32_CIC_LIST,

    matchesDevice(device: BluetoothDevice): boolean {
        const name = device.name || '';
        return name.startsWith('WCU_MY3');
    },

    connect: connectMoyu32Device
};

registerProtocol(moyu32Protocol);

export { moyu32Protocol };
