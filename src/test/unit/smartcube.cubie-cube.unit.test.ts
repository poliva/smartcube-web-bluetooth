import { describe, it, expect } from 'vitest';
import { CubieCube, SOLVED_FACELET } from '../../smartcube/cubie-cube';

describe('CubieCube.fromFacelet', () => {
  it('accepts the solved facelet string', () => {
    const c = new CubieCube();
    expect(c.fromFacelet(SOLVED_FACELET)).not.toBe(-1);
  });

  it('round-trips solved facelets through toFaceCube', () => {
    const c = new CubieCube();
    const out = c.fromFacelet(SOLVED_FACELET);
    expect(out).not.toBe(-1);
    if (out !== -1) {
      expect(out.toFaceCube()).toBe(SOLVED_FACELET);
    }
  });

  it('returns -1 when the input contains characters outside the six center colors', () => {
    const c = new CubieCube();
    const bad = SOLVED_FACELET.slice(0, 10) + 'X' + SOLVED_FACELET.slice(11);
    expect(c.fromFacelet(bad)).toBe(-1);
  });

  it('returns -1 when color counts are invalid', () => {
    const c = new CubieCube();
    // Replace one U with R: still uses valid colors but breaks the 9x-per-face count check.
    const bad = 'R' + SOLVED_FACELET.slice(1);
    expect(c.fromFacelet(bad)).toBe(-1);
  });

  it('throws for an empty string', () => {
    const c = new CubieCube();
    // Current implementation derives the center colors from fixed indices; empty input throws.
    expect(() => c.fromFacelet('')).toThrow();
  });
});

