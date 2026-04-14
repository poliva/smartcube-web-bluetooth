import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractMacFromManufacturerData, waitForAdvertisements } from './ble-utils';

describe('extractMacFromManufacturerData', () => {
  it('returns null when manufacturer data is null', () => {
    expect(extractMacFromManufacturerData(null, [1, 2, 3])).toBeNull();
  });

  it('returns null when manufacturer data is shorter than 6 bytes', () => {
    const dv = new DataView(new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]).buffer);
    expect(extractMacFromManufacturerData(dv, [], true)).toBeNull();
  });

  it('returns reversed-order MAC when input is a DataView', () => {
    const dv = new DataView(
      // first 2 bytes are ignored by extractMacFromManufacturerData when given a DataView
      new Uint8Array([0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]).buffer
    );

    expect(extractMacFromManufacturerData(dv, [], true)).toBe('66:55:44:33:22:11');
  });

  it('returns non-reversed-order MAC when reversedByteOrder is false', () => {
    const dv = new DataView(
      // first 2 bytes are ignored by extractMacFromManufacturerData when given a DataView
      new Uint8Array([0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]).buffer
    );

    expect(extractMacFromManufacturerData(dv, [], false)).toBe('66:55:44:33:22:11');
  });
});

describe('waitForAdvertisements', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when watchAdvertisements is not supported', async () => {
    const device = new (class extends EventTarget {})() as unknown as BluetoothDevice;
    const p = waitForAdvertisements(device, 10);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeNull();
  });

  it('returns manufacturerData when advertisementreceived fires before timeout', async () => {
    const device = new (class extends EventTarget {
      watchAdvertisements = vi.fn(async () => {});
    })() as unknown as BluetoothDevice;

    const mf = new Map<number, DataView>();
    mf.set(1, new DataView(new Uint8Array([1, 2, 3]).buffer));

    const p = waitForAdvertisements(device, 1000);

    const evt = new Event('advertisementreceived') as BluetoothAdvertisingEvent;
    (evt as unknown as { manufacturerData: BluetoothManufacturerData }).manufacturerData =
      mf as unknown as BluetoothManufacturerData;
    device.dispatchEvent(evt);

    await expect(p).resolves.toBe(mf);
  });

  it('returns null when no advertisement is received before timeout', async () => {
    const device = new (class extends EventTarget {
      watchAdvertisements = vi.fn(async () => {});
    })() as unknown as BluetoothDevice;

    const p = waitForAdvertisements(device, 10);
    await vi.advanceTimersByTimeAsync(11);
    await expect(p).resolves.toBeNull();
  });
});

