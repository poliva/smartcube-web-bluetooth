import { describe, it, expect } from 'vitest';
import { normalizeUuid } from '../../smartcube/attachment/normalize-uuid';

describe('normalizeUuid', () => {
  it('expands 16-bit UUIDs into the SIG base UUID and uppercases', () => {
    expect(normalizeUuid('180A')).toBe('0000180A-0000-1000-8000-00805F9B34FB');
    expect(normalizeUuid('180a')).toBe('0000180A-0000-1000-8000-00805F9B34FB');
  });

  it('uppercases already-128-bit UUIDs without changing structure', () => {
    expect(normalizeUuid('0000180a-0000-1000-8000-00805f9b34fb')).toBe(
      '0000180A-0000-1000-8000-00805F9B34FB'
    );
  });

  it('does not attempt to validate malformed UUIDs (documents behavior)', () => {
    expect(normalizeUuid('not-a-uuid')).toBe('NOT-A-UUID');
  });
});

