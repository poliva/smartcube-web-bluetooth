import { describe, expect, it, vi } from 'vitest';
import { GanGen4ProtocolDriver } from '../../gan-cube-protocol';
import { GanGen4CubeEncrypter } from '../../gan-cube-encrypter';
import * as def from '../../gan-cube-definitions';
import { macStringToSaltOrThrow } from '../../gan-mac-salt';
import { to2x2Facelets } from '../../utils';
import { connectGanCube } from '../../gan-smart-cube';
import { ganProtocol } from '../../smartcube/protocols/gan';
import { installMockBluetoothFromFixture } from '../bluetooth-mock';
import type { FixtureSession } from '../fixtures';

const mac = '12:34:56:78:9a:bc';
const key = def.GAN_251_ENCRYPTION_KEY;
const cipher = () => new GanGen4CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), macStringToSaltOrThrow(mac));
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const rawConnection = { sendCommandMessage: async (_message: Uint8Array) => {}, disconnect: async () => {} };

function faceletsPacket(): Uint8Array {
    const bytes = new Uint8Array(20);
    bytes.set([0xed, 8, 0, 0]);
    // Only corners are populated. Edge bytes are deliberately invalid for a 3x3.
    for (let i = 0; i < 7; i++) {
        for (let bit = 0; bit < 3; bit++) {
            const offset = 32 + i * 3 + bit;
            bytes[offset >> 3] |= ((i >> (2 - bit)) & 1) << (7 - (offset & 7));
        }
    }
    bytes.fill(0xff, 9);
    return bytes;
}

function movePacket(serial: number, faceHot = 32, direction = 0): Uint8Array {
    const bytes = new Uint8Array(20);
    bytes.set([1, 7]);
    new DataView(bytes.buffer).setUint32(2, 1000 + serial * 100, true);
    new DataView(bytes.buffer).setUint16(6, serial, true);
    bytes[8] = (direction << 6) | faceHot;
    return bytes;
}

describe('GAN 251 UI', () => {
    it.each(['gan251ui_ABC', 'ganic251_ABC', 'GAN251Ui_ABC', 'GANic251_ABC'])('recognizes %s', name => {
        expect(def.isGan251Device(name)).toBe(true);
        expect(ganProtocol.matchesDevice({ name } as BluetoothDevice)).toBe(true);
        expect(ganProtocol.nameFilters.some(f => 'namePrefix' in f && name.startsWith(f.namePrefix))).toBe(true);
    });

    it.each(['GANi4_ABC', 'GAN12ui_ABC', undefined])('keeps other models separate (%s)', name => {
        expect(def.isGan251Device(name)).toBe(false);
    });

    it('matches a fixed salted AES command vector', () => {
        const command = new GanGen4ProtocolDriver(2).createCommandMessage({ type: 'REQUEST_FACELETS' })!;
        expect(hex(cipher().encrypt(command))).toBe('b54b697f991c2acf6a07989b05a747d63b5d9d08');
    });

    it('converts a twisted and permuted corner state to row-major facelets', () => {
        expect(to2x2Facelets([4, 1, 2, 0, 7, 5, 6, 3], [2, 0, 0, 1, 1, 0, 0, 2]))
            .toBe('UFUFRRRRFDFDDBDBLLLLUBUB');
    });

    it('ignores edge data and recovers a missing move through Gen4 history', async () => {
        const driver = new GanGen4ProtocolDriver(2);
        const states = await driver.handleStateEvent(rawConnection, faceletsPacket());
        expect(states[0]).toMatchObject({ type: 'FACELETS', facelets: 'UUUURRRRFFFFDDDDLLLLBBBB',
            state: { CP: [0, 1, 2, 3, 4, 5, 6, 7], CO: Array(8).fill(0), EP: [], EO: [] } });
        expect(await driver.handleStateEvent(rawConnection, movePacket(2))).toEqual([]);
        const history = new Uint8Array(20);
        // Serial 1, clockwise U (history face code 1); padded serial 0 is ignored.
        history.set([0xd1, 2, 1, 0x20]);
        const recovered = await driver.handleStateEvent(rawConnection, history);
        expect(recovered.map(e => e.type === 'MOVE' && e.move)).toEqual(['U', 'R']);
    });

    for (const legacy of [false, true]) {
        for (const alternate of [false, true]) {
            it(`decrypts notifications and writes commands (${legacy ? 'legacy' : 'unified'}, ${alternate ? 'alternate' : 'primary'} TX)`, async () => {
                const tx = alternate ? def.GAN_251_COMMAND_CHARACTERISTIC_ALT : def.GAN_GEN4_COMMAND_CHARACTERISTIC;
                const service = def.GAN_GEN4_SERVICE;
                const fixture: FixtureSession = {
                    format: 'smartcube-fixture', version: 1, capturedAt: '',
                    device: { name: 'ganic251_TEST', id: 'gan-251', mac },
                    protocol: { id: 'gan-gen4', name: 'GAN Gen4' }, services: [], events: [],
                    traffic: [
                        { t: 0, op: 'discover-char', service, characteristic: tx },
                        { t: 1, op: 'notify', service, characteristic: def.GAN_GEN4_STATE_CHARACTERISTIC, data: hex(cipher().encrypt(faceletsPacket())) },
                        { t: 2, op: 'notify', service, characteristic: def.GAN_GEN4_STATE_CHARACTERISTIC, data: hex(cipher().encrypt(movePacket(1))) },
                        { t: 3, op: 'write', service, characteristic: tx, data: 'b54b697f991c2acf6a07989b05a747d63b5d9d08' },
                    ],
                };
                const { device, replayer } = installMockBluetoothFromFixture(fixture, { maxAutoFlushNotifies: 0 });
                const conn = legacy ? await connectGanCube(async () => mac) : await ganProtocol.connect(device, async () => mac);
                const events: Array<{ type: string; facelets?: string; move?: string }> = [];
                conn.events$.subscribe(e => events.push(e));
                if ('sendCubeCommand' in conn) await conn.sendCubeCommand({ type: 'REQUEST_FACELETS' });
                else await conn.sendCommand({ type: 'REQUEST_FACELETS' });
                await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining([
                    expect.objectContaining({ type: 'FACELETS', facelets: 'UUUURRRRFFFFDDDDLLLLBBBB', ...(legacy ? {} : { source: 'device', serial: 0 }) }),
                    expect.objectContaining({ type: 'MOVE', face: 1, direction: 0, move: 'R', cubeTimestamp: 1100 }),
                ])));
                expect(replayer.debugCursor().index).toBe(fixture.traffic.length);
                await conn.disconnect();
            });
        }
    }
});
