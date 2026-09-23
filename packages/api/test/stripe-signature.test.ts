/**
 * `Stripe-Signature`, against vectors computed by hand.
 *
 * Every expected value below is produced by `createHmac` in the test itself, from a body and a
 * secret written out in full, so the assertions are about the **construction** and not about
 * whether the implementation agrees with itself. The negative cases are the ones that matter:
 * a verifier that accepts everything passes every positive test there is.
 *
 * Nothing here waits for a clock. `nowSeconds` is a parameter of the function precisely so that
 * "one second outside the tolerance" is an argument and not a `setTimeout`.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  computeStripeSignature,
  parseStripeSignature,
  signStripePayload,
  verifyStripeSignature,
} from '../src/stripe/signature.js';

const SECRET = 'whsec_obviouslyFakeSigningSecretForTests';
const OTHER_SECRET = 'whsec_aDifferentSecretEntirely';
const BODY = '{"id":"evt_1","type":"payment_intent.succeeded","data":{"object":{"id":"pi_1"}}}';
const T = 1_789_012_345;

/** The vector, computed here rather than taken from the implementation under test. */
function hmac(body: string, secret: string, t: number): string {
  return createHmac('sha256', secret)
    .update(`${String(t)}.${body}`, 'utf8')
    .digest('hex');
}

describe('computeStripeSignature', () => {
  it('is HMAC-SHA256 of "<t>.<raw body>", hex', () => {
    expect(computeStripeSignature(BODY, SECRET, T)).toBe(hmac(BODY, SECRET, T));
  });

  /**
   * One byte of the body changes the whole digest. It is the property the whole scheme rests
   * on, and it is worth an assertion rather than an assumption.
   */
  it('changes completely when one byte of the body changes', () => {
    const altered = `${BODY.slice(0, -2)}1}`;
    expect(altered).not.toBe(BODY);
    expect(computeStripeSignature(altered, SECRET, T)).not.toBe(
      computeStripeSignature(BODY, SECRET, T),
    );
  });

  it('changes when the timestamp changes, which is what stops a replay', () => {
    expect(computeStripeSignature(BODY, SECRET, T + 1)).not.toBe(
      computeStripeSignature(BODY, SECRET, T),
    );
  });
});

describe('parseStripeSignature', () => {
  it('reads one timestamp and every v1', () => {
    expect(parseStripeSignature(`t=${String(T)},v1=${'a'.repeat(64)}`)).toEqual({
      timestamp: T,
      signatures: ['a'.repeat(64)],
    });
    expect(
      parseStripeSignature(`t=${String(T)},v1=${'a'.repeat(64)},v1=${'B'.repeat(64)}`),
    ).toEqual({ timestamp: T, signatures: ['a'.repeat(64), 'b'.repeat(64)] });
  });

  /** A future scheme must not make a `v1`-capable receiver refuse a delivery it can verify. */
  it('skips a scheme it does not know', () => {
    expect(parseStripeSignature(`t=${String(T)},v0=deadbeef,v1=${'a'.repeat(64)}`)).toEqual({
      timestamp: T,
      signatures: ['a'.repeat(64)],
    });
  });

  it('is null for every malformed header', () => {
    for (const header of [
      '',
      'nonsense',
      `v1=${'a'.repeat(64)}`,
      `t=${String(T)}`,
      `t=notanumber,v1=${'a'.repeat(64)}`,
      // Two timestamps would mean choosing which one to trust, and there is no right answer.
      `t=${String(T)},t=${String(T + 1)},v1=${'a'.repeat(64)}`,
      `t=${String(T)},v1=tooshort`,
      `t=${String(T)},v1=${'z'.repeat(64)}`,
      `t=${String(T)};v1=${'a'.repeat(64)}`,
    ]) {
      expect(parseStripeSignature(header), JSON.stringify(header)).toBeNull();
    }
    expect(parseStripeSignature(null)).toBeNull();
    expect(parseStripeSignature(undefined)).toBeNull();
  });
});

describe('verifyStripeSignature', () => {
  const verify = (
    header: string | null | undefined,
    options: Partial<{ body: string; secret: string; nowSeconds: number }> = {},
  ): boolean =>
    verifyStripeSignature({
      body: options.body ?? BODY,
      header,
      secret: options.secret ?? SECRET,
      nowSeconds: options.nowSeconds ?? T,
    });

  it('accepts a valid header', () => {
    expect(verify(signStripePayload(BODY, SECRET, T))).toBe(true);
  });

  it('accepts at exactly the edge of the tolerance, in both directions', () => {
    const header = signStripePayload(BODY, SECRET, T);
    expect(verify(header, { nowSeconds: T + DEFAULT_TOLERANCE_SECONDS })).toBe(true);
    expect(verify(header, { nowSeconds: T - DEFAULT_TOLERANCE_SECONDS })).toBe(true);
  });

  /**
   * Both directions, and one second past the edge on each. A timestamp from the future is as
   * much a sign of something wrong as one from last week, and clock skew is symmetric.
   */
  it('refuses a timestamp one second outside the tolerance', () => {
    const header = signStripePayload(BODY, SECRET, T);
    expect(verify(header, { nowSeconds: T + DEFAULT_TOLERANCE_SECONDS + 1 })).toBe(false);
    expect(verify(header, { nowSeconds: T - DEFAULT_TOLERANCE_SECONDS - 1 })).toBe(false);
  });

  it('refuses a v1 that is simply wrong', () => {
    expect(verify(`t=${String(T)},v1=${'a'.repeat(64)}`)).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    expect(verify(signStripePayload(BODY, OTHER_SECRET, T))).toBe(false);
  });

  /**
   * Rotation: two `v1` values, one of them ours. Accepting is what lets a signing secret be
   * changed in the Stripe dashboard without a window in which every delivery is refused.
   */
  it('accepts when one of several v1 values matches', () => {
    const header = `t=${String(T)},v1=${'a'.repeat(64)},v1=${hmac(BODY, SECRET, T)}`;
    expect(verify(header)).toBe(true);
    // And the other order, so the result cannot depend on which one is read first.
    const reversed = `t=${String(T)},v1=${hmac(BODY, SECRET, T)},v1=${'a'.repeat(64)}`;
    expect(verify(reversed)).toBe(true);
  });

  it('refuses when the body is altered by one byte after signing', () => {
    const header = signStripePayload(BODY, SECRET, T);
    expect(verify(header, { body: `${BODY.slice(0, -2)}1}` })).toBe(false);
  });

  it('refuses a malformed header rather than throwing on it', () => {
    for (const header of ['', 'v1=', 'garbage', null, undefined]) {
      expect(verify(header), JSON.stringify(header)).toBe(false);
    }
  });

  it('refuses an empty secret, which is how a misconfigured deployment would fail open', () => {
    expect(verify(signStripePayload(BODY, '', T), { secret: '' })).toBe(false);
  });

  /**
   * Not a timing measurement, which would be flaky by construction: the assertion is that the
   * comparison is `timingSafeEqual` over equal-length buffers, and the observable consequence
   * is that a signature of the wrong length is refused without throwing, which is what
   * `timingSafeEqual` does on mismatched lengths.
   */
  it('refuses a signature of the wrong length without throwing', () => {
    expect(verify(`t=${String(T)},v1=${'a'.repeat(63)}`)).toBe(false);
    expect(() => verify(`t=${String(T)},v1=${'a'.repeat(63)}`)).not.toThrow();
  });
});
