/**
 * `verifySignature`: the one function of Bookrail that runs on the customer's machine.
 *
 * Everything here is a property a receiver depends on: a valid signature is accepted, a forged
 * one is not, a replay outside the tolerance is not, a malformed header is `false` and never an
 * exception, and a header carrying two `v1=` (a secret rotation in progress) is accepted by a
 * holder of either secret.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  buildSignatureHeader,
  computeSignature,
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  parseSignatureHeader,
  signaturePayload,
  signPayload,
  verifySignature,
} from '../src/index.js';

const SECRET = 'whsec_c9f3a1d0e2b74c5f8a6d3b1e0f7c2a94';
const OTHER = 'whsec_0000000000000000000000000000000000';
const BODY = JSON.stringify({ id: 'evt_1', type: 'booking.confirmed', data: { object: {} } });
const NOW = 1_789_012_345;

describe('webhook signature', () => {
  it('signs exactly "<t>.<body>" with HMAC-SHA256, hex', () => {
    expect(signaturePayload(NOW, BODY)).toBe(`${String(NOW)}.${BODY}`);
    const expected = createHmac('sha256', SECRET)
      .update(`${String(NOW)}.${BODY}`, 'utf8')
      .digest('hex');
    expect(computeSignature(BODY, SECRET, NOW)).toBe(expected);
    expect(signPayload(BODY, SECRET, NOW)).toBe(`t=${String(NOW)},v1=${expected}`);
  });

  it('accepts a signature it produced itself', () => {
    const header = signPayload(BODY, SECRET, NOW);
    expect(verifySignature(BODY, header, SECRET, 300, NOW)).toBe(true);
  });

  it('refuses a signature made with another secret', () => {
    const header = signPayload(BODY, OTHER, NOW);
    expect(verifySignature(BODY, header, SECRET, 300, NOW)).toBe(false);
  });

  it('refuses a body that was altered after signing', () => {
    const header = signPayload(BODY, SECRET, NOW);
    expect(verifySignature(`${BODY} `, header, SECRET, 300, NOW)).toBe(false);
    expect(verifySignature('', header, SECRET, 300, NOW)).toBe(false);
  });

  it('refuses a timestamp outside the tolerance, in either direction', () => {
    const header = signPayload(BODY, SECRET, NOW);
    expect(verifySignature(BODY, header, SECRET, 300, NOW + 300)).toBe(true);
    expect(verifySignature(BODY, header, SECRET, 300, NOW + 301)).toBe(false);
    expect(verifySignature(BODY, header, SECRET, 300, NOW - 300)).toBe(true);
    expect(verifySignature(BODY, header, SECRET, 300, NOW - 301)).toBe(false);
  });

  it('will not accept a replay under a timestamp the sender never signed', () => {
    // Moving `t` forward to get back inside the tolerance changes the signed payload, so the
    // signature no longer matches. That is the whole reason `t` is inside the HMAC.
    const header = signPayload(BODY, SECRET, NOW - 10_000);
    const forged = header.replace(`t=${String(NOW - 10_000)}`, `t=${String(NOW)}`);
    expect(verifySignature(BODY, forged, SECRET, 300, NOW)).toBe(false);
  });

  it('defaults to five minutes of tolerance', () => {
    expect(DEFAULT_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    const now = Math.floor(Date.now() / 1000);
    const header = signPayload(BODY, SECRET, now - 299);
    expect(verifySignature(BODY, header, SECRET)).toBe(true);
    const old = signPayload(BODY, SECRET, now - 400);
    expect(verifySignature(BODY, old, SECRET)).toBe(false);
  });

  it('accepts either secret while one is being rotated', () => {
    const oldSignature = computeSignature(BODY, SECRET, NOW);
    const newSignature = computeSignature(BODY, OTHER, NOW);
    const header = `t=${String(NOW)},v1=${oldSignature},v1=${newSignature}`;
    expect(verifySignature(BODY, header, SECRET, 300, NOW)).toBe(true);
    expect(verifySignature(BODY, header, OTHER, 300, NOW)).toBe(true);
    expect(verifySignature(BODY, header, 'whsec_third', 300, NOW)).toBe(false);
  });

  it('ignores a scheme it does not know, so a future v2 is not a rejection', () => {
    const header = `t=${String(NOW)},v1=${computeSignature(BODY, SECRET, NOW)},v2=whatever`;
    expect(verifySignature(BODY, header, SECRET, 300, NOW)).toBe(true);
  });

  it('returns false, and never throws, on a malformed header', () => {
    const cases: (string | null | undefined)[] = [
      '',
      'nonsense',
      't=',
      'v1=deadbeef',
      `t=${String(NOW)}`,
      `v1=${computeSignature(BODY, SECRET, NOW)}`,
      `t=abc,v1=${computeSignature(BODY, SECRET, NOW)}`,
      `t=${String(NOW)},t=${String(NOW)},v1=${computeSignature(BODY, SECRET, NOW)}`,
      `t=${String(NOW)},v1=tooshort`,
      `t=${String(NOW)},v1=${'z'.repeat(64)}`,
      `t=${String(NOW)};v1=${computeSignature(BODY, SECRET, NOW)}`,
      null,
      undefined,
    ];
    for (const header of cases) {
      expect(() => verifySignature(BODY, header, SECRET, 300, NOW)).not.toThrow();
      expect(verifySignature(BODY, header, SECRET, 300, NOW), String(header)).toBe(false);
    }
  });

  it('refuses an empty secret and a negative tolerance', () => {
    const header = signPayload(BODY, SECRET, NOW);
    expect(verifySignature(BODY, header, '', 300, NOW)).toBe(false);
    expect(verifySignature(BODY, header, SECRET, -1, NOW)).toBe(false);
  });

  it('parses a header into its timestamp and its signatures', () => {
    const one = computeSignature(BODY, SECRET, NOW);
    const two = computeSignature(BODY, OTHER, NOW);
    expect(parseSignatureHeader(`t=${String(NOW)},v1=${one.toUpperCase()},v1=${two}`)).toEqual({
      timestamp: NOW,
      signatures: [one, two],
    });
    expect(parseSignatureHeader('garbage')).toBeNull();
  });

  it('is case insensitive on the hex, because a receiver may upper case it', () => {
    const header = `t=${String(NOW)},v1=${computeSignature(BODY, SECRET, NOW).toUpperCase()}`;
    expect(verifySignature(BODY, header, SECRET, 300, NOW)).toBe(true);
  });

  it('tolerates the spaces a header rewriter may insert around the parts', () => {
    const header = `t=${String(NOW)} , v1=${computeSignature(BODY, SECRET, NOW)}`;
    expect(verifySignature(BODY, header, SECRET, 300, NOW)).toBe(true);
  });
});

/**
 * The promise the package makes about itself.
 *
 * "Zero runtime dependencies" is the reason the CLI can depend on it and the reason a customer
 * can install it next to whatever else they run. A `dependencies` block added in a hurry would
 * break that promise without breaking a single test, so this one reads the manifest.
 */
describe('the package itself', () => {
  it('has no runtime dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
  });

  it('keeps `buildSignatureHeader` as the alias the delivery worker imports', () => {
    expect(buildSignatureHeader).toBe(signPayload);
  });
});
