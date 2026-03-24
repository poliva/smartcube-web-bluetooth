import type { SmartCubeProtocol } from '../protocol';

/**
 * Pick the protocol that best matches the GATT profile. Tie-break with `matchesDevice` (name).
 */
export function resolveProtocolByGatt(
    protocols: readonly SmartCubeProtocol[],
    serviceUuids: ReadonlySet<string>,
    device: BluetoothDevice
): SmartCubeProtocol | null {
    const ranked = protocols.map((p) => ({
        p,
        score: p.gattAffinity(serviceUuids, device),
    }));
    const maxScore = ranked.reduce((m, r) => Math.max(m, r.score), -1);

    if (maxScore > 0) {
        const top = ranked.filter((r) => r.score === maxScore);
        const preferred = top.find((r) => r.p.matchesDevice(device));
        return (preferred ?? top[0]).p;
    }

    for (const p of protocols) {
        if (p.matchesDevice(device)) {
            return p;
        }
    }

    return null;
}
