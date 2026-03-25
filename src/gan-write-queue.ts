/**
 * Serializes GATT writeValue calls to avoid overlapping operations on some stacks.
 */

export class GattWriteQueue {
    private tail: Promise<void> = Promise.resolve();

    enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.tail.then(() => fn());
        this.tail = run.then(
            () => {},
            () => {}
        );
        return run;
    }
}
