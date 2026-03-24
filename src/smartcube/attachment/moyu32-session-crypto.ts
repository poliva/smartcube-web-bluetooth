import { ModeOfOperation } from 'aes-js';

const BASE_KEY = [21, 119, 58, 92, 103, 14, 45, 31, 23, 103, 42, 19, 155, 103, 82, 87];
const BASE_IV = [17, 35, 38, 37, 134, 42, 44, 59, 85, 6, 127, 49, 126, 103, 33, 87];

function macSegments(mac: string): number[] {
    const parts = mac.split(/[:-\s]+/).map((x) => parseInt(x, 16));
    if (parts.length < 6 || parts.some((n) => Number.isNaN(n))) {
        throw new Error('Invalid MAC');
    }
    return parts.slice(0, 6);
}

/** MoYu32 AES session crypto keyed by device address (same derivation as protocol driver). */
export function createMoyu32SessionCrypto(mac: string): {
    decrypt(raw: number[]): number[];
    encrypt(data: number[]): number[];
} {
    const t = macSegments(mac);
    const key = BASE_KEY.slice();
    const iv = BASE_IV.slice();
    for (let i = 0; i < 6; i++) {
        key[i] = (key[i]! + t[5 - i]!) % 255;
        iv[i] = (iv[i]! + t[5 - i]!) % 255;
    }
    return {
        decrypt(raw: number[]): number[] {
            const cipher = new ModeOfOperation.ecb(new Uint8Array(key));
            const ret = raw.slice();
            if (ret.length > 16) {
                const offset = ret.length - 16;
                const block = cipher.decrypt(new Uint8Array(ret.slice(offset)));
                for (let i = 0; i < 16; i++) {
                    ret[i + offset] = block[i]! ^ iv[i]!;
                }
            }
            const block = cipher.decrypt(new Uint8Array(ret.slice(0, 16)));
            for (let i = 0; i < 16; i++) {
                ret[i] = block[i]! ^ iv[i]!;
            }
            return ret;
        },
        encrypt(data: number[]): number[] {
            const ret = data.slice();
            const cipher = new ModeOfOperation.ecb(new Uint8Array(key));
            for (let i = 0; i < 16; i++) {
                ret[i]! ^= iv[i]!;
            }
            const block = cipher.encrypt(new Uint8Array(ret.slice(0, 16)));
            for (let i = 0; i < 16; i++) {
                ret[i] = block[i]!;
            }
            if (ret.length > 16) {
                const offset = ret.length - 16;
                for (let i = 0; i < 16; i++) {
                    ret[i + offset]! ^= iv[i]!;
                }
                const block2 = cipher.encrypt(new Uint8Array(ret.slice(offset, offset + 16)));
                for (let i = 0; i < 16; i++) {
                    ret[i + offset] = block2[i]!;
                }
            }
            return ret;
        },
    };
}
