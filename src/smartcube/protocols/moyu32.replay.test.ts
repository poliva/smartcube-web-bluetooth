import { describe, it, expect } from 'vitest';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { serviceUuidsFromFixture } from '../../test/helpers/fixture-replay';
import { collectEvents, fixtureExpectedLastFacelets, fixtureExpectedMoves, lastFacelets, moves } from '../../test/helpers/events';
import { moyu32Protocol } from './moyu32';

describe('moyu32Protocol.connect (capture replay)', () => {
  it('matches fixture decoded events and supports commands', async () => {
    const fixture = await loadFixture(FIXTURES.moyu32_my32);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'moyu32' });

    const conn = await moyu32Protocol.connect(
      device,
      async () => fixture.device.mac ?? null,
      {
        serviceUuids: serviceUuidsFromFixture(fixture),
        advertisementManufacturerData: null,
        enableAddressSearch: false,
        onStatus: undefined,
        signal: undefined,
      }
    );

    const { events, unsubscribe } = collectEvents(conn);

    // exercise command surface; implementation may emit or may no-op depending on fixture traffic
    await conn.sendCommand({ type: 'REQUEST_FACELETS' });
    await conn.sendCommand({ type: 'REQUEST_BATTERY' });
    await conn.sendCommand({ type: 'REQUEST_HARDWARE' });

    await replayer.drainNotificationsAsync();
    unsubscribe();

    const expectedMoves = fixtureExpectedMoves(fixture, 30);
    const expectedLast = fixtureExpectedLastFacelets(fixture);

    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);

    // MoYu32 supports gyro by design; fixture should contain at least one gyro event
    expect(conn.capabilities.gyroscope).toBe(true);
    expect(events.some((e) => e.type === 'GYRO')).toBe(true);

    await conn.disconnect();
  }, 20_000);
});

