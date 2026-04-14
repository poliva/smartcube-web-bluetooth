import { describe, it, expect } from 'vitest';
import { extraScanFiltersForKnownDeviceName } from '../../smartcube/attachment/device-name-scan-filters';

describe('extraScanFiltersForKnownDeviceName', () => {
  it('returns empty array for undefined/empty/whitespace', () => {
    expect(extraScanFiltersForKnownDeviceName(undefined)).toEqual([]);
    expect(extraScanFiltersForKnownDeviceName('')).toEqual([]);
    expect(extraScanFiltersForKnownDeviceName('   ')).toEqual([]);
  });

  it('always includes the exact device name filter', () => {
    expect(extraScanFiltersForKnownDeviceName('GANic123')).toEqual([{ name: 'GANic123' }, { name: 'GANicXXX' }]);
  });

  it('adds GANi3XXX when name starts with GANi3', () => {
    expect(extraScanFiltersForKnownDeviceName('GANi3-Pro')).toEqual([{ name: 'GANi3-Pro' }, { name: 'GANi3XXX' }]);
  });

  it('adds AiCubeXXX when name starts with AiCube', () => {
    expect(extraScanFiltersForKnownDeviceName('AiCube S')).toEqual([{ name: 'AiCube S' }, { name: 'AiCubeXXX' }]);
  });
});

