import { describe, it, expect } from 'vitest';
import { macStringToSaltOrThrow } from '../../gan-mac-salt';

describe('macStringToSaltOrThrow', () => {
  it('returns reversed bytes for a valid colon-separated MAC', () => {
    const salt = macStringToSaltOrThrow('aa:bb:cc:dd:ee:ff');
    expect(Array.from(salt)).toEqual([0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa]);
  });

  it('accepts dash-separated and uppercase MACs', () => {
    const salt = macStringToSaltOrThrow('AA-BB-CC-DD-EE-FF');
    expect(Array.from(salt)).toEqual([0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa]);
  });

  it('accepts whitespace-separated segments and mixed separators', () => {
    const salt = macStringToSaltOrThrow('aa bb:cc-dd\tee ff');
    expect(Array.from(salt)).toEqual([0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa]);
  });

  it('throws when segment count is not 6', () => {
    expect(() => macStringToSaltOrThrow('aa:bb:cc:dd:ee')).toThrow(/requires a valid 6-byte/i);
    expect(() => macStringToSaltOrThrow('aa:bb:cc:dd:ee:ff:00')).toThrow(/requires a valid 6-byte/i);
  });

  it('throws when any segment is not valid hex', () => {
    expect(() => macStringToSaltOrThrow('aa:bb:cc:dd:ee:gg')).toThrow(/Invalid MAC address segment/);
  });

  it('throws when any segment is outside 00..FF', () => {
    expect(() => macStringToSaltOrThrow('aa:bb:cc:dd:ee:100')).toThrow(/Invalid MAC address segment/);
  });
});

