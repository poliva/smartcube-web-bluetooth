/** Normalize BLE UUID to 128-bit uppercase (16-bit UUIDs expanded per SIG base). */
export function normalizeUuid(uuid: string): string {
    let u = uuid;
    if (/^[0-9A-Fa-f]{4}$/.exec(u)) {
        u = '0000' + u + '-0000-1000-8000-00805F9B34FB';
    }
    return u.toUpperCase();
}
