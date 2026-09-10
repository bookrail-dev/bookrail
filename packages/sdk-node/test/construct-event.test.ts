/**
 * `webhooks.constructEvent`, on payloads signed here.
 *
 * The integration suite does the same thing against a signature the **real** dispatcher
 * produced; this file covers the shapes a hostile or broken sender can put on the wire.
 */
import { signPayload } from '@bookrail/webhook-signature';
import { describe, expect, it } from 'vitest';
import Bookrail, { BookrailError, BookrailSignatureVerificationError } from '../src/index.js';

const bookrail = new Bookrail('sk_test_0123456789abcdef');
const SECRET = 'whsec_0123456789abcdef0123456789abcdef';
const BODY = JSON.stringify({
  id: 'evt_1',
  object: 'event',
  type: 'booking.created',
  data: { object: { id: 'bk_1' }, previous: null },
});

function header(body = BODY, secret = SECRET, at = Math.floor(Date.now() / 1000)): string {
  return signPayload(body, secret, at);
}

describe('constructEvent', () => {
  it('returns the typed event for a valid signature', () => {
    const event = bookrail.webhooks.constructEvent(BODY, header(), SECRET);
    expect(event.id).toBe('evt_1');
    expect(event.type).toBe('booking.created');
  });

  it('accepts the raw bytes as a Uint8Array, which a Buffer is', () => {
    const event = bookrail.webhooks.constructEvent(Buffer.from(BODY, 'utf8'), header(), SECRET);
    expect(event.id).toBe('evt_1');
  });

  it('throws on a signature made with another secret', () => {
    expect(() =>
      bookrail.webhooks.constructEvent(BODY, header(BODY, 'whsec_other'), SECRET),
    ).toThrow(BookrailSignatureVerificationError);
  });

  it('throws when the payload was re-serialised instead of kept raw', () => {
    const signature = header();
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(() => bookrail.webhooks.constructEvent(reserialised, signature, SECRET)).toThrow(
      BookrailSignatureVerificationError,
    );
  });

  it('throws when the timestamp is outside the tolerance, and accepts it when widened', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const signature = header(BODY, SECRET, old);
    expect(() => bookrail.webhooks.constructEvent(BODY, signature, SECRET)).toThrow(
      BookrailSignatureVerificationError,
    );
    expect(bookrail.webhooks.constructEvent(BODY, signature, SECRET, 7200).id).toBe('evt_1');
  });

  it('throws on a malformed, empty or absent header rather than crashing', () => {
    for (const value of ['', 'garbage', 't=abc,v1=zz', 'v1=deadbeef', null, undefined]) {
      expect(() => bookrail.webhooks.constructEvent(BODY, value, SECRET)).toThrow(
        BookrailSignatureVerificationError,
      );
    }
  });

  it('carries the payload and the header it refused, for the receiver’s log', () => {
    try {
      bookrail.webhooks.constructEvent(BODY, 'garbage', SECRET);
      expect.unreachable();
    } catch (error) {
      const thrown = error as BookrailSignatureVerificationError;
      expect(thrown).toBeInstanceOf(BookrailError);
      expect(thrown.type).toBe('signature_verification');
      expect(thrown.payload).toBe(BODY);
      expect(thrown.header).toBe('garbage');
    }
  });

  it('accepts a header carrying several v1 values, as a rotation would send', () => {
    const at = Math.floor(Date.now() / 1000);
    const mine = signPayload(BODY, SECRET, at);
    const other = signPayload(BODY, 'whsec_rotating', at).split(',')[1]!;
    expect(bookrail.webhooks.constructEvent(BODY, `${mine},${other}`, SECRET).id).toBe('evt_1');
  });

  it('distinguishes a body that verified but is not JSON from a forgery', () => {
    const body = 'signed, but not JSON';
    try {
      bookrail.webhooks.constructEvent(body, header(body), SECRET);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BookrailError);
      expect(error).not.toBeInstanceOf(BookrailSignatureVerificationError);
      expect((error as BookrailError).message).toContain('not JSON');
    }
  });
});
