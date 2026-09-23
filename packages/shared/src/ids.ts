import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Object kinds that own a public, prefixed identifier in the API.
 * The database always stores the bare UUID; the API layer adds and strips the prefix.
 */
export const ID_PREFIXES = {
  account: 'acct',
  project: 'proj',
  api_key: 'key',
  location: 'loc',
  resource: 'res',
  resource_group: 'rg',
  resource_group_member: 'rgm',
  schedule: 'sch',
  schedule_rule: 'shr',
  schedule_exception: 'she',
  resource_block: 'blk',
  service: 'svc',
  service_requirement: 'sreq',
  policy: 'pol',
  customer: 'cus',
  booking: 'bk',
  booking_allocation: 'ball',
  hold: 'hold',
  occupancy: 'occ',
  recurrence: 'rec',
  waitlist_entry: 'wl',
  entitlement: 'ent',
  payment: 'pay',
  event: 'evt',
  webhook: 'wh',
  webhook_delivery: 'whd',
  signup: 'sgn',
  /** The link between one project, one environment and one payment provider account. */
  payment_provider_connection: 'pcn',
} as const;

export type ObjectKind = keyof typeof ID_PREFIXES;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * UUID version 7: 48 bits of Unix milliseconds, 12 bits of sequence, 62 bits of randomness.
 * Sortable by creation time, which is what cursor pagination and btree locality rely on.
 * Node 20 has no native v7 generator, so we build it from randomBytes.
 *
 * The 12 bit `rand_a` field is used as a per-millisecond counter (the "monotonic random"
 * method of RFC 9562 section 6.2): two identifiers minted in the same millisecond by the same
 * process still come out in creation order, so a list created in a tight loop paginates
 * correctly and rows inserted together keep their insertion order.
 */
let lastMillis = -1;
let sequence = 0;

function randomSequence(): number {
  // Start low enough to leave room for a few thousand increments inside the millisecond.
  return randomBytes(2).readUInt16BE(0) & 0x07ff;
}

function nextTimestampAndSequence(): [number, number] {
  const now = Date.now();
  if (now > lastMillis) {
    lastMillis = now;
    sequence = randomSequence();
    return [lastMillis, sequence];
  }
  // Same millisecond, or a clock that went backwards: keep going forward regardless.
  sequence += 1;
  if (sequence > 0x0fff) {
    lastMillis += 1;
    sequence = 0;
  }
  return [lastMillis, sequence];
}

function formatUuidV7(millis: number, seq: number): string {
  const bytes = randomBytes(16);
  const ts = BigInt(millis);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  // version 7 in the high nibble, then the 12 bit sequence counter
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  // RFC 4122 variant
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidv7(): string {
  const [millis, seq] = nextTimestampAndSequence();
  return formatUuidV7(millis, seq);
}

/**
 * A v7 identifier for an explicit instant. Does not touch the monotonic counter, so it is safe
 * to call with arbitrary (including future) timestamps; used for fixtures and tests.
 */
export function uuidv7At(millis: number): string {
  return formatUuidV7(millis, randomSequence());
}

/** Random UUID v4, for identifiers where time ordering leaks information. */
export function uuidv4(): string {
  return randomUUID();
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** `res_0193f0c2a1b47e2e9a1c0f4d5e6a7b8c` */
export function encodeId(kind: ObjectKind, uuid: string): string {
  return `${ID_PREFIXES[kind]}_${uuid.replaceAll('-', '')}`;
}

/** Returns null when the string is not a well formed identifier of that kind. */
export function decodeId(kind: ObjectKind, value: string): string | null {
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!value.startsWith(prefix)) return null;
  const hex = value.slice(prefix.length);
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID_RE.test(uuid) ? uuid : null;
}

/** `req_` + 24 hex characters. One per HTTP request, echoed in errors and logs. */
export function newRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}
