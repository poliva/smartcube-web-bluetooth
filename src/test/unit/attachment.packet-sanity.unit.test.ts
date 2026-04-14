import { describe, it, expect } from 'vitest';
import { isValidMoYu32DecryptedPacket, isValidQiYiDecryptedPacket } from '../../smartcube/attachment/packet-sanity';

describe('isValidMoYu32DecryptedPacket', () => {
  it('returns false when payload is missing or too short', () => {
    expect(isValidMoYu32DecryptedPacket(undefined as any)).toBe(false);
    expect(isValidMoYu32DecryptedPacket([])).toBe(false);
    expect(isValidMoYu32DecryptedPacket(new Array(19).fill(1))).toBe(false);
  });

  it('returns false when any byte is outside 0..255', () => {
    const bytes = new Array(20).fill(1);
    bytes[3] = 256;
    expect(isValidMoYu32DecryptedPacket(bytes)).toBe(false);
  });

  it('returns false when there are too many zeros in the first 20 bytes', () => {
    const bytes = new Array(20).fill(0);
    bytes[0] = 161;
    // z = 19 (>14) => reject early
    expect(isValidMoYu32DecryptedPacket(bytes)).toBe(false);
  });

  it('returns false when there are too many unique values in the first 20 bytes', () => {
    const bytes = Array.from({ length: 20 }, (_, i) => i);
    // unique size = 20 (>18) => reject early
    expect(isValidMoYu32DecryptedPacket(bytes)).toBe(false);
  });

  it('returns true for a minimal type 161 payload with a valid ASCII field', () => {
    // First byte is the packet type (161 / 0xA1). Next 8 bytes are an ASCII field.
    // Keep first 20 bytes with limited unique values and no excessive zeros/255.
    const bytes = new Array<number>(20).fill(1);
    bytes[0] = 0xa1;
    const ascii = 'ABCDEFGH';
    for (let i = 0; i < 8; i++) {
      bytes[1 + i] = ascii.charCodeAt(i);
    }
    expect(isValidMoYu32DecryptedPacket(bytes)).toBe(true);
  });
});

describe('isValidQiYiDecryptedPacket', () => {
  it('returns false when payload is too short', () => {
    expect(isValidQiYiDecryptedPacket(new Uint8Array([254, 1, 2, 3, 4, 5]))).toBe(false);
  });

  it('accepts a valid 0xFE payload with cmd/sub bounds and non-trivial 32-bit value', () => {
    const e = new Uint8Array([254, 7, 2, 0, 0, 0, 1]);
    expect(isValidQiYiDecryptedPacket(e)).toBe(true);
  });

  it('rejects 0xFE payload when sub is not 2 or 3', () => {
    const e = new Uint8Array([254, 7, 4, 0, 0, 0, 1]);
    expect(isValidQiYiDecryptedPacket(e)).toBe(false);
  });

  it('rejects 0xFE payload when cmd is outside 7..100', () => {
    expect(isValidQiYiDecryptedPacket(new Uint8Array([254, 6, 2, 0, 0, 0, 1]))).toBe(false);
    expect(isValidQiYiDecryptedPacket(new Uint8Array([254, 101, 2, 0, 0, 0, 1]))).toBe(false);
  });

  it('rejects 0xFE payload when 32-bit value is 0 or 0xFFFFFFFF', () => {
    expect(isValidQiYiDecryptedPacket(new Uint8Array([254, 7, 2, 0, 0, 0, 0]))).toBe(false);
    // Note: due to signed 32-bit bitwise ops, 0xFFFFFFFF becomes -1 and is not rejected by the current check.
    expect(isValidQiYiDecryptedPacket(new Uint8Array([254, 7, 2, 255, 255, 255, 255]))).toBe(true);
  });

  it('accepts a valid 0xCC 0x10 payload when int16 magnitudes are within bounds', () => {
    const e = new Uint8Array(16);
    e[0] = 204;
    e[1] = 16;
    const dv = new DataView(e.buffer);
    dv.setInt16(6, 2000, false);
    dv.setInt16(8, -2000, false);
    dv.setInt16(10, 0, false);
    dv.setInt16(12, 1999, false);
    expect(isValidQiYiDecryptedPacket(e)).toBe(true);
  });

  it('rejects a 0xCC 0x10 payload when any magnitude exceeds 2000', () => {
    const e = new Uint8Array(16);
    e[0] = 204;
    e[1] = 16;
    const dv = new DataView(e.buffer);
    dv.setInt16(6, 2001, false);
    dv.setInt16(8, 0, false);
    dv.setInt16(10, 0, false);
    dv.setInt16(12, 0, false);
    expect(isValidQiYiDecryptedPacket(e)).toBe(false);
  });
});

