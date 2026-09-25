/**
 * The unit a per caller ceiling counts: an IPv4 address, or the /64 block of an IPv6 one.
 *
 * An IPv6 host is normally handed a whole /64, so counting whole addresses would give one
 * caller eighteen quintillion buckets: the sign up and dashboard ceilings "per caller" would be
 * ceilings per address it chose to use. The /64 is the unit an ISP assigns and the one a host
 * rotates inside. An IPv4 address mapped into IPv6 (`::ffff:192.0.2.1`, which is how Node reports
 * an IPv4 client on a dual stack socket) is counted as the IPv4 address it is.
 *
 * What is stored is the SHA-256 of this value, never the value. It is not salted, so an IPv4
 * hash can be reversed by trying every address; that is recorded as technical debt, with a keyed
 * HMAC as the proposal.
 */
import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

/** The eight groups of an IPv6 address, each as four hex digits, or `null` if it is not one. */
function expandIPv6(address: string): string[] | null {
  const bare = address.split('%')[0] ?? '';
  if (!isIPv6(bare)) return null;
  let text = bare.toLowerCase();
  // A trailing embedded IPv4 (`::ffff:192.0.2.1`, `64:ff9b::192.0.2.1`) becomes two groups.
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (embedded?.[1] !== undefined) {
    const [a, b, c, d] = embedded[1].split('.').map(Number) as [number, number, number, number];
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, -embedded[1].length)}${high}:${low}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - left.length - right.length;
  const groups =
    tail === undefined ? left : [...left, ...Array<string>(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return groups.map((group) => group.padStart(4, '0'));
}

/** The address a ceiling counts: IPv4 as it is, IPv6 as its /64, anything else unchanged. */
export function callerBucket(address: string): string {
  if (isIPv4(address)) return address;
  const groups = expandIPv6(address);
  if (groups === null) return address;
  // IPv4 mapped: `::ffff:a.b.c.d` is the IPv4 client it carries.
  if (groups.slice(0, 5).every((group) => group === '0000') && groups[5] === 'ffff') {
    const high = Number.parseInt(groups[6] ?? '0', 16);
    const low = Number.parseInt(groups[7] ?? '0', 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** What the database stores for a caller: the SHA-256 of its bucket, as hex. */
export function callerHash(address: string): string {
  return createHash('sha256').update(callerBucket(address), 'utf8').digest('hex');
}
