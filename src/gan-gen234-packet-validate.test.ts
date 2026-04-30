import { describe, it, expect } from 'vitest';
import { isValidGanGen2Packet } from './gan-gen234-packet-validate';

/**
 * Build a 16-byte packet by writing big-endian bit fields starting at MSB of byte 0.
 * Mirrors the bit ordering used by GanBitReader / GanProtocolMessageView.
 */
function packBits(fields: Array<{ offset: number; length: number; value: number }>): Uint8Array {
    const bits = new Array(16 * 8).fill(0);
    for (const { offset, length, value } of fields) {
        for (let i = 0; i < length; i++) {
            bits[offset + i] = (value >>> (length - 1 - i)) & 1;
        }
    }
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
        out[i] = b;
    }
    return out;
}

function buildFaceletsPacket(opts: {
    cornerPerms?: number[]; // 7 values, 3 bits each
    cornerOris?: number[]; // 7 values, 2 bits each
    edgePerms?: number[]; // 11 values, 4 bits each
    edgeOris?: number[]; // 11 values, 1 bit each
}): Uint8Array {
    const fields: Array<{ offset: number; length: number; value: number }> = [
        { offset: 0, length: 4, value: 4 }, // eventType FACELETS
        { offset: 4, length: 8, value: 0 }, // serial
    ];
    const cp = opts.cornerPerms ?? new Array(7).fill(0);
    const co = opts.cornerOris ?? new Array(7).fill(0);
    const ep = opts.edgePerms ?? new Array(11).fill(0);
    const eo = opts.edgeOris ?? new Array(11).fill(0);
    for (let i = 0; i < 7; i++) fields.push({ offset: 12 + 3 * i, length: 3, value: cp[i] });
    for (let i = 0; i < 7; i++) fields.push({ offset: 33 + 2 * i, length: 2, value: co[i] });
    for (let i = 0; i < 11; i++) fields.push({ offset: 47 + 4 * i, length: 4, value: ep[i] });
    for (let i = 0; i < 11; i++) fields.push({ offset: 91 + i, length: 1, value: eo[i] });
    return packBits(fields);
}

describe('isValidGanGen2Packet — FACELETS', () => {
    it('accepts a solved-cube FACELETS packet (all-zero EO window, even parity)', () => {
        const pkt = buildFaceletsPacket({});
        expect(isValidGanGen2Packet(pkt)).toBe(true);
    });

    it('accepts a scrambled FACELETS packet with odd EO[0..10] sum (i.e. EO[11]=1)', () => {
        // Regression: previously rejected because the validator required
        // sum(EO[0..10]) to be even. That bit window can sum to either parity
        // for a valid cube — the 12th EO bit (not transmitted) carries the rest.
        const eo = new Array(11).fill(0);
        eo[0] = 1; // sum = 1, odd
        const pkt = buildFaceletsPacket({ edgeOris: eo });
        expect(isValidGanGen2Packet(pkt)).toBe(true);
    });

    it('accepts a scrambled FACELETS packet with three EO bits set (also odd)', () => {
        const eo = new Array(11).fill(0);
        eo[2] = eo[5] = eo[9] = 1;
        const pkt = buildFaceletsPacket({ edgeOris: eo });
        expect(isValidGanGen2Packet(pkt)).toBe(true);
    });

    it('rejects FACELETS packets where the 7 corner perms sum exceeds 28', () => {
        // 7 × 7 = 49 > 28; impossible for a valid cube.
        const cp = new Array(7).fill(7);
        const pkt = buildFaceletsPacket({ cornerPerms: cp });
        expect(isValidGanGen2Packet(pkt)).toBe(false);
    });

    it('rejects FACELETS packets where the 11 edge perms sum exceeds 66', () => {
        const ep = new Array(11).fill(15);
        const pkt = buildFaceletsPacket({ edgePerms: ep });
        expect(isValidGanGen2Packet(pkt)).toBe(false);
    });
});
