import { describe, it, expect } from 'vitest';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { serviceUuidsFromFixture } from '../../test/helpers/fixture-replay';
import { collectEvents, fixtureExpectedLastFacelets, fixtureExpectedMoves, lastFacelets, moves } from '../../test/helpers/events';
import { moyu32Protocol } from './moyu32';

describe('moyu32Protocol.connect (capture replay)', () => {
  it('matches fixture decoded events (no gyro device)', async () => {
    const fixture = await loadFixture(FIXTURES.moyu32_my33_noGyro);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, {
      deviceId: 'moyu32_no_gyro',
      maxAutoFlushNotifies: 0,
    });

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

    // gyro is detected lazily (first opcode-171 packet). For this fixture, it should never flip.
    expect(conn.capabilities.gyroscope).toBe(false);

    const { events, unsubscribe } = collectEvents(conn);

    await replayer.drainNotificationsAsync();
    unsubscribe();

    const expectedMoves = fixtureExpectedMoves(fixture, 30);
    const expectedLast = fixtureExpectedLastFacelets(fixture);

    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);

    expect(conn.capabilities.gyroscope).toBe(false);
    expect(events.some((e) => e.type === 'GYRO')).toBe(false);

    await conn.disconnect();
  }, 20_000);

  it('matches fixture decoded events (gyro device flips capability on first gyro packet)', async () => {
    const fixture = await loadFixture(FIXTURES.moyu32_my32);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, {
      deviceId: 'moyu32_gyro',
      maxAutoFlushNotifies: 0,
    });

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

    await replayer.drainNotificationsAsync();
    unsubscribe();

    const expectedMoves = fixtureExpectedMoves(fixture, 30);
    const expectedLast = fixtureExpectedLastFacelets(fixture);

    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);

    // This fixture contains gyro traffic; capability should flip and at least one GYRO event should exist.
    expect(conn.capabilities.gyroscope).toBe(true);
    expect(events.some((e) => e.type === 'GYRO')).toBe(true);

    await conn.disconnect();
  }, 20_000);
});

