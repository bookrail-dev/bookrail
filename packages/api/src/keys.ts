import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Environment } from '@bookrail/shared';

export type ApiKeyKind = 'secret' | 'publishable';

const KIND_PREFIX: Record<ApiKeyKind, string> = { secret: 'sk', publishable: 'pk' };

/** How many characters of the random body we keep in clear text, for lookup and display. */
export const PREFIX_LENGTH = 8;

/** `sk_test_<43 base64url characters>`: 32 bytes = 256 bits of entropy. */
const KEY_RE = /^(sk|pk)_(test|live)_([A-Za-z0-9_-]{22,64})$/;

export interface GeneratedApiKey {
  /** The only time the plaintext exists. Returned once, never stored. */
  key: string;
  prefix: string;
  keyHash: string;
  kind: ApiKeyKind;
  environment: Environment;
}

export function generateApiKey(
  environment: Environment,
  kind: ApiKeyKind = 'secret',
): GeneratedApiKey {
  const body = randomBytes(32).toString('base64url');
  const key = `${KIND_PREFIX[kind]}_${environment}_${body}`;
  return {
    key,
    prefix: body.slice(0, PREFIX_LENGTH),
    keyHash: hashApiKey(key),
    kind,
    environment,
  };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export interface ParsedApiKey {
  kind: ApiKeyKind;
  environment: Environment;
  prefix: string;
  keyHash: string;
}

export function parseApiKey(key: string): ParsedApiKey | null {
  const match = KEY_RE.exec(key);
  if (!match) return null;
  const [, kindPart, envPart, body] = match as unknown as [string, string, Environment, string];
  return {
    kind: kindPart === 'pk' ? 'publishable' : 'secret',
    environment: envPart,
    prefix: body.slice(0, PREFIX_LENGTH),
    keyHash: hashApiKey(key),
  };
}

/** Constant-time comparison for the bootstrap token. */
export function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
