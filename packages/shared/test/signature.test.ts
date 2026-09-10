/**
 * The re-export, not the algorithm.
 *
 * The signature itself is tested in `@bookrail/webhook-signature`, which is where it lives
 * now. What has to be checked *here* is that `@bookrail/shared` still hands out
 * the same functions under the same names: `packages/api/src/webhooks/deliver.ts` signs every
 * delivery with `buildSignatureHeader` imported from this package, and a re-export that
 * silently stopped covering one name would be a compile error there and nothing at all here.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSignatureHeader,
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  signPayload,
  verifySignature,
} from '../src/index.js';
import * as pkg from '@bookrail/webhook-signature';

const SECRET = 'whsec_c9f3a1d0e2b74c5f8a6d3b1e0f7c2a94';
const BODY = JSON.stringify({ id: 'evt_1', type: 'booking.confirmed' });
const NOW = 1_789_012_345;

describe('@bookrail/shared re-exports the webhook signature', () => {
  it('hands out the same function objects as the package', () => {
    expect(verifySignature).toBe(pkg.verifySignature);
    expect(signPayload).toBe(pkg.signPayload);
    // The name the delivery worker still imports. Same function, so it cannot drift.
    expect(buildSignatureHeader).toBe(pkg.signPayload);
  });

  it('signs and verifies through the re-export', () => {
    const header = buildSignatureHeader(BODY, SECRET, NOW);
    expect(verifySignature(BODY, header, SECRET, DEFAULT_SIGNATURE_TOLERANCE_SECONDS, NOW)).toBe(
      true,
    );
    expect(verifySignature(BODY, header, 'whsec_wrong', 300, NOW)).toBe(false);
  });

  it('re-exports the header names the delivery worker sets', () => {
    expect(SIGNATURE_HEADER).toBe('Bookrail-Signature');
  });
});
