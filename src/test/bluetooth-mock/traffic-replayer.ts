import type { FixtureSession, FixtureTrafficEntry } from '../fixtures';
import { dataViewToHex, hexToDataView } from './hex';

type ServiceId = string;
type CharId = string;
type Key = `${ServiceId}|${CharId}`;

export type NotifySink = (data: DataView) => void;

export class TrafficReplayer {
  private readonly traffic: readonly FixtureTrafficEntry[];
  private i = 0;
  private readonly notifySinks = new Map<Key, NotifySink>();
  private readonly pendingNotifies = new Map<Key, DataView[]>();

  constructor(private readonly fixture: FixtureSession) {
    this.traffic = fixture.traffic;
  }

  registerNotifySink(serviceUuid: string, characteristicUuid: string, sink: NotifySink): void {
    const k: Key = `${serviceUuid}|${characteristicUuid}`;
    this.notifySinks.set(k, sink);
    const pending = this.pendingNotifies.get(k);
    if (pending && pending.length > 0) {
      for (const dv of pending) {
        sink(dv);
      }
      this.pendingNotifies.delete(k);
    }
  }

  unregisterNotifySink(serviceUuid: string, characteristicUuid: string): void {
    const k: Key = `${serviceUuid}|${characteristicUuid}`;
    this.notifySinks.delete(k);
  }

  private emitNotify(entry: FixtureTrafficEntry): void {
    const k: Key = `${entry.service}|${entry.characteristic ?? ''}`;
    const sink = this.notifySinks.get(k);
    if (!entry.data) {
      throw new Error(`Notify entry missing data at index ${this.i - 1}`);
    }
    const dv = hexToDataView(entry.data);
    if (sink) {
      sink(dv);
      return;
    }
    const arr = this.pendingNotifies.get(k) ?? [];
    arr.push(dv);
    this.pendingNotifies.set(k, arr);
  }

  /**
   * Consume fixture traffic until a matching entry is found.
   * Any `notify` entries encountered along the way are delivered (or queued).
   */
  private consumeUntilMatch(
    wanted: Pick<FixtureTrafficEntry, 'op' | 'service' | 'characteristic'>,
    opts?: { dataHex?: string; allowSkipNonMatchingIo?: boolean }
  ): FixtureTrafficEntry {
    const allowSkipNonMatchingIo = opts?.allowSkipNonMatchingIo ?? false;
    const wantedDesc = `${wanted.op} ${wanted.service} ${wanted.characteristic ?? ''}`.trim();

    while (this.i < this.traffic.length) {
      const entry = this.traffic[this.i++];

      if (entry.op === 'marker') continue;
      if (entry.op === 'notify') {
        this.emitNotify(entry);
        continue;
      }
      if (entry.op === 'discover-service' || entry.op === 'discover-char') {
        continue;
      }

      const isMatch =
        entry.op === wanted.op &&
        entry.service === wanted.service &&
        (entry.characteristic ?? null) === (wanted.characteristic ?? null);

      if (!isMatch) {
        if (!allowSkipNonMatchingIo && (entry.op === 'read' || entry.op === 'write')) {
          throw new Error(
            `Traffic diverged. Wanted ${wantedDesc} but saw ${entry.op} ${entry.service} ${entry.characteristic ?? ''} at traffic index ${
              this.i - 1
            }`
          );
        }
        continue;
      }

      if (opts?.dataHex) {
        const actual = (entry.data ?? '').toUpperCase();
        const expected = opts.dataHex.toUpperCase();
        if (actual !== expected) {
          throw new Error(
            `Write payload mismatch for ${wantedDesc} at traffic index ${this.i - 1}.\nExpected: ${expected}\nActual:   ${actual}`
          );
        }
      }
      return entry;
    }

    throw new Error(`Fixture ended before ${wantedDesc} could be matched (index=${this.i}/${this.traffic.length}).`);
  }

  onRead(serviceUuid: string, characteristicUuid: string): DataView {
    const entry = this.consumeUntilMatch(
      { op: 'read', service: serviceUuid, characteristic: characteristicUuid },
      { allowSkipNonMatchingIo: false }
    );
    if (!entry.data) {
      throw new Error(`Read entry missing data for ${serviceUuid} ${characteristicUuid}`);
    }
    const dv = hexToDataView(entry.data);
    this.flushNotifiesUntilNextIo();
    return dv;
  }

  onWrite(serviceUuid: string, characteristicUuid: string, value: DataView): void {
    const hex = dataViewToHex(value);
    this.consumeUntilMatch(
      { op: 'write', service: serviceUuid, characteristic: characteristicUuid },
      { dataHex: hex, allowSkipNonMatchingIo: false }
    );
    this.flushNotifiesUntilNextIo();
  }

  /**
   * Some protocol code performs discovery with varying redundancy. We keep discovery loose:
   * it can happen with or without matching fixture entries.
   */
  noteDiscovery(): void {
    // no-op; reserved for future stricter discovery assertions
  }

  /**
   * Deliver all remaining `notify` entries in the fixture, in order.
   * Useful after a successful connect when the real cube would keep streaming notifications.
   */
  drainNotifications(): void {
    while (this.i < this.traffic.length) {
      const entry = this.traffic[this.i++];
      if (entry.op === 'notify') {
        this.emitNotify(entry);
      }
    }
  }

  /**
   * Like `drainNotifications()` but yields periodically to keep tests responsive.
   */
  async drainNotificationsAsync(opts?: { chunkSize?: number }): Promise<void> {
    const chunkSize = opts?.chunkSize ?? 500;
    let processed = 0;
    while (this.i < this.traffic.length) {
      const entry = this.traffic[this.i++];
      if (entry.op === 'notify') {
        this.emitNotify(entry);
      }
      processed++;
      if (processed >= chunkSize) {
        processed = 0;
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  }

  private flushNotifiesUntilNextIo(): void {
    while (this.i < this.traffic.length) {
      const next = this.traffic[this.i];
      if (next.op === 'notify') {
        this.i++;
        this.emitNotify(next);
        continue;
      }
      if (next.op === 'marker' || next.op === 'discover-service' || next.op === 'discover-char') {
        this.i++;
        continue;
      }
      if (next.op === 'read' || next.op === 'write') {
        return;
      }
      // Unknown op: stop to avoid infinite loops.
      return;
    }
  }
}

