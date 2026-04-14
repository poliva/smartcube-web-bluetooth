import { describe, it, expect } from 'vitest';
import type { SmartCubeEvent } from './types';
import { FIXTURES, loadFixture } from '../test/fixtures';
import { installMockBluetoothFromFixture } from '../test/bluetooth-mock';
import { ganProtocol } from './protocols/gan';

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

describe('decoded cube states (snapshots)', () => {
  it('matches snapshot for GAN gen2 decoded moves and final facelets', async () => {
    const fixture = await loadFixture(FIXTURES.ganGen2_small);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'gan-snap' });

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

    const events: SmartCubeEvent[] = [];
    const sub = conn.events$.subscribe({ next: (e) => events.push(e) });
    await replayer.drainNotificationsAsync();
    sub.unsubscribe();

    expect(collectMoves(events)).toMatchSnapshot('gan-gen2 moves');
    expect(lastFacelets(events)).toMatchSnapshot('gan-gen2 final facelets');

    await conn.disconnect();
  }, 20_000);
});

