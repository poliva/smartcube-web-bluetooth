import { describe, expect, it, vi } from 'vitest';
import { FIXTURES, loadFixture, type FixtureSession } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { createMoyu32SessionCrypto } from '../attachment/moyu32-session-crypto';
import { parse2x2Facelets } from '../facelets-2x2';
import type { SmartCubeConnection, SmartCubeEvent } from '../types';
import * as bleUtils from '../ble-utils';
import { moyu32Protocol } from './moyu32';

const SOLVED = 'UUUURRRRFFFFDDDDLLLLBBBB';
const EXPECTED_MOVES = ['R', "R'", 'U', "U'", 'F', "F'"];
const EXPECTED_STATES = [
    'UFUFRRRRFDFDDBDBLLLLUBUB', SOLVED,
    'UUUUBBRRRRFFDDDDFFLLLLBB', SOLVED,
    'UULLURURFFFFRRDDLDLDBBBB', SOLVED,
];

function isTurn(fixture: FixtureSession, data: string | undefined): boolean {
    if (!data) return false;
    return createMoyu32SessionCrypto(fixture.device.mac!).decrypt([...Buffer.from(data, 'hex')])[0] === 165;
}

async function replay(fixture: FixtureSession): Promise<SmartCubeEvent[]> {
    // The long fixture includes MAC candidate probing before normal driver initialization.
    let driverStart = fixture.traffic.length - 1;
    while (driverStart > 0 && fixture.traffic[driverStart].op !== 'discover-service') driverStart--;
    fixture.traffic = fixture.traffic.slice(driverStart);
    // Replay uses immediate delivery; supply recorded receive times so the driver's
    // live clock-drift correction doesn't mistake multi-second pauses for drift.
    const receiveTimes = fixture.traffic.filter(entry => entry.op === 'notify').map(entry => entry.t);
    let notifyIndex = 0;
    const clock = vi.spyOn(bleUtils, 'now').mockImplementation(() => receiveTimes[notifyIndex++] ?? 60000);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { maxAutoFlushNotifies: 0 });
    let conn: SmartCubeConnection | undefined;
    try {
        conn = await moyu32Protocol.connect(device, async () => fixture.device.mac!);
        const events: SmartCubeEvent[] = [];
        const sub = conn.events$.subscribe(event => events.push(event));
        await replayer.drainNotificationsAsync();
        sub.unsubscribe();
        return events;
    } finally {
        await conn?.disconnect();
        clock.mockRestore();
    }
}

describe('MY22 real move captures', () => {
    it.each([false, true])('preserves delayed turn notifications when a requested snapshot already includes them (rollover %s)', async rollover => {
        const fixture = await loadFixture(FIXTURES.moyu32_my22_known_moves);
        const crypto = createMoyu32SessionCrypto(fixture.device.mac!);
        if (rollover) {
            let serial = 254;
            fixture.traffic = fixture.traffic.map(entry => {
                if (entry.op !== 'notify' || !entry.data) return entry;
                const bytes = crypto.decrypt([...Buffer.from(entry.data, 'hex')]);
                if (bytes[0] === 163) bytes[10] = 254;
                else if (bytes[0] === 165) bytes[13] = ++serial & 0xff;
                else return entry;
                return { ...entry, data: Buffer.from(crypto.encrypt(bytes)).toString('hex') };
            });
        }
        const stateEntry = fixture.traffic.find(entry => entry.op === 'notify' && entry.data &&
            crypto.decrypt([...Buffer.from(entry.data, 'hex')])[0] === 163)!;
        const state = crypto.decrypt([...Buffer.from(stateEntry.data!, 'hex')]);
        let turns = 0;
        fixture.traffic = fixture.traffic.flatMap(entry => {
            if (entry.op !== 'notify' || !isTurn(fixture, entry.data) || ++turns !== 2) return [entry];
            const turn = crypto.decrypt([...Buffer.from(entry.data!, 'hex')]);
            // R R' is solved, so reuse the real solved state with the newer
            // counter. Its response overtakes the second turn notification.
            state[10] = turn[13];
            return [{ ...entry, data: Buffer.from(crypto.encrypt(state)).toString('hex') }, entry];
        });
        const events = await replay(fixture);
        expect(events.filter(e => e.type === 'MOVE').map(e => e.move)).toEqual(EXPECTED_MOVES);
        const synthetic = events.flatMap(e => e.type === 'FACELETS' && e.source === 'moves' ? [e.facelets] : []);
        expect(synthetic).toEqual(EXPECTED_STATES);
    });

    it('preserves the reported U/R/F aliases for the physical D D\' L L\' B B\' capture', async () => {
        const fixture = await loadFixture(FIXTURES.moyu32_my22_opposite_moves);
        const events = await replay(fixture);
        const moves = events.filter(e => e.type === 'MOVE');
        // The six 3-bit codes are 3, 2, 4, 5, 0, 1, despite the physical D/L/B turns.
        expect(moves.map(e => e.move)).toEqual(["U'", 'U', 'R', "R'", 'F', "F'"]);
        expect(moves.map(e => e.move)).toEqual(
            fixture.events.filter(e => e.event.type === 'MOVE').map(e => e.event.move)
        );
        const statesAfterMoves = events.flatMap((event, i) => {
            if (event.type !== 'MOVE') return [];
            const next = events[i + 1];
            expect(next?.type).toBe('FACELETS');
            if (next.type === 'FACELETS') {
                expect(next.source).toBe('moves');
                expect(next.serial).toBe(event.serial);
            }
            return next.type === 'FACELETS' ? [next.facelets] : [];
        });
        expect(statesAfterMoves).toEqual([
            'UUUUFFRRLLFFDDDDBBLLRRBB', SOLVED,
            EXPECTED_STATES[0], SOLVED,
            EXPECTED_STATES[4], SOLVED,
        ]);
        // The explicit state request at the end independently reports solved.
        expect(events.filter(e => e.type === 'FACELETS').at(-1)).toMatchObject({ facelets: SOLVED, source: 'device' });
    });

    it('replays the user-confirmed R R\' U U\' F F\' with correct intermediate states', async () => {
        const events = await replay(await loadFixture(FIXTURES.moyu32_my22_known_moves));
        const moves = events.filter(e => e.type === 'MOVE');
        expect(moves.map(e => e.move)).toEqual(EXPECTED_MOVES);
        expect(moves.map(e => e.face)).toEqual([1, 1, 0, 0, 2, 2]);
        expect(moves.map(e => e.direction)).toEqual([0, 2, 0, 2, 0, 2]);
        expect(events.filter(e => e.type === 'FACELETS').slice(-6).map(e => e.facelets)).toEqual(EXPECTED_STATES);
        expect(moves.slice(1).map((e, i) => e.cubeTimestamp! - moves[i].cubeTimestamp!))
            .toEqual([723, 5032, 611, 2665, 1022]);
    });

    it('recovers all six moves from the final packet when five notifications are lost', async () => {
        const fixture = await loadFixture(FIXTURES.moyu32_my22_known_moves);
        let seen = 0;
        fixture.traffic = fixture.traffic.filter(entry =>
            entry.op !== 'notify' || !isTurn(fixture, entry.data) || ++seen === 6
        );
        const events = await replay(fixture);
        const moves = events.filter(e => e.type === 'MOVE');
        expect(moves.map(e => e.move)).toEqual(EXPECTED_MOVES);
        expect(moves.slice(0, -1).every(e => e.localTimestamp === null)).toBe(true);
        expect(moves.at(-1)?.localTimestamp).not.toBeNull();
        expect(events.filter(e => e.type === 'FACELETS').slice(-6).map(e => e.facelets)).toEqual(EXPECTED_STATES);
    });

    it('ignores repeated notifications without duplicating moves', async () => {
        const fixture = await loadFixture(FIXTURES.moyu32_my22_known_moves);
        fixture.traffic = fixture.traffic.flatMap(entry =>
            entry.op === 'notify' && isTurn(fixture, entry.data) ? [entry, { ...entry }] : [entry]
        );
        expect((await replay(fixture)).filter(e => e.type === 'MOVE').map(e => e.move)).toEqual(EXPECTED_MOVES);
    });

    it('handles move-counter rollover and unused startup history', async () => {
        const fixture = await loadFixture(FIXTURES.moyu32_my22_known_moves);
        const crypto = createMoyu32SessionCrypto(fixture.device.mac!);
        let counter = 250;
        fixture.traffic = fixture.traffic.map(entry => {
            if (entry.op !== 'notify' || !entry.data) return entry;
            const bytes = crypto.decrypt([...Buffer.from(entry.data, 'hex')]);
            if (bytes[0] === 163) bytes[10] = 250;
            else if (bytes[0] === 165) {
                bytes[13] = ++counter & 0xff;
                if (counter === 251) {
                    // Keep the latest code (R); mark the five older entries as unused (7).
                    bytes[14] |= 0x1f;
                    bytes[15] = 0xff;
                    bytes[16] |= 0xc0;
                }
            } else return entry;
            return { ...entry, data: Buffer.from(crypto.encrypt(bytes)).toString('hex') };
        });
        expect((await replay(fixture)).filter(e => e.type === 'MOVE').map(e => e.move)).toEqual(EXPECTED_MOVES);
    });

    it('decodes all 98 turns in the earlier mixed sequence into legal 24-sticker states', async () => {
        const events = await replay(await loadFixture(FIXTURES.moyu32_my22_turns));
        expect(events.filter(e => e.type === 'MOVE')).toHaveLength(98);
        const states = events.filter(e => e.type === 'FACELETS');
        expect(states.length).toBeGreaterThanOrEqual(98);
        expect(states.every(e => parse2x2Facelets(e.facelets) !== null)).toBe(true);
    });
});
