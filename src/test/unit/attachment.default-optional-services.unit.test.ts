import { describe, it, expect } from 'vitest';
import { DEFAULT_SMARTCUBE_OPTIONAL_SERVICES, mergeOptionalServiceUuids } from '../../smartcube/attachment/default-optional-services';

describe('mergeOptionalServiceUuids', () => {
  it('includes defaults even when protocol list is empty', () => {
    const out = mergeOptionalServiceUuids([]);
    expect(out).toEqual(expect.arrayContaining([...DEFAULT_SMARTCUBE_OPTIONAL_SERVICES]));
  });

  it('adds protocol services and de-duplicates', () => {
    const extra = ['0000fff0-0000-1000-8000-00805f9b34fb', DEFAULT_SMARTCUBE_OPTIONAL_SERVICES[0]!];
    const out = mergeOptionalServiceUuids(extra);
    expect(out).toEqual(expect.arrayContaining(extra));
    // Ensure at most one copy of a known default.
    const needle = DEFAULT_SMARTCUBE_OPTIONAL_SERVICES[0]!;
    expect(out.filter((s) => s === needle)).toHaveLength(1);
  });
});

