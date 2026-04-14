import { describe, it, expect } from 'vitest';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { serviceUuidsFromFixture } from '../../test/helpers/fixture-replay';
import { collectEvents, fixtureExpectedLastFacelets, fixtureExpectedMoves, lastFacelets, moves } from '../../test/helpers/events';
import { giikerProtocol } from './giiker';

describe('giikerProtocol.connect (capture replay)', () => {
  it('matches fixture decoded events', async () => {
    const fixture = await loadFixture(FIXTURES.giiker);
    // Giiker init succeeds without consuming notifies; keep them for post-connect subscription.
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'giiker-replay', maxAutoFlushNotifies: 0 });

    const conn = await giikerProtocol.connect(
      device,
      undefined,
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

    const expectedMoves = fixtureExpectedMoves(fixture, 20);
    const expectedLast = fixtureExpectedLastFacelets(fixture);
    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);

    await conn.disconnect();
  }, 20_000);
});

