import type { FixtureSession } from '../fixtures';

export function serviceUuidsFromFixture(fixture: FixtureSession): ReadonlySet<string> {
  return new Set(
    fixture.traffic
      .filter((e) => e.op === 'discover-service')
      .map((e) => e.service)
  );
}

