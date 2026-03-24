/**
 * Derive BLE address candidates from advertised device names (pattern-based only).
 */

function pushUnique(out: string[], seen: Set<string>, mac: string): void {
    if (seen.has(mac)) {
        return;
    }
    seen.add(mac);
    out.push(mac);
}

/**
 * QiYi / XMD-style names: build candidate MACs for cryptographic probing.
 */
export function buildQiYiMacCandidatesFromName(deviceName: string | null | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    if (!deviceName) {
        return out;
    }
    const t = deviceName.trim();

    const qyA = /^QY-QYSC-A-([0-9A-Fa-f]{4})$/.exec(t);
    if (qyA) {
        const x = qyA[1]!.toUpperCase();
        pushUnique(out, seen, `CC:A2:00:00:${x.slice(0, 2)}:${x.slice(2, 4)}`);
    }

    const qyS = /^QY-QYSC-S-([0-9A-Fa-f]{4})$/.exec(t);
    if (qyS) {
        const x = qyS[1]!.toUpperCase();
        const a = `${x.slice(0, 2)}:${x.slice(2, 4)}`;
        pushUnique(out, seen, `CC:A3:00:00:${a}`);
        pushUnique(out, seen, `CC:A3:00:01:${a}`);
    }

    const xmd = /^XMD-TornadoV4-i-([0-9A-Fa-f]{4})$/.exec(t);
    if (xmd) {
        const x = xmd[1]!.toUpperCase();
        pushUnique(out, seen, `CC:A6:00:00:${x.slice(0, 2)}:${x.slice(2, 4)}`);
    }

    return out.slice(0, 100);
}

/**
 * MoYu32 / WCU name patterns: multiple third-byte variants per hardware line.
 */
export function buildMoyu32MacCandidatesFromName(deviceName: string | null | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    if (!deviceName) {
        return out;
    }
    const t = deviceName.trim();

    const my32 = /^WCU_MY32_([0-9A-Fa-f]{4})$/.exec(t);
    if (my32) {
        const x = my32[1]!.toUpperCase();
        const a = `${x.slice(0, 2)}:${x.slice(2, 4)}`;
        for (const mid of ['00', '01', '02'] as const) {
            pushUnique(out, seen, `CF:30:16:${mid}:${a}`);
        }
    }

    const my33 = /^WCU_MY33_([0-9A-Fa-f]{4})$/.exec(t);
    if (my33) {
        const x = my33[1]!.toUpperCase();
        const a = `${x.slice(0, 2)}:${x.slice(2, 4)}`;
        for (const mid of ['02', '01', '00'] as const) {
            pushUnique(out, seen, `CF:30:16:${mid}:${a}`);
        }
    }

    return out.slice(0, 100);
}
