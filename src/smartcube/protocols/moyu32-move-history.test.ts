import { describe, expect, it } from 'vitest';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { createMoyu32SessionCrypto } from '../attachment/moyu32-session-crypto';
import { decodeMoyuMoveHistory } from './moyu32-move-history';

describe('MY22 turn framing (actual capture)', () => {
    it('extracts all 98 counters, six-entry histories and millisecond intervals', async () => {
        const fixture = await loadFixture(FIXTURES.moyu32_my22_turns);
        const crypto = createMoyu32SessionCrypto(fixture.device.mac!);
        const histories = fixture.traffic.filter(t => t.op === 'notify').map(t =>
            crypto.decrypt(Array.from(Buffer.from(t.data!, 'hex')))
        ).filter(bytes => bytes[0] === 165).map(bytes =>
            decodeMoyuMoveHistory(bytes.map(b => b.toString(2).padStart(8, '0')).join(''), 2)!
        );
        expect(histories).toHaveLength(98);
        expect(histories[0]).toEqual({
            sequence: 95,
            codes: [2, 2, 3, 0, 2, 2],
            timeOffsets: [21018, 11310, 65535, 1030, 202, 412],
        });
        expect(histories.at(-1)?.sequence).toBe(192);
        for (let i = 1; i < histories.length; i++) {
            expect(histories[i].sequence).toBe(histories[i - 1].sequence + 1);
            expect(histories[i].codes.slice(1)).toEqual(histories[i - 1].codes.slice(0, -1));
            expect(histories[i].timeOffsets.slice(1)).toEqual(histories[i - 1].timeOffsets.slice(0, -1));
        }
        expect(new Set(histories.map(h => h.codes[0]))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    });
});
