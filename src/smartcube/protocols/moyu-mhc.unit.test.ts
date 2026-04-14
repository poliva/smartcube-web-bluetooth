import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import type { FixtureSession } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { moyuMhcProtocol } from './moyu-mhc';

function makeFixtureMhcTurnOnly(): FixtureSession {
  const service = '00001000-0000-1000-8000-00805f9b34fb';
  const chrTurn = '00001003-0000-1000-8000-00805f9b34fb';

  // One move entry: nMoves=1, timestamp bytes (arbitrary), face=0, dirByte=0xB8 => int8=-72 => round(-72/36)=-2.
  const payload = new Uint8Array([1, 0, 0, 0, 0, 0, 0xb8]);
  const hex = Array.from(payload)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');

  return {
    format: 'smartcube-fixture',
    version: 1,
    capturedAt: new Date().toISOString(),
    device: { name: 'MHC_TEST', id: '' },
    protocol: { id: 'moyu-mhc', name: 'MoYu MHC' },
    services: [],
    traffic: [
      { t: 0, op: 'discover-service', service },
      { t: 1, op: 'discover-char', service, characteristic: chrTurn },
      { t: 2, op: 'notify', service, characteristic: chrTurn, data: hex },
    ],
    events: [],
  };
}

describe('moyuMhcProtocol.connect (synthetic)', () => {
  it('emits MOVE and FACELETS from a turn notification even without v1 services', async () => {
    const fixture = makeFixtureMhcTurnOnly();
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'mhc', maxAutoFlushNotifies: 0 });

    const conn = await moyuMhcProtocol.connect(device, undefined, {
      serviceUuids: new Set([fixture.traffic[0]!.service]),
      advertisementManufacturerData: null,
      enableAddressSearch: false,
      onStatus: undefined,
      signal: undefined,
    });

    // Seed faceStatus so a -2 turn crosses the 5↔4 threshold and yields a MOVE.
    (conn as any).faceStatus[0] = 6;

    const events: any[] = [];
    const sub = conn.events$.subscribe({ next: (e) => events.push(e) });
    await replayer.drainNotificationsAsync();
    sub.unsubscribe();

    expect(events.some((e) => e.type === 'MOVE')).toBe(true);
    expect(events.some((e) => e.type === 'FACELETS')).toBe(true);

    await conn.disconnect();
  }, 10_000);
});

