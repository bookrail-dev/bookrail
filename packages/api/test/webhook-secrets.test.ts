/**
 * The webhook signing secret at rest: AES-256-GCM, a fresh IV, and the endpoint's own id as
 * additional authenticated data.
 *
 * Encrypted rather than hashed, because unlike an API key this secret has to be **produced**
 * again on every delivery. The AAD is the part worth testing: it is what makes a ciphertext
 * non-transplantable, so a row copied from one endpoint to another fails to decrypt instead of
 * quietly signing somebody else's deliveries.
 */
import { describe, expect, it } from 'vitest';
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  parseWebhookSecretKey,
  WEBHOOK_SECRET_BYTES,
} from '../src/webhooks/secrets.js';

const KEY = Buffer.alloc(32, 0x11);
const OTHER_KEY = Buffer.alloc(32, 0x22);
const ID = '0193f0c2-a1b4-7e2e-9a1c-0f4d5e6a7b8c';

describe('webhook secrets', () => {
  it('mints 256 bits of entropy behind a recognisable prefix', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]+$/);
    expect(Buffer.from(secret.slice('whsec_'.length), 'base64url')).toHaveLength(
      WEBHOOK_SECRET_BYTES,
    );
    expect(generateWebhookSecret()).not.toBe(secret);
  });

  it('round trips, with a different ciphertext every time', () => {
    const secret = generateWebhookSecret();
    const first = encryptWebhookSecret(secret, KEY, ID);
    const second = encryptWebhookSecret(secret, KEY, ID);
    expect(first).not.toBe(second);
    expect(first.startsWith('v1.')).toBe(true);
    expect(first).not.toContain(secret);
    expect(decryptWebhookSecret(first, KEY, ID)).toBe(secret);
    expect(decryptWebhookSecret(second, KEY, ID)).toBe(secret);
  });

  it('refuses another key, another endpoint, and a tampered envelope', () => {
    const secret = generateWebhookSecret();
    const envelope = encryptWebhookSecret(secret, KEY, ID);
    expect(() => decryptWebhookSecret(envelope, OTHER_KEY, ID)).toThrow();
    expect(() =>
      decryptWebhookSecret(envelope, KEY, '00000000-0000-0000-0000-000000000000'),
    ).toThrow();

    const parts = envelope.split('.');
    const flipped = Buffer.from(parts[3] ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() =>
      decryptWebhookSecret(
        `${parts[0]}.${parts[1]}.${parts[2]}.${flipped.toString('base64url')}`,
        KEY,
        ID,
      ),
    ).toThrow();

    for (const bad of ['', 'nonsense', 'v1.a.b', 'v2.a.b.c', `v1..${parts[2]}.${parts[3]}`]) {
      expect(() => decryptWebhookSecret(bad, KEY, ID), bad).toThrow();
    }
  });

  it('reads the key from hex or base64, and refuses anything that is not 32 bytes', () => {
    expect(parseWebhookSecretKey(undefined)).toBeUndefined();
    expect(parseWebhookSecretKey('   ')).toBeUndefined();
    expect(parseWebhookSecretKey(KEY.toString('hex'))).toEqual(KEY);
    expect(parseWebhookSecretKey(KEY.toString('base64'))).toEqual(KEY);
    expect(parseWebhookSecretKey(` ${KEY.toString('base64')} `)).toEqual(KEY);
    expect(() => parseWebhookSecretKey('too-short')).toThrow(/32 bytes/);
    expect(() => parseWebhookSecretKey('ab'.repeat(64))).toThrow(/32 bytes/);
  });
});
