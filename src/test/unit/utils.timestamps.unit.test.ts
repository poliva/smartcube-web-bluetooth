import { describe, it, expect } from 'vitest';
import type { GanCubeMove } from '../../gan-cube-protocol';
import { cubeTimestampCalcSkew, cubeTimestampLinearFit } from '../../utils';

function move(partial: Partial<GanCubeMove> & { localTimestamp: number }): GanCubeMove {
  return {
    face: partial.face ?? 0,
    direction: partial.direction ?? 0,
    move: partial.move ?? 'U',
    localTimestamp: partial.localTimestamp,
    cubeTimestamp: partial.cubeTimestamp ?? null,
  };
}

describe('cubeTimestampLinearFit', () => {
  it('returns empty array when input is empty', () => {
    expect(cubeTimestampLinearFit([])).toEqual([]);
  });

  it('returns a list whose first cubeTimestamp is 0', () => {
    const res = cubeTimestampLinearFit([
      move({ localTimestamp: 1000, cubeTimestamp: 200 }),
      move({ localTimestamp: 1100, cubeTimestamp: 300 }),
    ]);
    expect(res[0]!.cubeTimestamp).toBe(0);
  });

  it('fills a missing cubeTimestamp by aligning to the next move minus 50ms', () => {
    const moves = [
      move({ localTimestamp: 1000, cubeTimestamp: null }),
      move({ localTimestamp: 1050, cubeTimestamp: 500 }),
    ];
    const res = cubeTimestampLinearFit(moves);
    expect(res).toHaveLength(2);
    // the algorithm sets missing cubeTimestamp to next - 50
    expect(moves[0]!.cubeTimestamp).toBe(450);
  });

  it('fills a missing cubeTimestamp by aligning to the previous move plus 50ms', () => {
    const moves = [
      move({ localTimestamp: 1000, cubeTimestamp: 500 }),
      move({ localTimestamp: 1050, cubeTimestamp: null }),
    ];
    const res = cubeTimestampLinearFit(moves);
    expect(res).toHaveLength(2);
    expect(moves[1]!.cubeTimestamp).toBe(550);
  });

  it('uses slope=1 when cubeTimestamp variance is near zero', () => {
    const res = cubeTimestampLinearFit([
      move({ localTimestamp: 1000, cubeTimestamp: 123 }),
      move({ localTimestamp: 2000, cubeTimestamp: 123 }),
    ]);
    // With slope forced to 1 and identical cubeTimestamp inputs, both normalize to the same value (0).
    expect(res[0]!.cubeTimestamp).toBe(0);
    expect(res[1]!.cubeTimestamp).toBe(0);
  });
});

describe('cubeTimestampCalcSkew', () => {
  it('returns 0 when list is empty', () => {
    expect(cubeTimestampCalcSkew([])).toBe(0);
  });

  it('returns 0 for a perfect 1:1 mapping', () => {
    const skew = cubeTimestampCalcSkew([
      move({ localTimestamp: 1000, cubeTimestamp: 1000 }),
      move({ localTimestamp: 2000, cubeTimestamp: 2000 }),
      move({ localTimestamp: 3000, cubeTimestamp: 3000 }),
    ]);
    expect(skew).toBe(0);
  });

  it('returns ~2.0 when cube timestamps run 2% faster than local timestamps', () => {
    const skew = cubeTimestampCalcSkew([
      move({ localTimestamp: 1000, cubeTimestamp: 1020 }),
      move({ localTimestamp: 2000, cubeTimestamp: 2040 }),
      move({ localTimestamp: 3000, cubeTimestamp: 3060 }),
      move({ localTimestamp: 4000, cubeTimestamp: 4080 }),
    ]);
    expect(skew).toBeCloseTo(2.0, 3);
  });
});

