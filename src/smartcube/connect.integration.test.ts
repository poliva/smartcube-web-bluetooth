import { describe, it, expect } from 'vitest';
import { connectSmartCube, type SmartCubeEvent } from './index';
import { FIXTURES, loadFixture } from '../test/fixtures';
import { installMockBluetoothFromFixture } from '../test/bluetooth-mock';
import { ganProtocol } from './protocols/gan';
import { qiyiProtocol } from './protocols/qiyi';

function collectMoves(events: SmartCubeEvent[]): string[] {
  return events.filter((e) => e.type === 'MOVE').map((e) => (e as any).move as string);
}

function lastFacelets(events: SmartCubeEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'FACELETS') return (e as any).facelets as string;
  }
  return null;
}

async function collectUntil<T>(
  subscribe: (onNext: (v: T) => void, onError: (e: unknown) => void) => () => void,
  predicate: (items: T[]) => boolean
): Promise<T[]> {
  return await new Promise<T[]>((resolve, reject) => {
    const items: T[] = [];
    const unsubscribe = subscribe(
      (v) => {
        items.push(v);
        if (predicate(items)) {
          unsubscribe();
          resolve(items);
        }
      },
      (e) => {
        unsubscribe();
        reject(e);
      }
    );
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

describe('connectSmartCube (capture replay)', () => {
  it(
    'matches fixture decoded events when replaying a Giiker fixture through connectSmartCube',
    async () => {
      const fixture = await loadFixture(FIXTURES.giiker);
      const { replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'giiker' });

      const conn = await withTimeout(
        connectSmartCube({
          deviceSelection: 'any',
          enableAddressSearch: false,
        }),
        2000,
        'connectSmartCube(Giiker)'
      );

      const fixtureFacelets = fixture.events
        .map((e) => e.event)
        .filter((e) => e.type === 'FACELETS')
        .map((e) => e.facelets as string);
      expect(fixtureFacelets.length).toBeGreaterThan(0);

      const events: SmartCubeEvent[] = [];
      const sub = conn.events$.subscribe({ next: (e) => events.push(e) });
      await conn.sendCommand({ type: 'REQUEST_FACELETS' });
      await replayer.drainNotificationsAsync();
      sub.unsubscribe();

      const observedFacelets = events.filter((e) => e.type === 'FACELETS').map((e) => (e as any).facelets as string);
      expect(observedFacelets.length).toBeGreaterThan(0);
      expect(fixtureFacelets).toContain(observedFacelets[0]);

      const disconnectEvents: SmartCubeEvent[] = [];
      const sub2 = conn.events$.subscribe({ next: (e) => disconnectEvents.push(e) });
      await conn.disconnect();
      sub2.unsubscribe();
      expect(disconnectEvents.some((e) => e.type === 'DISCONNECT')).toBe(true);
    },
    20_000
  );
});

describe('protocol.connect (capture replay)', () => {
  it('matches fixture decoded events when replaying a GAN gen2 fixture through the registered protocol', async () => {
    const fixture = await loadFixture(FIXTURES.ganGen2_small);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'gan-gen2' });

    const serviceUuids = new Set(
      fixture.traffic
        .filter((e) => e.op === 'discover-service')
        .map((e) => e.service)
    );

    const conn = await ganProtocol.connect(
      device,
      async () => fixture.device.mac ?? null,
      {
        serviceUuids,
        advertisementManufacturerData: null,
        enableAddressSearch: false,
        onStatus: undefined,
        signal: undefined,
      }
    );

    const expectedMoves = fixture.events
      .map((e) => e.event)
      .filter((e) => e.type === 'MOVE')
      .map((e) => e.move as string)
      .slice(0, 30);

    const expectedLastFacelets =
      [...fixture.events]
        .reverse()
        .map((e) => e.event)
        .find((e) => e.type === 'FACELETS')?.facelets ?? null;

    const eventsPromise = collectUntil<SmartCubeEvent>(
      (onNext, onError) => {
        const sub = conn.events$.subscribe({ next: onNext, error: onError });
        return () => sub.unsubscribe();
      },
      (events) => {
        const moves = collectMoves(events);
        const facelets = lastFacelets(events);
        return moves.length >= expectedMoves.length && facelets === expectedLastFacelets;
      }
    );

    const drainP = replayer.drainNotificationsAsync();
    const events = await eventsPromise;
    await drainP;
    expect(collectMoves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLastFacelets);

    await conn.disconnect();
  }, 20_000);

  it('matches fixture decoded events when replaying a QiYi fixture through the registered protocol', async () => {
    const fixture = await loadFixture(FIXTURES.qiyi);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'qiyi' });

    const serviceUuids = new Set(
      fixture.traffic
        .filter((e) => e.op === 'discover-service')
        .map((e) => e.service)
    );

    const conn = await qiyiProtocol.connect(
      device,
      async () => fixture.device.mac ?? null,
      {
        serviceUuids,
        advertisementManufacturerData: null,
        enableAddressSearch: false,
        onStatus: undefined,
        signal: undefined,
      }
    );

    const expectedMoves = fixture.events
      .map((e) => e.event)
      .filter((e) => e.type === 'MOVE')
      .map((e) => e.move as string)
      .slice(0, 20);

    const expectedLastFacelets =
      [...fixture.events]
        .reverse()
        .map((e) => e.event)
        .find((e) => e.type === 'FACELETS')?.facelets ?? null;

    const eventsPromise = collectUntil<SmartCubeEvent>(
      (onNext, onError) => {
        const sub = conn.events$.subscribe({ next: onNext, error: onError });
        return () => sub.unsubscribe();
      },
      (events) => {
        const moves = collectMoves(events);
        const facelets = lastFacelets(events);
        return moves.length >= expectedMoves.length && facelets === expectedLastFacelets;
      }
    );

    const drainP = replayer.drainNotificationsAsync();
    const events = await eventsPromise;
    await drainP;

    expect(collectMoves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLastFacelets);

    await conn.disconnect();
  }, 20_000);
});

