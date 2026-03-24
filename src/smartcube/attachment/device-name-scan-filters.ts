/**
 * Extra Web Bluetooth scan filters when reconnecting with a known advertised name.
 */

/** Wildcard-style names some stacks use for GAN advertising aliases. */
export function extraScanFiltersForKnownDeviceName(deviceName: string | undefined): BluetoothLEScanFilter[] {
    if (!deviceName) {
        return [];
    }
    const n = deviceName.trim();
    if (!n) {
        return [];
    }
    const out: BluetoothLEScanFilter[] = [{ name: n }];
    if (n.startsWith('GANic')) {
        out.push({ name: 'GANicXXX' });
    }
    if (n.startsWith('GANi3')) {
        out.push({ name: 'GANi3XXX' });
    }
    if (n.startsWith('AiCube')) {
        out.push({ name: 'AiCubeXXX' });
    }
    return out;
}
