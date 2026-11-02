import { beforeEach, describe, expect, it } from 'vitest';
import {
  getCachedMacForDevice,
  removeCachedMacForDevice,
  setCachedMacForDevice,
} from '../../smartcube/attachment/address-hints';

const MAC_A = 'AA:BB:CC:DD:EE:01';
const MAC_B = 'AA:BB:CC:DD:EE:02';

function device(id: string, name?: string): BluetoothDevice {
  return { id, name } as BluetoothDevice;
}

describe('MAC cache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('finds the MAC by name when the device comes back with a new id', () => {
    setCachedMacForDevice(device('id-1', 'GANi3_ABCD'), MAC_A);

    expect(getCachedMacForDevice(device('id-2', 'GANi3_ABCD'))).toBe(MAC_A);
  });

  it('prefers the id entry over the name entry', () => {
    setCachedMacForDevice(device('id-1', 'GANi3_ABCD'), MAC_A);
    setCachedMacForDevice(device('id-2', 'GANi3_ABCD'), MAC_B);

    expect(getCachedMacForDevice(device('id-1', 'GANi3_ABCD'))).toBe(MAC_A);
  });

  it('still reads entries saved under the id before names were stored', () => {
    localStorage.setItem('smartcube-ble-mac:id-1', MAC_A);

    expect(getCachedMacForDevice(device('id-1', 'GANi3_ABCD'))).toBe(MAC_A);
  });

  it('returns null for a different name and a different id', () => {
    setCachedMacForDevice(device('id-1', 'GANi3_ABCD'), MAC_A);

    expect(getCachedMacForDevice(device('id-2', 'GANi3_EFGH'))).toBeNull();
  });

  it('removes both the id and the name entries', () => {
    setCachedMacForDevice(device('id-1', 'GANi3_ABCD'), MAC_A);

    removeCachedMacForDevice(device('id-2', 'GANi3_ABCD'));
    expect(getCachedMacForDevice(device('id-3', 'GANi3_ABCD'))).toBeNull();

    removeCachedMacForDevice(device('id-1', 'GANi3_ABCD'));
    expect(getCachedMacForDevice(device('id-1', 'GANi3_ABCD'))).toBeNull();
  });

  it('only uses the id for a device without a name', () => {
    setCachedMacForDevice(device('id-1'), MAC_A);

    expect(getCachedMacForDevice(device('id-1'))).toBe(MAC_A);
    expect(getCachedMacForDevice(device('id-2'))).toBeNull();
    expect(localStorage.length).toBe(1);
  });
});
