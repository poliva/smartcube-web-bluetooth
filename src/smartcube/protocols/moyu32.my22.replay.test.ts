import { describe, expect, it, vi } from 'vitest';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { moyu32Protocol } from './moyu32';
import { connectSmartCube } from '../index';
import type { SmartCubeEvent } from '../types';
import { createMoyu32SessionCrypto } from '../attachment/moyu32-session-crypto';
import * as addressHints from '../attachment/address-hints';

describe('MoYu MY22 (reconstructed real traffic)', () => {
    it('decodes the observed solved 24-sticker state and gyro stream', async () => {
        const fixture = await loadFixture(FIXTURES.moyu32_my22);
        const { device, replayer } = installMockBluetoothFromFixture(fixture, { maxAutoFlushNotifies: 0 });
        const conn = await moyu32Protocol.connect(device, async () => fixture.device.mac!);
        try {
            const events: SmartCubeEvent[] = [];
            const sub = conn.events$.subscribe(event => events.push(event));
            await replayer.drainNotificationsAsync();
            sub.unsubscribe();
            expect(events.filter(e => e.type === 'FACELETS').map(e => e.facelets))
                .toContain('UUUURRRRFFFFDDDDLLLLBBBB');
            expect(events.some(e => e.type === 'GYRO')).toBe(true);
            expect(conn.capabilities.gyroscope).toBe(true);
            // Counter follows the 72 sticker bits, rather than the 3×3 offset.
            expect((conn as unknown as { prevMoveCnt: number }).prevMoveCnt).toBe(4);
        } finally {
            await conn.disconnect();
        }
    });

    it('passes connection verification and caches the MAC for a real MY22 state', async () => {
        const fixture = await loadFixture(FIXTURES.moyu32_my22);
        installMockBluetoothFromFixture(fixture, { deviceId: 'my22-verification' });
        const cache = vi.spyOn(addressHints, 'setCachedMacForDevice');
        const conn = await connectSmartCube({ macAddressProvider: async () => fixture.device.mac! });
        try {
            expect(conn.deviceName).toBe('WCU_MY22_1037');
            expect(conn.deviceMAC).toBe('CF:30:16:01:10:37');
            expect(cache).toHaveBeenCalledWith(expect.objectContaining({ id: 'my22-verification' }), conn.deviceMAC);
        } finally {
            await conn.disconnect();
        }
    }, 2000);

    it('decrypts observed hardware and battery responses with the selected MAC', async () => {
        const fixture = await loadFixture(FIXTURES.moyu32_my22);
        const crypto = createMoyu32SessionCrypto(fixture.device.mac!);
        const packets = fixture.traffic.filter(t => t.op === 'notify').map(t =>
            crypto.decrypt(Array.from(Buffer.from(t.data!, 'hex')))
        );
        const hardware = packets.find(p => p[0] === 161)!;
        expect(String.fromCharCode(...hardware.slice(1, 9))).toBe('WCU_MY22');
        expect(packets.find(p => p[0] === 164)?.[1]).toBe(75);
        expect(packets.some(p => p[0] === 165)).toBe(false);
    });

    it('keeps 24-sticker output when applying a synthetic MY22 turn after the real state', async () => {
        const fixture = await loadFixture(FIXTURES.moyu32_my22);
        const crypto = createMoyu32SessionCrypto(fixture.device.mac!);
        // Sequence 5 follows state counter 4; MY22 code 2 is U.
        let bits = '10100101' + '0000000001100100'.repeat(6) + '00000101' + '010'.repeat(6);
        bits = bits.padEnd(160, '0');
        const packet = Array.from({ length: 20 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2));
        const sample = fixture.traffic.find(t => t.op === 'notify')!;
        fixture.traffic.push({ ...sample, t: 25000, data: Buffer.from(crypto.encrypt(packet)).toString('hex') });
        const { device, replayer } = installMockBluetoothFromFixture(fixture, { maxAutoFlushNotifies: 0 });
        const conn = await moyu32Protocol.connect(device, async () => fixture.device.mac!);
        try {
            const events: SmartCubeEvent[] = [];
            const sub = conn.events$.subscribe(event => events.push(event));
            await replayer.drainNotificationsAsync();
            sub.unsubscribe();
            expect(events.filter(e => e.type === 'MOVE').map(e => e.move)).toEqual(['U']);
            const states = events.filter(e => e.type === 'FACELETS').map(e => e.facelets);
            expect(states.at(-1)).toBe('UUUUBBRRRRFFDDDDFFLLLLBB');
            expect(states.every(state => state.length === 24)).toBe(true);
        } finally {
            await conn.disconnect();
        }
    });
});
