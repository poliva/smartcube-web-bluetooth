import { describe, it, expect } from 'vitest';
import type { SmartCubeProtocol } from '../../smartcube/protocol';
import { resolveProtocolByGatt } from '../../smartcube/attachment/profile-rank';

function proto(id: string, opts: { score: number; matches: boolean }): SmartCubeProtocol {
  return {
    nameFilters: [],
    optionalServices: [],
    optionalManufacturerData: undefined,
    matchesDevice: () => opts.matches,
    gattAffinity: () => opts.score,
    connect: async () => {
      throw new Error(`connect not used in unit test: ${id}`);
    },
  };
}

describe('resolveProtocolByGatt', () => {
  it('returns the preferred protocol among top-scoring ties when matchesDevice is true', () => {
    const p1 = proto('p1', { score: 10, matches: false });
    const p2 = proto('p2', { score: 10, matches: true });
    const out = resolveProtocolByGatt([p1, p2], new Set<string>(), {} as BluetoothDevice);
    expect(out).toBe(p2);
  });

  it('returns the first top-scoring protocol when no top scorer matchesDevice', () => {
    const p1 = proto('p1', { score: 10, matches: false });
    const p2 = proto('p2', { score: 10, matches: false });
    const out = resolveProtocolByGatt([p1, p2], new Set<string>(), {} as BluetoothDevice);
    expect(out).toBe(p1);
  });

  it('falls back to matchesDevice when all scores are <= 0', () => {
    const p1 = proto('p1', { score: 0, matches: false });
    const p2 = proto('p2', { score: 0, matches: true });
    const out = resolveProtocolByGatt([p1, p2], new Set<string>(), {} as BluetoothDevice);
    expect(out).toBe(p2);
  });

  it('returns null when no protocol matches and all scores are <= 0', () => {
    const p1 = proto('p1', { score: 0, matches: false });
    const p2 = proto('p2', { score: -1, matches: false });
    const out = resolveProtocolByGatt([p1, p2], new Set<string>(), {} as BluetoothDevice);
    expect(out).toBeNull();
  });
});

