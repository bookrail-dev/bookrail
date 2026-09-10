/**
 * The signing secret of a webhook endpoint: how it is minted, how it is stored, and why it is
 * stored at all.
 *
 * ## Encrypted, not hashed
 *
 * Every other secret in Bookrail is hashed: an API key is checked, never reproduced, so the
 * database holds a SHA-256 and nothing else. A webhook secret is the opposite kind of secret.
 * The delivery worker has to **produce** an HMAC with it on every attempt, so the plaintext has
 * to come back: a hash would make the signature uncomputable. That settles how it is stored, and
 * it is not stored in the clear either: application level encryption on top of the encrypted
 * disk, with a key that lives in the environment (`WEBHOOK_SECRET_KEY`) and not in the database,
 * so a dump of the database is not a dump of the secrets.
 *
 * ## The envelope
 *
 * ```
 * v1.<iv base64url>.<auth tag base64url>.<ciphertext base64url>
 * ```
 *
 * AES-256-GCM, a fresh 96 bit IV per encryption, and the **webhook's own id as additional
 * authenticated data**. The AAD is what makes a ciphertext non-transplantable: a row copied
 * from one webhook to another (by a bug, by a restore of the wrong backup, by somebody with
 * `UPDATE` on the table) fails to decrypt instead of quietly signing another endpoint's
 * deliveries with a secret its owner still believes is private.
 *
 * The version prefix exists so that a second algorithm can be introduced without guessing:
 * `v2.` would be read by a decoder that knows both and refused by one that does not.
 *
 * ## Never in a log
 *
 * Neither the plaintext nor the key is ever passed to the logger. The only place the plaintext
 * leaves this process is the body of `POST /v1/webhooks`, once, and the `Bookrail-Signature`
 * header, where it appears only as an HMAC.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { errors } from '@bookrail/shared';

/** Public prefix, so a leaked string is identifiable in a log somebody else wrote. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** 256 bits of entropy, the same as an API key. */
export const WEBHOOK_SECRET_BYTES = 32;

export const ENVELOPE_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A new signing secret. Shown to the customer once and never again. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url')}`;
}

/**
 * Reads `WEBHOOK_SECRET_KEY` into the 32 raw bytes AES-256 wants.
 *
 * Accepts base64, base64url or hex, because those are the three forms a secret manager hands
 * out and guessing wrong is a start-up failure rather than a silent weakening. Anything that
 * is not exactly 32 bytes throws: a shorter key would be padded or rejected by `createCipheriv`
 * in ways that depend on the algorithm, and a deployment must find out at boot.
 */
export function parseWebhookSecretKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  const decoded = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (decoded.length !== 32) {
    throw new Error(
      'WEBHOOK_SECRET_KEY must be 32 bytes, given as 64 hex characters or as base64. ' +
        `Got ${String(decoded.length)} bytes.`,
    );
  }
  return decoded;
}

/** The error every route and job raises when the deployment forgot the key. */
export function webhookKeyMissing(): Error {
  return errors.internal(
    'WEBHOOK_SECRET_KEY is not configured, so webhook secrets cannot be stored or used.',
  );
}

export function encryptWebhookSecret(plaintext: string, key: Buffer, webhookId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(webhookId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * The plaintext, or a throw.
 *
 * There is no "best effort" here on purpose: a secret that will not decrypt means the key
 * rotated without a re-encryption, or the row was moved. Signing with anything else would
 * produce deliveries the receiver rejects, which is a far more confusing failure than a loud
 * one.
 */
export function decryptWebhookSecret(envelope: string, key: Buffer, webhookId: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error(`Unrecognised webhook secret envelope for webhook ${webhookId}.`);
  }
  const iv = Buffer.from(parts[1] ?? '', 'base64url');
  const tag = Buffer.from(parts[2] ?? '', 'base64url');
  const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error(`Malformed webhook secret envelope for webhook ${webhookId}.`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(webhookId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
