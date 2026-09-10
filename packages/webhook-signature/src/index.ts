/**
 * `@bookrail/webhook-signature`: signing a webhook delivery and verifying one, both halves of
 * the scheme, in a package of its own.
 *
 * ```
 * Bookrail-Signature: t=1789012345,v1=6f1c…
 * ```
 *
 * `v1` is `HMAC-SHA256(secret, "<t>.<raw body>")`, hex encoded. The timestamp is **inside** the
 * signed payload on purpose: without it a signature is valid forever, and an attacker who
 * captured one delivery could replay it at any point in the future and the receiver would have
 * no way to tell. With it, a receiver that also checks the age of `t` has a bounded window.
 *
 * The body is signed as the **bytes that were sent**, not as a re-serialised object. Two JSON
 * encoders disagree about key order and about whitespace, so a receiver that parses the body
 * and re-encodes it before verifying will fail on a payload that is perfectly valid. Every
 * example in the documentation therefore passes the raw text.
 *
 * ## Why this is a package and not a file
 *
 * It is the one piece of Bookrail that runs on **the customer's** machine: the SDKs re-export
 * {@link verifySignature} and it is the function a receiver actually calls. So it has no
 * dependency beyond `node:crypto`, it never throws on malformed input (a receiver handling a
 * hostile request must get `false`, not an exception it forgot to catch), and it compares in
 * constant time.
 *
 * It used to live in `packages/shared` **and** in a forty-line copy inside
 * `packages/cli/src/commands/listen.ts`, because the CLI publishes on its own and could not
 * depend on the server's grab-bag package. Two implementations of one verifier is one
 * implementation too many: a receiver that accepts a delivery the sender did not sign, or
 * refuses one it did, is a security bug either way, and the copy was there only because
 * `@bookrail/shared` is too big to install for thirty-two bytes. So the verifier moved here:
 * zero runtime dependencies, publishable on its own, imported by `@bookrail/shared` (which
 * re-exports it, so every server-side import path is unchanged), by the CLI, and, when they
 * exist, by the SDKs.
 *
 * ## Rotation
 *
 * A header may carry **several** `v1=` values. That is how a secret is rotated without a
 * window in which deliveries fail: the sender signs with the old secret and the new one for the
 * length of the rollover, and a receiver holding either of the two accepts. {@link
 * verifySignature} therefore checks the given secret against every `v1` present and accepts if
 * any matches. Bookrail does not rotate secrets yet (one secret per webhook endpoint, shown
 * once), but the verifier a customer deploys today has to keep working on the day
 * it starts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header name. Sent by the delivery worker, read by the receiver. */
export const SIGNATURE_HEADER = 'Bookrail-Signature';

/** Header carrying the id of the event a delivery is about (`evt_…`). */
export const EVENT_ID_HEADER = 'Bookrail-Event-Id';

/** Header carrying the id of the webhook endpoint a delivery was sent to (`wh_…`). */
export const WEBHOOK_ID_HEADER = 'Bookrail-Webhook-Id';

/** Header carrying the id of the delivery attempt row (`whd_…`), for support requests. */
export const DELIVERY_ID_HEADER = 'Bookrail-Delivery-Id';

/**
 * How far the timestamp of a delivery may be from the receiver's clock, in seconds.
 *
 * Five minutes: wide enough for a receiver whose clock drifts and for a delivery that queued
 * behind a slow retry, narrow enough that a captured request is not replayable tomorrow.
 */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The only signature scheme. A `v2` would be added next to it, never in place of it. */
export const SIGNATURE_SCHEME = 'v1';

/** What the HMAC is computed over: the timestamp, a dot, and the exact bytes of the body. */
export function signaturePayload(timestampSeconds: number, body: string): string {
  return `${String(timestampSeconds)}.${body}`;
}

/** `HMAC-SHA256(secret, "<t>.<body>")`, hex. */
export function computeSignature(body: string, secret: string, timestampSeconds: number): string {
  return createHmac('sha256', secret)
    .update(signaturePayload(timestampSeconds, body), 'utf8')
    .digest('hex');
}

/**
 * The full `Bookrail-Signature` header value for one secret: `t=…,v1=…`.
 *
 * The signing half of the pair {@link verifySignature} completes. A customer needs it far less
 * often than the verifier (to sign a fixture in their own test suite, mostly), but a package
 * that could only check signatures would force everyone who tests a receiver to write the HMAC
 * by hand, which is exactly the code this package exists to stop people writing.
 */
export function signPayload(body: string, secret: string, timestampSeconds: number): string {
  return `t=${String(timestampSeconds)},${SIGNATURE_SCHEME}=${computeSignature(body, secret, timestampSeconds)}`;
}

/**
 * @deprecated The name this function had while it lived in `@bookrail/shared`. Kept as an
 * alias because the delivery worker imports it and renaming a call site buys nothing;
 * new code calls {@link signPayload}.
 */
export const buildSignatureHeader = signPayload;

export interface ParsedSignature {
  /** Unix seconds the sender stamped the delivery with. */
  readonly timestamp: number;
  /** Every `v1=` value in the header, in the order they appeared. At least one. */
  readonly signatures: readonly string[];
}

/**
 * Splits a header into its timestamp and its signatures, or returns `null`.
 *
 * Deliberately strict about the two things that matter (there must be exactly one `t`, and it
 * must be an integer number of seconds) and deliberately tolerant about everything else:
 * unknown keys are ignored so that a future `v2=` does not make a `v1`-only receiver reject a
 * delivery it can perfectly well verify.
 */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 4096) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      // A second `t` is not a header this code has ever produced, and accepting it would mean
      // choosing which of two timestamps to trust.
      if (timestamp !== null) return null;
      if (!/^\d{1,15}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === SIGNATURE_SCHEME) {
      if (!/^[0-9a-f]{64}$/i.test(value)) return null;
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Constant time comparison of two strings of equal length; unequal lengths are simply false. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Is this body really from Bookrail, and recent?
 *
 * @param body the **raw** request body, exactly as received.
 * @param header the value of `Bookrail-Signature`. `null` or `undefined` is `false`, not a throw.
 * @param secret the endpoint's signing secret, as shown once at creation (`whsec_…`).
 * @param toleranceSeconds how old `t` may be, in seconds. Five minutes by default.
 * @param nowSeconds the current instant, so a test does not have to wait for one.
 *
 * Returns a boolean and never throws: a receiver is by definition handling input from the
 * network, and a verifier that throws on a malformed header would turn a forged request into a
 * 500 instead of a 400.
 */
export function verifySignature(
  body: string,
  header: string | null | undefined,
  secret: string,
  toleranceSeconds: number = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (typeof body !== 'string' || typeof secret !== 'string' || secret.length === 0) return false;
  if (header === null || header === undefined) return false;
  const parsed = parseSignatureHeader(header);
  if (parsed === null) return false;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) return false;
  // Both directions: a timestamp from the future is as much a sign of something wrong as one
  // from last week, and clock skew is symmetric.
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) return false;

  const expected = computeSignature(body, secret, parsed.timestamp);
  // Every candidate is compared, with no early exit: the number of comparisons then does not
  // depend on which one matched.
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (constantTimeEquals(candidate, expected)) matched = true;
  }
  return matched;
}
