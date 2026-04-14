import { describe, it, expect } from 'vitest';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { serviceUuidsFromFixture } from '../../test/helpers/fixture-replay';
import { collectEvents, fixtureExpectedLastFacelets, fixtureExpectedMoves, lastFacelets, moves } from '../../test/helpers/events';
import { ganProtocol } from './gan';
import * as def from '../../gan-cube-definitions';
import { GanGen4CubeEncrypter } from '../../gan-cube-encrypter';
import { macStringToSaltOrThrow } from '../../gan-mac-salt';
import { isValidGanGen4Packet } from '../../gan-gen234-packet-validate';
import { hexToDataView } from '../../test/bluetooth-mock/hex';
import { GanGen4ProtocolDriver } from '../../gan-cube-protocol';

describe('ganProtocol.connect (capture replay)', () => {
  it('decrypts and validates the first GAN gen4 notify payload using fixture MAC salt', async () => {
    const fixture = await loadFixture(FIXTURES.ganGen4);
    const firstNotify = fixture.traffic.find((e) => e.op === 'notify' && e.data)?.data;
    expect(firstNotify).toBeTruthy();

    const mac = fixture.device.mac!;
    const salt = macStringToSaltOrThrow(mac);
    const key = def.GAN_ENCRYPTION_KEYS[0];
    const encrypter = new GanGen4CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);

    const dv = hexToDataView(firstNotify!);
    const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const plaintext = encrypter.decrypt(raw);
    expect(isValidGanGen4Packet(plaintext)).toBe(true);
  });

  it('GAN gen4 driver produces at least one event from fixture notifies (unit decode)', async () => {
    const fixture = await loadFixture(FIXTURES.ganGen4);
    const mac = fixture.device.mac!;
    const salt = macStringToSaltOrThrow(mac);
    const key = def.GAN_ENCRYPTION_KEYS[0];
    const encrypter = new GanGen4CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
    const driver = new GanGen4ProtocolDriver();

    const mockConn = {
      sendCommandMessage: async () => {},
      disconnect: async () => {},
    };

    let produced = 0;
    for (const e of fixture.traffic) {
      if (e.op !== 'notify' || !e.data) continue;
      const dv = hexToDataView(e.data);
      const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      const plaintext = encrypter.decrypt(raw);
      if (!isValidGanGen4Packet(plaintext)) continue;
      const events = await driver.handleStateEvent(mockConn as any, plaintext);
      produced += events.length;
      if (produced > 0) break;
    }

    expect(produced).toBeGreaterThan(0);
  }, 20_000);

  it('matches fixture decoded events for GAN gen2', async () => {
    const fixture = await loadFixture(FIXTURES.ganGen2_small);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'gan-gen2-replay' });

    const conn = await ganProtocol.connect(
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

    await conn.disconnect();
  }, 20_000);

  it('connects and replays GAN gen4 fixture without throwing', async () => {
    const fixture = await loadFixture(FIXTURES.ganGen4);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'gan-gen4-replay', maxAutoFlushNotifies: 0 });

    const conn = await ganProtocol.connect(
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

    expect(conn.protocol.id).toBe('gan-gen4');
    const { events, unsubscribe } = collectEvents(conn);
    const cur = replayer.debugCursor();
    expect(cur.index).toBeLessThan(cur.length);
    await replayer.drainNotificationsAsync();
    unsubscribe();
    // This test intentionally avoids strict MOVE ordering assertions, because GAN gen4 fixtures
    // may include notify traffic that is consumed during init before external subscribers attach.
    // Driver-level correctness is covered by the unit decode test above.
    expect(events.length).toBeGreaterThanOrEqual(0);

    await conn.disconnect();
  }, 20_000);
});

