import { describe, it, expect } from 'vitest';
import {
  GanBitReader,
  isValidGanGen2Packet,
  isValidGanGen3Packet,
  isValidGanGen4Packet,
} from '../../gan-gen234-packet-validate';

function bytes16(): Uint8Array {
  return new Uint8Array(16);
}

function setBit(bytes: Uint8Array, bitOffset: number, value01: 0 | 1): void {
  const byteIndex = Math.floor(bitOffset / 8);
  const bitInByte = bitOffset % 8; // 0 = MSB
  const mask = 1 << (7 - bitInByte);
  if (value01) bytes[byteIndex]! |= mask;
  else bytes[byteIndex]! &= ~mask;
}

function setBitsBE(bytes: Uint8Array, bitOffset: number, bitLength: number, value: number): void {
  // Writes `bitLength` bits in big-endian bit order into the message bit stream.
  for (let i = 0; i < bitLength; i++) {
    const shift = bitLength - 1 - i;
    const b = ((value >> shift) & 1) as 0 | 1;
    setBit(bytes, bitOffset + i, b);
  }
}

describe('GanBitReader.getBitWord', () => {
  it('reads <=8 bits across byte boundaries', () => {
    // 0xAA = 10101010, 0x55 = 01010101
    const r = new GanBitReader(new Uint8Array([0xaa, 0x55]));
    expect(r.getBitWord(0, 4)).toBe(0b1010);
    expect(r.getBitWord(4, 4)).toBe(0b1010);
    expect(r.getBitWord(7, 2)).toBe(0b00); // last bit of 0xAA + first bit of 0x55
    expect(r.getBitWord(8, 8)).toBe(0x55);
  });

  it('reads 16-bit values with endianness control', () => {
    const r = new GanBitReader(new Uint8Array([0x12, 0x34, 0, 0]));
    expect(r.getBitWord(0, 16, false)).toBe(0x1234);
    expect(r.getBitWord(0, 16, true)).toBe(0x3412);
  });

  it('reads 32-bit values with endianness control', () => {
    const r = new GanBitReader(new Uint8Array([0x12, 0x34, 0x56, 0x78]));
    expect(r.getBitWord(0, 32, false)).toBe(0x12345678);
    expect(r.getBitWord(0, 32, true)).toBe(0x78563412);
  });

  it('throws on unsupported BitWord sizes', () => {
    const r = new GanBitReader(new Uint8Array([0]));
    expect(() => r.getBitWord(0, 9)).toThrow(/Invalid BitWord size/);
    expect(() => r.getBitWord(0, 24)).toThrow(/Invalid BitWord size/);
  });
});

describe('isValidGanGen2Packet', () => {
  it('returns false when payload is missing or too short', () => {
    expect(isValidGanGen2Packet(undefined as any)).toBe(false);
    expect(isValidGanGen2Packet(new Uint8Array(15))).toBe(false);
  });

  it('returns false when packet type nibble is not in the allowed set', () => {
    const e = bytes16();
    // i = 0
    e[0] = 0x00;
    expect(isValidGanGen2Packet(e)).toBe(false);
  });

  it('returns true for a minimal type 9 packet when value at bits 8..15 is <= 100', () => {
    const e = bytes16();
    // i=9 => first 4 bits: 1001 => 0x90
    e[0] = 0x90;
    e[1] = 100;
    expect(isValidGanGen2Packet(e)).toBe(true);
  });

  it('returns false for type 9 packet when value at bits 8..15 is > 100', () => {
    const e = bytes16();
    e[0] = 0x90;
    e[1] = 101;
    expect(isValidGanGen2Packet(e)).toBe(false);
  });

  it('returns false for type 1 packet when all four 16-bit words are zero', () => {
    const e = bytes16();
    // i=1 => 0001xxxx => 0x10
    e[0] = 0x10;
    expect(isValidGanGen2Packet(e)).toBe(false);
  });

  it('returns false for type 2 packet when any 4-bit field exceeds 5', () => {
    const e = bytes16();
    // i=2 => 0x20
    e[0] = 0x20;
    // first of 7 fields at offset 12, len 4: set to 15
    setBitsBE(e, 12, 4, 15);
    expect(isValidGanGen2Packet(e)).toBe(false);
  });

  it('returns false for type 5 packet when an ASCII field contains nonzero bytes outside 32..126', () => {
    const e = bytes16();
    // i=5 => 0x50
    e[0] = 0x50;
    // field at offset 40 is the first ASCII byte; set to 31 (<32) and non-zero
    setBitsBE(e, 40, 8, 31);
    expect(isValidGanGen2Packet(e)).toBe(false);
  });

  it('returns false for type 4 packet when parity bit-sum is odd', () => {
    const e = bytes16();
    // i=4 => 0x40
    e[0] = 0x40;
    // parity bits are at offsets 91..101; set only the first to 1 => odd
    setBit(e, 91, 1);
    expect(isValidGanGen2Packet(e)).toBe(false);
  });
});

describe('isValidGanGen3Packet', () => {
  it('returns false when payload is too short', () => {
    expect(isValidGanGen3Packet(new Uint8Array(15))).toBe(false);
  });

  it('returns true for a minimal gen3 header with allowed n and non-zero r', () => {
    const e = bytes16();
    e[0] = 85; // i
    e[1] = 2; // n in [1,2,6,7,16,17]
    e[2] = 1; // r != 0
    expect(isValidGanGen3Packet(e)).toBe(true);
  });

  it('returns false when i is not 85', () => {
    const e = bytes16();
    e[0] = 84;
    e[1] = 2;
    e[2] = 1;
    expect(isValidGanGen3Packet(e)).toBe(false);
  });

  it('returns false when r is zero', () => {
    const e = bytes16();
    e[0] = 85;
    e[1] = 2;
    e[2] = 0;
    expect(isValidGanGen3Packet(e)).toBe(false);
  });
});

describe('isValidGanGen4Packet', () => {
  it('returns false when payload is too short', () => {
    expect(isValidGanGen4Packet(new Uint8Array(15))).toBe(false);
  });

  it('returns true for a minimal gen4 packet with allowed header', () => {
    const e = bytes16();
    e[0] = 209;
    expect(isValidGanGen4Packet(e)).toBe(true);
  });

  it('returns false when header byte is not in the allowed set', () => {
    const e = bytes16();
    e[0] = 0;
    expect(isValidGanGen4Packet(e)).toBe(false);
  });
});

