import { describe, it, expect } from 'vitest';
import * as def from '../../gan-cube-definitions';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { ganProtocol } from './gan';

describe('ganProtocol.gattAffinity', () => {
  it('prefers gen1 profile when both gen1 services are present', () => {
    const s = new Set<string>([
      normalizeUuid(def.GAN_GEN1_PRIMARY_SERVICE),
      normalizeUuid(def.GAN_GEN1_DEVICE_INFO_SERVICE),
      normalizeUuid(def.GAN_GEN2_SERVICE),
      normalizeUuid(def.GAN_GEN4_SERVICE),
    ]);
    expect(ganProtocol.gattAffinity(s, {} as BluetoothDevice)).toBeGreaterThanOrEqual(125);
  });

  it('returns 0 when no GAN services are present', () => {
    expect(ganProtocol.gattAffinity(new Set(), {} as BluetoothDevice)).toBe(0);
  });

  it('scores gen2/gen3/gen4 services above zero', () => {
    const g2 = new Set([normalizeUuid(def.GAN_GEN2_SERVICE)]);
    const g3 = new Set([normalizeUuid(def.GAN_GEN3_SERVICE)]);
    const g4 = new Set([normalizeUuid(def.GAN_GEN4_SERVICE)]);
    expect(ganProtocol.gattAffinity(g2, {} as BluetoothDevice)).toBeGreaterThan(0);
    expect(ganProtocol.gattAffinity(g3, {} as BluetoothDevice)).toBeGreaterThan(0);
    expect(ganProtocol.gattAffinity(g4, {} as BluetoothDevice)).toBeGreaterThan(0);
  });
});

