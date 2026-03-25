/** 6-byte MAC as reversed salt for GAN gen2–4 AES; throws if invalid. */
export function macStringToSaltOrThrow(mac: string): Uint8Array {
    const parts = mac.split(/[:-\s]+/).filter(Boolean);
    if (parts.length !== 6) {
        throw new Error(
            'GAN gen2–4 requires a valid 6-byte Bluetooth MAC (e.g. aa:bb:cc:dd:ee:ff).',
        );
    }
    const bytes = parts.map((c) => {
        const n = parseInt(c, 16);
        if (!Number.isFinite(n) || n < 0 || n > 255) {
            throw new Error('Invalid MAC address segment.');
        }
        return n;
    });
    return new Uint8Array(bytes.reverse());
}
