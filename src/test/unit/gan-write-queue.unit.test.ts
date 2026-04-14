import { describe, it, expect } from 'vitest';
import { GattWriteQueue } from '../../gan-write-queue';

describe('GattWriteQueue.enqueue', () => {
  it('runs enqueued operations sequentially', async () => {
    const q = new GattWriteQueue();
    const events: string[] = [];

    const p1 = q.enqueue(async () => {
      events.push('a:start');
      await new Promise((r) => setTimeout(r, 5));
      events.push('a:end');
      return 1;
    });

    const p2 = q.enqueue(async () => {
      events.push('b:start');
      events.push('b:end');
      return 2;
    });

    await expect(p1).resolves.toBe(1);
    await expect(p2).resolves.toBe(2);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('keeps the queue usable after a rejection', async () => {
    const q = new GattWriteQueue();
    const events: string[] = [];

    const p1 = q.enqueue(async () => {
      events.push('a');
      throw new Error('boom');
    });

    const p2 = q.enqueue(async () => {
      events.push('b');
      return 'ok';
    });

    await expect(p1).rejects.toThrow(/boom/);
    await expect(p2).resolves.toBe('ok');
    expect(events).toEqual(['a', 'b']);
  });
});

