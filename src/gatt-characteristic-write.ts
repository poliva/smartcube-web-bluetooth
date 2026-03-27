import { GattWriteQueue } from './gan-write-queue';

/**
 * One in-flight GATT operation per connection on common stacks; overlapping writes throw
 * NetworkError "GATT operation already in progress". Queue writes per device.
 */
const writeQueuesByDevice = new WeakMap<BluetoothDevice, GattWriteQueue>();

function writeQueueForCharacteristic(characteristic: BluetoothRemoteGATTCharacteristic): GattWriteQueue {
    const device = characteristic.service.device;
    let q = writeQueuesByDevice.get(device);
    if (!q) {
        q = new GattWriteQueue();
        writeQueuesByDevice.set(device, q);
    }
    return q;
}

/**
 * Writes using explicit Web Bluetooth APIs (writeValue is deprecated).
 * Chooses write-with-response vs write-without-response from characteristic.properties.
 * When both are supported, prefers write-with-response for reliable cross-platform command traffic.
 */
function writeGattCharacteristicValueNow(
    characteristic: BluetoothRemoteGATTCharacteristic,
    value: BufferSource
): Promise<void> {
    const { write, writeWithoutResponse } = characteristic.properties;
    if (!write && !writeWithoutResponse) {
        return Promise.reject(new Error('Characteristic is not writable'));
    }
    if (writeWithoutResponse && !write) {
        return characteristic.writeValueWithoutResponse(value);
    }
    if (write && !writeWithoutResponse) {
        return characteristic.writeValueWithResponse(value);
    }
    return characteristic.writeValueWithResponse(value);
}

export function writeGattCharacteristicValue(
    characteristic: BluetoothRemoteGATTCharacteristic,
    value: BufferSource
): Promise<void> {
    return writeQueueForCharacteristic(characteristic).enqueue(() =>
        writeGattCharacteristicValueNow(characteristic, value)
    );
}
