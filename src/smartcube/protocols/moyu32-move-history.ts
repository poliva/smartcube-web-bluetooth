export interface MoyuMoveHistory {
    sequence: number;
    /** Latest turn first. Codes retain their wire representation. */
    codes: number[];
    timeOffsets: number[];
}

/** MoYu MY22 uses six 3-bit turns; MY3 uses five 5-bit turns. */
export function decodeMoyuMoveHistory(bits: string, cubeSize: 2 | 3): MoyuMoveHistory | null {
    if (bits.length < 160) return null;
    const count = cubeSize === 2 ? 6 : 5;
    const codeWidth = cubeSize === 2 ? 3 : 5;
    const counterOffset = 8 + count * 16;
    const codesOffset = counterOffset + 8;
    return {
        sequence: parseInt(bits.slice(counterOffset, counterOffset + 8), 2),
        codes: Array.from({ length: count }, (_, i) =>
            parseInt(bits.slice(codesOffset + i * codeWidth, codesOffset + (i + 1) * codeWidth), 2)
        ),
        timeOffsets: Array.from({ length: count }, (_, i) =>
            parseInt(bits.slice(8 + i * 16, 24 + i * 16), 2)
        ),
    };
}
