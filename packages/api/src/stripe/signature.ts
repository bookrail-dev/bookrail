/**
 * Verifying a `Stripe-Signature` header, in thirty lines of `node:crypto` and no dependency.
 *
 * ```
 * Stripe-Signature: t=1789012345,v1=6f1c…,v1=9ab2…
 * ```
 *
 * `v1` is `HMAC-SHA256(secret, "<t>.<raw body>")`, hex. It is the same construction Bookrail
 * signs its own outgoing deliveries with (`@bookrail/webhook-signature`), read in the opposite
 * direction, and the two files deliberately look alike: a reader who has understood one has
 * understood both, and the symmetry is the argument that the outgoing scheme is the ordinary
 * one rather than something invented here.
 *
 * ## Three things this gets right, and each of them is the whole point
 *
 * **The bytes, not the object.** The HMAC is computed over the body exactly as it arrived. Two
 * JSON encoders disagree about key order and whitespace, so a receiver that parses and
 * re-serialises before verifying rejects payloads that are perfectly valid. `routes/
 * stripe-webhook.ts` therefore calls `c.req.arrayBuffer()` before anything else and hands the
 * bytes here; nothing between the socket and this function is allowed to normalise them, the
 * decoding to text included.
 *
 * **The timestamp is inside the signed payload.** Without it a captured request is replayable
 * for ever. With it, and with {@link DEFAULT_TOLERANCE_SECONDS}, a request from last week is
 * refused whatever its signature says. The window is checked in **both** directions: a
 * timestamp from the future is as much a sign of something wrong as one from the past, and
 * clock skew is symmetric.
 *
 * **Constant time.** `timingSafeEqual`, and every candidate signature is compared with no early
 * exit, so the number of comparisons does not depend on which one matched. A verifier that
 * returned as soon as it found a match would leak, through timing, how many signatures were in
 * the header and where the right one was.
 *
 * ## Why several `v1` values
 *
 * Stripe sends more than one while a webhook signing secret is being rotated: the endpoint is
 * signed with the old secret and the new one for the length of the rollover, and a receiver
 * holding either accepts. So the header is a list, and this function accepts if **any** entry
 * matches the secret it was given. Bookrail holds one secret per mode today; the verifier has
 * to keep working on the day that changes, and that day is a dashboard setting rather than a
 * deployment.
 *
 * Nothing here ever throws. The input is a request from the public internet, and a verifier
 * that threw on a malformed header would turn a forged request into a 500 instead of a 400.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The header Stripe sends. Matched case insensitively, like every HTTP header name. */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

/**
 * How far `t` may be from our own clock, in seconds.
 *
 * Five minutes, which is Stripe's own recommendation and the same number
 * `@bookrail/webhook-signature` asks of the receivers of our deliveries. Wide enough for a
 * server whose clock drifts and for an event that queued behind a slow retry, narrow enough
 * that a captured request is not replayable tomorrow.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** The only scheme Stripe sends today. A `v2` would be added beside it, never in place of it. */
const SCHEME = 'v1';

export interface ParsedStripeSignature {
  /** Unix seconds, as the sender stamped it. */
  readonly timestamp: number;
  /** Every `v1=` value, lower cased, in the order they appeared. At least one. */
  readonly signatures: readonly string[];
}

/**
 * Splits the header into its timestamp and its signatures, or `null`.
 *
 * Strict about the two things that matter, tolerant about everything else: there must be
 * exactly one `t` and it must be an integer number of seconds, and unknown keys are skipped so
 * that a future scheme does not make this refuse a delivery it can perfectly well verify. A
 * second `t` is refused rather than resolved: it would mean choosing which of two timestamps to
 * trust, and there is no right answer.
 */
export function parseStripeSignature(
  header: string | null | undefined,
): ParsedStripeSignature | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 4096) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      if (timestamp !== null) return null;
      if (!/^\d{1,15}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === SCHEME) {
      if (!/^[0-9a-f]{64}$/i.test(value)) return null;
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * `HMAC-SHA256(secret, "<t>.<body>")`, hex. Exported so a test can build a valid header.
 *
 * `body` is a `Buffer` wherever the real bytes are available, and the digest is then taken over
 * those bytes rather than over a decoded string. The two agree for every valid UTF-8 payload,
 * which is all Stripe ever sends; they stop agreeing the moment a byte is not valid UTF-8,
 * because decoding replaces it with U+FFFD and quietly changes what is being signed. Accepting
 * a `Buffer` is what makes the sentence at the top of this file true to the letter.
 */
export function computeStripeSignature(
  body: string | Buffer,
  secret: string,
  timestampSeconds: number,
): string {
  return createHmac('sha256', secret)
    .update(`${String(timestampSeconds)}.`, 'utf8')
    .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    .digest('hex');
}

/** The whole header value for one secret. Only a test builds one; Stripe builds the real ones. */
export function signStripePayload(
  body: string | Buffer,
  secret: string,
  timestampSeconds: number,
): string {
  return `t=${String(timestampSeconds)},${SCHEME}=${computeStripeSignature(body, secret, timestampSeconds)}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Is this body really from Stripe, and recent?
 *
 * @param body the **raw** request body, exactly as received: the bytes, when the caller has them.
 * @param header the value of `Stripe-Signature`. `null` and `undefined` are `false`, never a throw.
 * @param secret the endpoint's signing secret, `whsec_...`, from the environment.
 * @param nowSeconds the current instant, injected so a test never has to wait for one.
 * @param toleranceSeconds how far `t` may be from `nowSeconds`.
 */
export function verifyStripeSignature(options: {
  body: string | Buffer;
  header: string | null | undefined;
  secret: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  const { body, header, secret } = options;
  const bodyIsBytes = typeof body === 'string' || Buffer.isBuffer(body);
  if (!bodyIsBytes || typeof secret !== 'string' || secret.length === 0) return false;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isFinite(tolerance) || tolerance < 0) return false;
  if (!Number.isFinite(options.nowSeconds)) return false;
  const parsed = parseStripeSignature(header);
  if (parsed === null) return false;
  if (Math.abs(options.nowSeconds - parsed.timestamp) > tolerance) return false;

  const expected = computeStripeSignature(body, secret, parsed.timestamp);
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (constantTimeEquals(candidate, expected)) matched = true;
  }
  return matched;
}
