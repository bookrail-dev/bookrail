/**
 * Server Side Request Forgery: what a webhook URL is allowed to be, and what it is allowed to
 * resolve to.
 *
 * A webhook is a URL a **customer** chooses and **we** fetch, from inside our network, with our
 * credentials to nothing but reachable to everything. That is the textbook SSRF primitive: a
 * customer who registers `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 * and reads the delivery log has just been handed our cloud instance role. So there are two
 * gates, and they answer two different questions.
 *
 * **At creation: syntax.** Is this a URL we would ever be willing to call? Scheme, credentials,
 * port, and a hostname that is already a forbidden literal. It fails fast, with a 400 the
 * customer can act on, instead of registering an endpoint that will never work.
 *
 * **At delivery: semantics.** What does this hostname resolve to *now*? A name that answered
 * `93.184.216.34` at creation can answer `127.0.0.1` an hour later; that is not an edge case,
 * it is the attack (DNS rebinding). So every address is resolved again at delivery and checked
 * against the same table.
 *
 * And then the part that is usually missing: the connection is made **to the addresses that
 * were checked**. Resolving, approving, and then handing the hostname to an HTTP client that
 * resolves it a second time leaves exactly the window the whole exercise was about: a
 * nameserver with a zero TTL can answer publicly for our check and privately for the
 * connection. {@link resolveWebhookTarget} therefore returns a `lookup` function that hands the
 * socket the vetted list and nothing else, and `deliver.ts` passes it to `node:http`. TLS still
 * sees the real hostname, so certificate verification is untouched.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { errors, type Environment } from '@bookrail/shared';

/** Ports a webhook may name explicitly. 80 and 443 everywhere. */
const ALWAYS_ALLOWED_PORTS = new Set([80, 443]);

/**
 * Extra ports allowed in `test` only.
 *
 * A developer's receiver during an integration is on 8080-something far more often than on 443,
 * and `test` traffic carries no real bookings. `live` gets 443 and nothing else, because a live
 * endpoint on a high port is much more likely to be an internal service somebody found than a
 * deliberate choice.
 */
const TEST_ALLOWED_PORT_RANGE = { from: 8080, to: 8099 };

export interface SsrfOptions {
  /**
   * Allow loopback and private addresses.
   *
   * **Not** reachable from configuration: there is no environment variable that turns the SSRF
   * guard off, because that variable would eventually be set in production by somebody
   * debugging at two in the morning. It is a parameter of the delivery worker, set by the test
   * suite (which needs to deliver to a `node:http` server on 127.0.0.1) and by nothing else.
   */
  readonly allowPrivateTargets?: boolean;
  /**
   * Allow a port outside the allowed set.
   *
   * Separate from {@link allowPrivateTargets}, and separate on purpose: a test receiver listens
   * on an ephemeral port *and* on loopback, and while one flag governed both there was no test
   * anywhere that exercised the port rule against a real delivery: a security rule was
   * switched off as a side effect of another one.
   */
  readonly allowAnyPort?: boolean;
}

/** Why an address was refused. The message is safe to return to the customer. */
export interface BlockedAddress {
  readonly address: string;
  readonly reason: string;
}

// --- The address table -------------------------------------------------------------------

interface Cidr4 {
  readonly prefix: number;
  readonly bits: number;
  readonly reason: string;
}

function ipv4ToInt(parts: readonly number[]): number {
  return (
    (((parts[0] ?? 0) << 24) |
      ((parts[1] ?? 0) << 16) |
      ((parts[2] ?? 0) << 8) |
      (parts[3] ?? 0)) >>>
    0
  );
}

function cidr4(text: string, bits: number, reason: string): Cidr4 {
  const parts = text.split('.').map(Number);
  return { prefix: ipv4ToInt(parts), bits, reason };
}

/**
 * Everything that is not the public internet.
 *
 * Wider than the four famous private ranges on purpose: carrier grade NAT, the documentation
 * and benchmark
 * ranges, and the reserved 240/4 are all addresses a delivery has no business reaching, and
 * enumerating only the four famous private ranges is how `100.64.0.0/10` becomes an incident.
 */
const BLOCKED_V4: readonly Cidr4[] = [
  cidr4('0.0.0.0', 8, 'unspecified'),
  cidr4('10.0.0.0', 8, 'private'),
  cidr4('100.64.0.0', 10, 'carrier grade NAT'),
  cidr4('127.0.0.0', 8, 'loopback'),
  cidr4('169.254.0.0', 16, 'link-local or cloud metadata'),
  cidr4('172.16.0.0', 12, 'private'),
  cidr4('192.0.0.0', 24, 'IETF protocol assignments'),
  cidr4('192.0.2.0', 24, 'documentation'),
  cidr4('192.88.99.0', 24, 'deprecated 6to4 relay'),
  cidr4('192.168.0.0', 16, 'private'),
  cidr4('198.18.0.0', 15, 'benchmarking'),
  cidr4('198.51.100.0', 24, 'documentation'),
  cidr4('203.0.113.0', 24, 'documentation'),
  cidr4('224.0.0.0', 4, 'multicast'),
  cidr4('240.0.0.0', 4, 'reserved'),
];

interface Cidr6 {
  readonly bytes: Uint8Array;
  readonly bits: number;
  readonly reason: string;
}

function cidr6(bytes: readonly number[], bits: number, reason: string): Cidr6 {
  const full = new Uint8Array(16);
  full.set(bytes);
  return { bytes: full, bits, reason };
}

const BLOCKED_V6: readonly Cidr6[] = [
  cidr6([], 128, 'unspecified'), // ::
  cidr6([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128, 'loopback'), // ::1
  cidr6([0x01, 0x00], 64, 'discard-only'), // 100::/64
  cidr6([0x20, 0x01, 0x0d, 0xb8], 32, 'documentation'), // 2001:db8::/32
  // 6to4. Blocked whole rather than unwrapped: the mechanism is deprecated (RFC 7526) and its
  // v4 half, the 192.88.99.0/24 relay anycast, is already in the table above: blocking one and
  // not the other was the asymmetry the review found.
  cidr6([0x20, 0x02], 16, '6to4'),
  cidr6([0xfc], 7, 'unique local'), // fc00::/7
  cidr6([0xfe, 0x80], 10, 'link-local'), // fe80::/10
  cidr6([0xff], 8, 'multicast'), // ff00::/8
];

/**
 * The prefixes that carry an IPv4 address in their last four bytes.
 *
 * All four are judged as the IPv4 they contain, not as opaque IPv6: `::ffff:127.0.0.1` and
 * `64:ff9b::7f00:1` are both loopback, and a table that only knew about `::1` would let either
 * of them through. The promise is that IPv4 addresses disguised as IPv6 are refused, in the
 * plural, and this is the plural.
 */
const V4_EMBEDDED: readonly Cidr6[] = [
  cidr6([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96, 'IPv4-mapped'), // ::ffff:a.b.c.d
  cidr6([0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0], 96, 'IPv4-translated'), // ::ffff:0:a.b.c.d
  cidr6([0x00, 0x64, 0xff, 0x9b], 96, 'NAT64'), // 64:ff9b::a.b.c.d
  cidr6([], 96, 'IPv4-compatible'), // ::a.b.c.d, deprecated
];

/**
 * The 16 bytes of an IPv6 address, including the `::` compression and an embedded IPv4 tail.
 * Returns `null` for anything it cannot parse, which the caller treats as "refuse".
 */
export function ipv6ToBytes(address: string): Uint8Array | null {
  let text = address;
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const bytes = new Uint8Array(16);

  // An embedded IPv4 tail (`::ffff:127.0.0.1`) is expanded into its two groups first, so the
  // rest of the parser only ever sees hex groups.
  const lastColon = text.lastIndexOf(':');
  const tail = lastColon >= 0 ? text.slice(lastColon + 1) : '';
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const octets = tail.split('.').map(Number);
    const hi = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const lo = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + rest.length > 8) return null;

  const write = (groups: string[], offset: number): boolean => {
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i] ?? '';
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
      const value = Number.parseInt(group, 16);
      bytes[offset + i * 2] = (value >> 8) & 0xff;
      bytes[offset + i * 2 + 1] = value & 0xff;
    }
    return true;
  };
  if (!write(head, 0)) return null;
  if (!write(rest, 16 - rest.length * 2)) return null;
  return bytes;
}

function matchesPrefix(bytes: Uint8Array, prefix: Uint8Array, bits: number): boolean {
  const whole = bits >> 3;
  for (let i = 0; i < whole; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  const remaining = bits & 7;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return ((bytes[whole] ?? 0) & mask) === ((prefix[whole] ?? 0) & mask);
}

/** `null` when the address is on the public internet, a reason when it is not. */
export function blockedReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address.split('.').map(Number));
    for (const range of BLOCKED_V4) {
      const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
      if ((value & mask) >>> 0 === (range.prefix & mask) >>> 0) return range.reason;
    }
    return null;
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(address);
    if (bytes === null) return 'unparseable address';
    // The two exact addresses first, so `::1` is reported as loopback rather than as the
    // `::/96` IPv4-compatible form it also technically matches.
    for (const range of BLOCKED_V6) {
      if (range.bits === 128 && matchesPrefix(bytes, range.bytes, 128)) return range.reason;
    }
    // An IPv4 address wearing a hat is judged as an IPv4 address, whichever of the four hats it
    // is wearing. Checked before the rest of the v6 table, so the reason names the v4 range.
    for (const wrapper of V4_EMBEDDED) {
      if (!matchesPrefix(bytes, wrapper.bytes, wrapper.bits)) continue;
      const v4 = `${String(bytes[12])}.${String(bytes[13])}.${String(bytes[14])}.${String(bytes[15])}`;
      const reason = blockedReason(v4);
      return reason === null ? null : `${wrapper.reason} ${reason}`;
    }
    for (const range of BLOCKED_V6) {
      if (matchesPrefix(bytes, range.bytes, range.bits)) return range.reason;
    }
    return null;
  }
  return 'not an IP address';
}

// --- Gate one: the URL itself --------------------------------------------------------------

/**
 * Checks the shape of a webhook URL and returns it parsed.
 *
 * Throws a `400 invalid_request` with `param: "url"`, so the customer is told at creation what
 * is wrong instead of watching every delivery fail.
 */
export function assertWebhookUrl(
  raw: string,
  environment: Environment,
  options: SsrfOptions = {},
): URL {
  const refuse = (message: string): never => {
    throw errors.invalidRequest(message, 'url', 'invalid_webhook_url');
  };

  if (raw.length > 2048) refuse('url must be at most 2048 characters.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('url must be an absolute URL, for example https://example.com/hooks/bookrail.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    refuse(`url must use https (http is allowed in the test environment); got ${url.protocol}`);
  }
  if (url.protocol === 'http:' && environment !== 'test') {
    refuse('url must use https in the live environment.');
  }
  // Credentials in the URL would end up in the delivery log and in every error message.
  if (url.username !== '' || url.password !== '') {
    refuse('url must not contain credentials.');
  }
  if (url.hostname === '') refuse('url must have a host.');

  if (url.port !== '') {
    const port = Number(url.port);
    const allowed =
      ALWAYS_ALLOWED_PORTS.has(port) ||
      (environment === 'test' &&
        port >= TEST_ALLOWED_PORT_RANGE.from &&
        port <= TEST_ALLOWED_PORT_RANGE.to);
    if (!allowed && options.allowAnyPort !== true) {
      refuse(
        environment === 'test'
          ? `url may only name port 80, 443 or ${String(TEST_ALLOWED_PORT_RANGE.from)}-${String(TEST_ALLOWED_PORT_RANGE.to)} in the test environment.`
          : 'url may only name port 80 or 443.',
      );
    }
  }

  // A literal address is judged here and now: there is nothing to resolve later, and telling
  // the customer at creation is better than a delivery log full of the same refusal.
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(literal) !== 0 && options.allowPrivateTargets !== true) {
    const reason = blockedReason(literal);
    if (reason !== null) refuse(`url resolves to a ${reason} address (${literal}).`);
  }
  return url;
}

// --- Gate two: what it resolves to, now ----------------------------------------------------

export class SsrfError extends Error {
  readonly blocked: readonly BlockedAddress[];
  constructor(message: string, blocked: readonly BlockedAddress[] = []) {
    super(message);
    this.name = 'SsrfError';
    this.blocked = blocked;
  }
}

export interface ResolvedTarget {
  readonly addresses: readonly { address: string; family: 4 | 6 }[];
  /**
   * A `lookup` for `node:http`, answering with the vetted addresses and never touching DNS
   * again. This is what closes the rebinding window.
   */
  readonly lookup: LookupFunction;
}

/**
 * Resolves the hostname and refuses if **any** answer is off the public internet.
 *
 * *Any*, not *all*: a name that answers `93.184.216.34` and `127.0.0.1` is a name whose owner
 * is trying something, and picking the public one would make the outcome depend on the order a
 * resolver happened to return.
 */
export async function resolveWebhookTarget(
  url: URL,
  options: SsrfOptions = {},
): Promise<ResolvedTarget> {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;

  let answers: { address: string; family: number }[];
  if (isIP(host) !== 0) {
    answers = [{ address: host, family: isIP(host) }];
  } else {
    try {
      answers = await dnsLookup(host, { all: true, verbatim: true });
    } catch (error) {
      throw new SsrfError(
        `Could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (answers.length === 0) throw new SsrfError(`${host} resolved to no address.`);

  if (options.allowPrivateTargets !== true) {
    const blocked: BlockedAddress[] = [];
    for (const answer of answers) {
      const reason = blockedReason(answer.address);
      if (reason !== null) blocked.push({ address: answer.address, reason });
    }
    if (blocked.length > 0) {
      throw new SsrfError(
        `${host} resolves to a blocked address (${blocked
          .map((b) => `${b.address}: ${b.reason}`)
          .join(', ')}).`,
        blocked,
      );
    }
  }

  const addresses = answers.map((answer) => ({
    address: answer.address,
    family: (answer.family === 6 ? 6 : 4) as 4 | 6,
  }));

  const lookup: LookupFunction = (
    _hostname: string,
    lookupOptions: unknown,
    callback: (...args: never[]) => void,
  ): void => {
    const all =
      typeof lookupOptions === 'object' &&
      lookupOptions !== null &&
      (lookupOptions as { all?: boolean }).all === true;
    const cb = callback as unknown as (
      error: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void;
    if (all) {
      cb(
        null,
        addresses.map((a) => ({ address: a.address, family: a.family })),
      );
      return;
    }
    const first = addresses[0];
    if (first === undefined) {
      cb(new Error('No vetted address for this webhook target.'), '');
      return;
    }
    cb(null, first.address, first.family);
  };

  return { addresses, lookup };
}
