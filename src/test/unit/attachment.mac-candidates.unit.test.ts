import { describe, it, expect } from 'vitest';
import { buildMoyu32MacCandidatesFromName, buildQiYiMacCandidatesFromName } from '../../smartcube/attachment/mac-candidates';

describe('buildQiYiMacCandidatesFromName', () => {
  it('returns empty array for null/empty/whitespace', () => {
    expect(buildQiYiMacCandidatesFromName(null)).toEqual([]);
    expect(buildQiYiMacCandidatesFromName('')).toEqual([]);
    expect(buildQiYiMacCandidatesFromName('   ')).toEqual([]);
  });

  it('builds a single candidate for QY-QYSC-A-XXXX', () => {
    expect(buildQiYiMacCandidatesFromName('QY-QYSC-A-1a2b')).toEqual(['CC:A2:00:00:1A:2B']);
  });

  it('builds two candidates for QY-QYSC-S-XXXX', () => {
    expect(buildQiYiMacCandidatesFromName('QY-QYSC-S-1A2B')).toEqual([
      'CC:A3:00:00:1A:2B',
      'CC:A3:00:01:1A:2B',
    ]);
  });

  it('builds a candidate for XMD-TornadoV4-i-XXXX', () => {
    expect(buildQiYiMacCandidatesFromName('XMD-TornadoV4-i-00fF')).toEqual(['CC:A6:00:00:00:FF']);
  });
});

describe('buildMoyu32MacCandidatesFromName', () => {
  it('returns empty array for null/empty/whitespace', () => {
    expect(buildMoyu32MacCandidatesFromName(undefined)).toEqual([]);
    expect(buildMoyu32MacCandidatesFromName('')).toEqual([]);
    expect(buildMoyu32MacCandidatesFromName('   ')).toEqual([]);
  });

  it('builds three candidates for WCU_MY32_XXXX with mid variants 00/01/02', () => {
    expect(buildMoyu32MacCandidatesFromName('WCU_MY32_1a2b')).toEqual([
      'CF:30:16:00:1A:2B',
      'CF:30:16:01:1A:2B',
      'CF:30:16:02:1A:2B',
    ]);
  });

  it('prioritizes the observed Weipo V5 AI address for WCU_MY22_1037', () => {
    expect(buildMoyu32MacCandidatesFromName('WCU_MY22_1037')).toEqual([
      'CF:30:16:01:10:37',
      'CF:30:16:00:10:37',
      'CF:30:16:02:10:37',
    ]);
  });

  it('normalizes MY22 suffixes and rejects malformed names', () => {
    expect(buildMoyu32MacCandidatesFromName(' WCU_MY22_0a3f ')).toEqual([
      'CF:30:16:01:0A:3F',
      'CF:30:16:00:0A:3F',
      'CF:30:16:02:0A:3F',
    ]);
    for (const name of ['WCU_MY22_103', 'WCU_MY22_10370', 'WCU_MY22_10ZZ']) {
      expect(buildMoyu32MacCandidatesFromName(name)).toEqual([]);
    }
  });

  it('builds three candidates for WCU_MY33_XXXX with mid variants 02/01/00 (stable ordering)', () => {
    expect(buildMoyu32MacCandidatesFromName('WCU_MY33_1a2b')).toEqual([
      'CF:30:16:02:1A:2B',
      'CF:30:16:01:1A:2B',
      'CF:30:16:00:1A:2B',
    ]);
  });

  it('caps output length at 100 (documents constraint)', () => {
    const out = buildMoyu32MacCandidatesFromName('WCU_MY32_1A2B');
    expect(out.length).toBeLessThanOrEqual(100);
  });
});

