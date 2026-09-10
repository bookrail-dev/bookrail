import { describe, expect, it } from 'vitest';
import { decodeId, encodeId, isUuid, uuidv7, uuidv7At } from '@bookrail/shared';

describe('uuid v7 identifiers', () => {
  it('produces valid, version 7, RFC 4122 uuids', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('sorts by creation time as a string, which is what cursor pagination relies on', () => {
    const early = uuidv7At(1_000_000_000_000);
    const late = uuidv7At(2_000_000_000_000);
    expect(early < late).toBe(true);
  });

  it('round trips through the public prefixed form', () => {
    const id = uuidv7();
    const encoded = encodeId('resource', id);
    expect(encoded.startsWith('res_')).toBe(true);
    expect(decodeId('resource', encoded)).toBe(id);
  });

  it('refuses an identifier of the wrong kind', () => {
    const encoded = encodeId('service', uuidv7());
    expect(decodeId('resource', encoded)).toBeNull();
    expect(decodeId('resource', 'res_not-hex')).toBeNull();
  });
});

describe('uuid v7 monotonicity', () => {
  it('keeps creation order for identifiers minted in the same millisecond', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
