/** The unit of a per caller ceiling: IPv4 whole, IPv6 by /64, IPv4 mapped into IPv6 as IPv4. */
import { describe, expect, it } from 'vitest';
import { callerBucket, callerHash } from '../src/caller.js';

describe('callerBucket', () => {
  it('keeps an IPv4 address whole', () => {
    expect(callerBucket('203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts every address of one IPv6 /64 as one caller', () => {
    const a = callerBucket('2001:db8:1234:5678::1');
    const b = callerBucket('2001:0db8:1234:5678:ffff:eeee:dddd:cccc');
    const c = callerBucket('2001:DB8:1234:5678:0:0:0:abcd%eth0');
    expect(a).toBe('2001:0db8:1234:5678::/64');
    expect(b).toBe(a);
    expect(c).toBe(a);
    // The next /64 is another caller.
    expect(callerBucket('2001:db8:1234:5679::1')).not.toBe(a);
  });

  it('counts an IPv4 client on a dual stack socket as the IPv4 address', () => {
    expect(callerBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(callerBucket('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('leaves what is not an address alone, the unknown bucket included', () => {
    expect(callerBucket('unknown')).toBe('unknown');
  });

  it('hashes the bucket, so two addresses of one /64 have one hash', () => {
    expect(callerHash('2001:db8::1')).toBe(callerHash('2001:db8::2'));
    expect(callerHash('203.0.113.7')).toMatch(/^[0-9a-f]{64}$/);
    expect(callerHash('203.0.113.7')).not.toBe(callerHash('203.0.113.8'));
  });
});
