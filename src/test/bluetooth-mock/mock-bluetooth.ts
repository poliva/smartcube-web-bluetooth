import type { FixtureSession } from '../fixtures';
import { TrafficReplayer } from './traffic-replayer';

type Listener = (evt: Event) => void;

class MockCharacteristic extends EventTarget {
  readonly uuid: string;
  value: DataView | null = null;
  readonly service: MockService;
  private notifying = false;
  readonly properties: BluetoothCharacteristicProperties;

  constructor(
    uuid: string,
    service: MockService,
    private readonly replayer: TrafficReplayer
  ) {
    super();
    this.uuid = uuid;
    this.service = service;
    // be permissive; fixture traffic drives actual behavior validation
    this.properties = {
      broadcast: false,
      read: true,
      writeWithoutResponse: true,
      write: true,
      notify: true,
      indicate: false,
      authenticatedSignedWrites: false,
      reliableWrite: false,
      writableAuxiliaries: false,
    };
  }

  async startNotifications(): Promise<MockCharacteristic> {
    this.notifying = true;
    this.ensureNotifySink();
    return this;
  }

  async stopNotifications(): Promise<MockCharacteristic> {
    this.notifying = false;
    this.replayer.unregisterNotifySink(this.service.uuid, this.uuid);
    return this;
  }

  async readValue(): Promise<DataView> {
    return this.replayer.onRead(this.service.uuid, this.uuid);
  }

  async writeValueWithResponse(value: BufferSource): Promise<void> {
    this.replayer.onWrite(this.service.uuid, this.uuid, toDataView(value));
  }

  async writeValueWithoutResponse(value: BufferSource): Promise<void> {
    this.replayer.onWrite(this.service.uuid, this.uuid, toDataView(value));
  }

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    super.addEventListener(type, callback);
    if (type === 'characteristicvaluechanged') {
      this.ensureNotifySink();
    }
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    super.removeEventListener(type, callback);
  }

  private ensureNotifySink(): void {
    if (!this.notifying) return;

    // register a sink that will dispatch characteristicvaluechanged events
    this.replayer.registerNotifySink(this.service.uuid, this.uuid, (dv) => {
      if (!this.notifying) return;
      this.value = dv;
      this.dispatchEvent(new Event('characteristicvaluechanged'));
    });
  }
}

class MockService {
  readonly uuid: string;
  readonly device: BluetoothDevice;
  private readonly characteristics = new Map<string, MockCharacteristic>();

  constructor(uuid: string, device: BluetoothDevice) {
    this.uuid = uuid;
    this.device = device;
  }

  addCharacteristic(c: MockCharacteristic): void {
    this.characteristics.set(c.uuid.toLowerCase(), c);
  }

  hasCharacteristic(uuid: string): boolean {
    return this.characteristics.has(uuid.toLowerCase());
  }

  async getCharacteristic(uuid: string): Promise<MockCharacteristic> {
    const c = this.characteristics.get(uuid.toLowerCase());
    if (!c) throw new Error(`Characteristic not found: ${uuid} (service ${this.uuid})`);
    return c;
  }

  async getCharacteristics(): Promise<MockCharacteristic[]> {
    return Array.from(this.characteristics.values());
  }
}

class MockGATTServer {
  connected = false;
  private readonly services = new Map<string, MockService>();

  addService(s: MockService): void {
    this.services.set(s.uuid.toLowerCase(), s);
  }

  async connect(): Promise<MockGATTServer> {
    this.connected = true;
    return this;
  }

  disconnect(): void {
    this.connected = false;
  }

  async getPrimaryServices(): Promise<MockService[]> {
    if (!this.connected) throw new Error('GATT not connected');
    return Array.from(this.services.values());
  }

  async getPrimaryService(uuid: string): Promise<MockService> {
    if (!this.connected) throw new Error('GATT not connected');
    const s = this.services.get(uuid.toLowerCase());
    if (!s) throw new Error(`Service not found: ${uuid}`);
    return s;
  }
}

class MockBluetoothDevice extends EventTarget {
  readonly id: string;
  readonly name: string;
  readonly gatt: MockGATTServer;

  constructor(args: { id: string; name: string; gatt: MockGATTServer }) {
    super();
    this.id = args.id;
    this.name = args.name;
    this.gatt = args.gatt;
  }
}

function toDataView(src: BufferSource): DataView {
  if (src instanceof ArrayBuffer) {
    return new DataView(src);
  }
  if (ArrayBuffer.isView(src)) {
    return new DataView(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
  }
  // Should be unreachable for BufferSource
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  throw new Error(`Unsupported BufferSource: ${src as unknown as string}`);
}

export type MockBluetoothInstallResult = {
  device: BluetoothDevice;
  replayer: TrafficReplayer;
};

/**
 * Installs a mock `navigator.bluetooth.requestDevice` that returns a fake device whose
 * GATT services/characteristics are derived from fixture `discover-*` traffic entries.
 */
export function installMockBluetoothFromFixture(
  fixture: FixtureSession,
  opts?: { deviceId?: string }
): MockBluetoothInstallResult {
  const replayer = new TrafficReplayer(fixture);

  const gatt = new MockGATTServer();
  const services = new Map<string, MockService>();

  const device = new MockBluetoothDevice({
    id: opts?.deviceId ?? 'mock-device',
    name: fixture.device.name,
    gatt,
  }) as unknown as BluetoothDevice;

  // Build graph from capture discovery and I/O entries (some captures omit explicit discover ops).
  for (const e of fixture.traffic) {
    if (!('service' in e)) continue;
    const sUuid = e.service.toLowerCase();
    if (e.op === 'discover-service' || e.op === 'discover-char' || e.op === 'read' || e.op === 'write' || e.op === 'notify') {
      if (!services.has(sUuid) && sUuid !== 'marker') {
        services.set(sUuid, new MockService(sUuid, device));
      }
    }
    if ((e.op === 'discover-char' || e.op === 'read' || e.op === 'write' || e.op === 'notify') && e.characteristic) {
      const s = services.get(sUuid);
      if (s) {
        const cUuid = e.characteristic.toLowerCase();
        if (!s.hasCharacteristic(cUuid)) {
          const c = new MockCharacteristic(cUuid, s, replayer);
          s.addCharacteristic(c);
        }
      }
    }
  }

  for (const s of services.values()) gatt.addService(s);

  const bluetooth = {
    requestDevice: async () => device,
  };

  (globalThis as unknown as { navigator: { bluetooth: unknown } }).navigator = (globalThis as any).navigator ?? ({} as any);
  (globalThis as any).navigator.bluetooth = bluetooth;

  return { device, replayer };
}

