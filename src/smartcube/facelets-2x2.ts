import { cFacelet, CubieCube } from './cubie-cube';

const FACES = 'URFDLB';
const cornerIndex = (index: number): number =>
    Math.floor(index / 9) * 4 + [0, 2, 6, 8].indexOf(index % 9);

/** Parse a physically possible 2×2 state. Corner permutation parity is unrestricted. */
export function parse2x2Facelets(facelets: string): CubieCube | null {
    if (facelets.length !== 24 || /[^URFDLB]/.test(facelets)) return null;
    if ([...FACES].some(face => [...facelets].filter(c => c === face).length !== 4)) return null;
    const cube = new CubieCube();
    const seen = new Set<number>();
    let twist = 0;
    for (let position = 0; position < 8; position++) {
        const colors = cFacelet[position].map(index => facelets[cornerIndex(index)]);
        const orientation = colors.findIndex(color => color === 'U' || color === 'D');
        if (orientation < 0) return null;
        const piece = cFacelet.findIndex(stickers => stickers.every((index, n) =>
            FACES[Math.floor(index / 9)] === colors[(orientation + n) % 3]
        ));
        if (piece < 0 || seen.has(piece)) return null;
        seen.add(piece);
        cube.ca[position] = piece | (orientation << 3);
        twist += orientation;
    }
    return twist % 3 === 0 ? cube : null;
}

/** Project the corners of the shared cubie representation to 24 row-major stickers. */
export function to2x2Facelets(cube: CubieCube): string {
    const expanded = cube.toFaceCube();
    return Array.from({ length: 24 }, (_, i) =>
        expanded[Math.floor(i / 4) * 9 + [0, 2, 6, 8][i % 4]]
    ).join('');
}
