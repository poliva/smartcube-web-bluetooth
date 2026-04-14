import { describe, it, expect, vi } from 'vitest';
import {
  MOYU_V1_SOLVED_STICKERS,
  MoyuV1Client,
  moyuStickersToFaceletString,
  moyuV1EncodeCubeStatePayload,
  moyuV1ParseCubeStatePayload,
} from './moyu-v1';

function dvFromBytes(bytes: number[]): DataView {
  return new DataView(Uint8Array.from(bytes).buffer);
}

describe('moyu-v1 helpers', () => {
  it('round-trips cube state payload encode/parse', () => {
    const stickers = MOYU_V1_SOLVED_STICKERS.map((r) => [...r]);
    const angles = [0, 1, 2, 3, 4, 5];

    const encoded = moyuV1EncodeCubeStatePayload(stickers, angles);
    expect(encoded.byteLength).toBe(30);

    const parsed = moyuV1ParseCubeStatePayload(new DataView(encoded.buffer));
    expect(parsed.stickers).toEqual(stickers);
    expect(parsed.angles).toEqual(angles.map((a) => a & 15));
  });

  it('maps stickers to a 54-char facelet string', () => {
    const facelets = moyuStickersToFaceletString(MOYU_V1_SOLVED_STICKERS);
    expect(facelets).toHaveLength(54);
    // Centers in URFDLB order should be U,R,F,D,L,B.
    expect(facelets[4]).toBe('U');
    expect(facelets[13]).toBe('R');
    expect(facelets[22]).toBe('F');
    expect(facelets[31]).toBe('D');
    expect(facelets[40]).toBe('L');
    expect(facelets[49]).toBe('B');
  });
});

describe('MoyuV1Client.onReadNotification', () => {
  it('resolves a matching waiter when the final part arrives', async () => {
    vi.useFakeTimers();
    const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);

    const resolved: { value: DataView }[] = [];
    const timeout = setTimeout(() => {}, 10_000);
    (client as any).waiters.push({
      command: 3,
      id: 1,
      sentAt: 123,
      resolve: (v: { sentAt: number; receivedAt: number; value: DataView }) => resolved.push({ value: v.value }),
      reject: () => {},
      timeout,
    });

    // Build a merged response payload:
    // header: command=3, success=1, id=1 => 3 | (1<<4) | (1<<5) = 51
    const merged = [51, 0xaa, 0xbb, 0xcc];
    // split across 2 parts (payload is everything after byte2 in each 20-byte frame)
    const part0 = [0x00, (2 << 4) | 0, ...merged.slice(0, 2)];
    const part1 = [0x00, (2 << 4) | 1, ...merged.slice(2)];

    client.onReadNotification(dvFromBytes(part0));
    expect(resolved.length).toBe(0);
    client.onReadNotification(dvFromBytes(part1));

    expect(resolved.length).toBe(1);
    const out = resolved[0]!.value;
    expect(out.byteLength).toBe(3);
    expect(out.getUint8(0)).toBe(0xaa);
    expect(out.getUint8(1)).toBe(0xbb);
    expect(out.getUint8(2)).toBe(0xcc);

    clearTimeout(timeout);
    vi.useRealTimers();
  });
});

