import { describe, it, expect, vi } from 'vitest';
import { Subject } from 'rxjs';
import { connectSmartCube } from './connect';
import { registerProtocol, getRegisteredProtocols, type SmartCubeProtocol } from './protocol';
import type { SmartCubeCapabilities, SmartCubeCommand, SmartCubeConnection, SmartCubeEvent } from './types';
import { FIXTURES, loadFixture } from '../test/fixtures';
import { installMockBluetoothFromFixture } from '../test/bluetooth-mock';
import * as addressHints from './attachment/address-hints';

function clearProtocolRegistry(): SmartCubeProtocol[] {
  const reg = getRegisteredProtocols();
  const snapshot = [...reg];
  reg.length = 0;
  return snapshot;
}

function restoreProtocolRegistry(protocols: SmartCubeProtocol[]): void {
  const reg = getRegisteredProtocols();
  reg.length = 0;
  reg.push(...protocols);
}

describe('connectSmartCube (error paths)', () => {
  it('throws when no smartcube protocols are registered', async () => {
    const prev = clearProtocolRegistry();
    try {
      await expect(connectSmartCube()).rejects.toThrow('No smartcube protocols registered');
    } finally {
      restoreProtocolRegistry(prev);
    }
  });

  it('throws a friendly timeout error when verified cube traffic never arrives', async () => {
    vi.useFakeTimers();
    const prev = clearProtocolRegistry();
    try {
      const fixture = await loadFixture(FIXTURES.ganGen2_small);
      const { device } = installMockBluetoothFromFixture(fixture, { deviceId: 'timeout-test' });
      const disconnectSpy = vi.spyOn(device.gatt!, 'disconnect');
      const removeCachedMacSpy = vi.spyOn(addressHints, 'removeCachedMacForDevice');
      const setCachedMacSpy = vi.spyOn(addressHints, 'setCachedMacForDevice');

      const caps: SmartCubeCapabilities = {
        gyroscope: false,
        battery: false,
        facelets: true,
        hardware: false,
        reset: false,
      };

      const dummy: SmartCubeProtocol = {
        nameFilters: [{ namePrefix: 'GAN' }],
        optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dc4179'],
        matchesDevice: () => true,
        gattAffinity: () => 999,
        connect: async () => {
          const events$ = new Subject<SmartCubeEvent>();
          const conn: SmartCubeConnection = {
            deviceName: 'Dummy',
            deviceMAC: 'AA:BB:CC:DD:EE:FF',
            protocol: { id: 'dummy', name: 'Dummy' },
            capabilities: caps,
            events$,
            sendCommand: async (_cmd: SmartCubeCommand) => {
              // Intentionally do not emit FACELETS (verification should time out).
            },
            disconnect: async () => {
              events$.next({ timestamp: Date.now(), type: 'DISCONNECT' });
              events$.complete();
            },
          };
          return conn;
        },
      };
      registerProtocol(dummy);

      const p = connectSmartCube({
        deviceSelection: 'any',
        enableAddressSearch: false,
      });

      const expectation = expect(p).rejects.toThrow(
        'Timed out waiting for cube data. Check the Bluetooth MAC address and try again.'
      );
      await vi.advanceTimersByTimeAsync(10_001);
      await expectation;

      expect(removeCachedMacSpy).toHaveBeenCalledTimes(1);
      expect(setCachedMacSpy).not.toHaveBeenCalled();
      expect(disconnectSpy).toHaveBeenCalled();
    } finally {
      restoreProtocolRegistry(prev);
      vi.useRealTimers();
    }
  });

  it('throws AbortError when signal is aborted during verification', async () => {
    vi.useFakeTimers();
    const prev = clearProtocolRegistry();
    try {
      const fixture = await loadFixture(FIXTURES.ganGen2_small);
      const { device } = installMockBluetoothFromFixture(fixture, { deviceId: 'abort-test' });
      const disconnectSpy = vi.spyOn(device.gatt!, 'disconnect');
      const removeCachedMacSpy = vi.spyOn(addressHints, 'removeCachedMacForDevice');
      const setCachedMacSpy = vi.spyOn(addressHints, 'setCachedMacForDevice');

      const controller = new AbortController();

      const dummy: SmartCubeProtocol = {
        nameFilters: [{ namePrefix: 'GAN' }],
        optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dc4179'],
        matchesDevice: () => true,
        gattAffinity: () => 999,
        connect: async () => {
          const events$ = new Subject<SmartCubeEvent>();
          return {
            deviceName: 'Dummy',
            deviceMAC: 'AA:BB:CC:DD:EE:FF',
            protocol: { id: 'dummy', name: 'Dummy' },
            capabilities: { gyroscope: false, battery: false, facelets: true, hardware: false, reset: false },
            events$,
            sendCommand: async () => {},
            disconnect: async () => {
              events$.complete();
            },
          };
        },
      };
      registerProtocol(dummy);

      const p = connectSmartCube({
        deviceSelection: 'any',
        enableAddressSearch: false,
        signal: controller.signal,
      });

      const expectation = expect(p).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await vi.runAllTimersAsync();

      await expectation;

      expect(removeCachedMacSpy).not.toHaveBeenCalled();
      expect(setCachedMacSpy).not.toHaveBeenCalled();
      expect(disconnectSpy).toHaveBeenCalled();
    } finally {
      restoreProtocolRegistry(prev);
      vi.useRealTimers();
    }
  });
});

