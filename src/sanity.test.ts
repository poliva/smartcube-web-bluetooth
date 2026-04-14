import { describe, it, expect } from 'vitest';
import { extractMacFromManufacturerData } from './smartcube/ble-utils';

describe('sanity', () => {
  it('extracts MAC when manufacturer data is a DataView', () => {
    const dv = new DataView(
      // first 2 bytes are ignored by extractMacFromManufacturerData when given a DataView
      new Uint8Array([0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]).buffer
    );

    const mac = extractMacFromManufacturerData(dv, [], true);
    expect(mac).toBe('66:55:44:33:22:11');
  });
});

