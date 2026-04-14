/**
 * Post-decrypt sanity checks for MAC candidate probing.
 */

/** Validates decrypted MoYu32 notification bitstream. */
export function isValidMoYu32DecryptedPacket(bytes: number[]): boolean {
    if (!bytes || bytes.length < 20) {
        return false;
    }
    try {
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i]! < 0 || bytes[i]! > 255) {
                return false;
            }
        }
        let z = 0;
        let f = 0;
        for (let n = 0; n < Math.min(bytes.length, 20); n++) {
            if (bytes[n] === 0) {
                z++;
            } else if (bytes[n] === 255) {
                f++;
            }
        }
        if (z > 14 || f > 14 || new Set(bytes.slice(0, 20)).size > 18) {
            return false;
        }
        let n = '';
        for (let i = 0; i < bytes.length; i++) {
            n += (bytes[i]! + 256).toString(2).slice(1);
        }
        const r = parseInt(n.slice(0, 8), 2);
        return validateMoYu32BitBody(n, r);
    } catch {
        return false;
    }
}

function validateMoYu32BitBody(e: string, t: number): boolean {
    if (!e || e.length < 160) {
        return false;
    }
    try {
        const i = parseInt(e.slice(0, 8), 2);
        if (
            i !== t ||
            ![161, 163, 164, 165, 171].includes(i) ||
            (i === 164 && parseInt(e.slice(8, 16), 2) > 100)
        ) {
            return false;
        }
        if (i === 161) {
            for (let k = 0; k < 8; k++) {
                const v = parseInt(e.slice(8 + 8 * k, 16 + 8 * k), 2);
                if (v !== 0 && (v < 32 || v > 126)) {
                    return false;
                }
            }
        }
        if (i === 165) {
            let c = 0;
            for (let j = 0; j < 5; j++) {
                const v = parseInt(e.slice(96 + 5 * j, 101 + 5 * j), 2);
                if (v <= 11) {
                    c++;
                } else if (v < 31) {
                    return false;
                }
            }
            if (c === 0) {
                return false;
            }
            let allZero = true;
            let allMax = true;
            for (let r = 0; r < c; r++) {
                const v = parseInt(e.slice(8 + 16 * r, 24 + 16 * r), 2);
                if (v !== 0) {
                    allZero = false;
                }
                if (v !== 65535) {
                    allMax = false;
                }
            }
            if (allZero || allMax) {
                return false;
            }
        }
        if (i === 163) {
            const body = e.slice(8, 152);
            const zeros = (body.match(/0/g) || []).length;
            const ones = (body.match(/1/g) || []).length;
            if (zeros > 0.9 * body.length || ones > 0.9 * body.length) {
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

/** Validates decrypted QiYi notification payload. */
export function isValidQiYiDecryptedPacket(e: Uint8Array): boolean {
    if (!e || e.length < 7) {
        return false;
    }
    try {
        const t = e[0]!;
        if (t === 254) {
            const cmd = e[1]!;
            const sub = e[2]!;
            if (![2, 3].includes(sub) || cmd < 7 || cmd > 100) {
                return false;
            }
            const n = (((e[3]! << 24) | (e[4]! << 16) | (e[5]! << 8) | e[6]!) >>> 0);
            if (n === 0 || n === 0xffffffff) {
                return false;
            }
            return true;
        }
        if (t === 204 && e[1] === 16) {
            if (e.length < 16) {
                return false;
            }
            const dv = new DataView(e.buffer, e.byteOffset);
            const x = dv.getInt16(6, false);
            const y = dv.getInt16(8, false);
            const z = dv.getInt16(10, false);
            const w = dv.getInt16(12, false);
            if (
                Math.abs(x) > 2000 ||
                Math.abs(y) > 2000 ||
                Math.abs(z) > 2000 ||
                Math.abs(w) > 2000
            ) {
                return false;
            }
            return true;
        }
        return false;
    } catch {
        return false;
    }
}
