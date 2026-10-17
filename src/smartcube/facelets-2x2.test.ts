import { describe, expect, it } from 'vitest';
import { CubieCube } from './cubie-cube';
import { parse2x2Facelets, to2x2Facelets } from './facelets-2x2';

describe('2×2 facelet validation', () => {
    it('round trips scrambled states, including odd corner permutations', () => {
        let cube = new CubieCube();
        for (const move of [3, 0, 8, 12, 10, 17]) {
            const next = new CubieCube();
            CubieCube.CubeMult(cube, CubieCube.moveCube[move], next);
            cube = next;
            expect(parse2x2Facelets(to2x2Facelets(cube))?.ca).toEqual(cube.ca);
        }
    });

    it('rejects malformed colors, a single twisted corner, and mirrored corners', () => {
        expect(parse2x2Facelets('U'.repeat(24))).toBeNull();
        expect(parse2x2Facelets('UUUURRRRFFFFDDDDLLLLBBBX')).toBeNull();
        expect(parse2x2Facelets('UUUURRRRFFFFDDDDLLLLBBB')).toBeNull();
        const twisted = new CubieCube();
        twisted.ca[0] |= 8;
        expect(parse2x2Facelets(to2x2Facelets(twisted))).toBeNull();
        const mirrored = [...to2x2Facelets(new CubieCube())];
        [mirrored[4], mirrored[9]] = [mirrored[9], mirrored[4]];
        expect(parse2x2Facelets(mirrored.join(''))).toBeNull();
    });
});
