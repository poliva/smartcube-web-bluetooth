export type FixtureTrafficOp =
  | 'discover-service'
  | 'discover-char'
  | 'read'
  | 'write'
  | 'notify'
  | 'marker';

export type FixtureTrafficEntry = {
  t: number;
  op: FixtureTrafficOp;
  service: string;
  characteristic?: string;
  data?: string; // hex string (no 0x prefix)
};

export type FixtureDeviceInfo = {
  name: string;
  id: string;
  mac?: string;
};

export type FixtureProtocolInfo = {
  id: string;
  name: string;
};

export type FixtureCubeEvent = {
  t: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any;
};

export type FixtureSession = {
  format: 'smartcube-fixture';
  version: 1;
  capturedAt: string;
  device: FixtureDeviceInfo;
  protocol: FixtureProtocolInfo;
  services: unknown[];
  traffic: FixtureTrafficEntry[];
  events: FixtureCubeEvent[];
  scenario?: string;
  notes?: string;
};

