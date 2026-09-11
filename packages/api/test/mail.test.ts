/**
 * The mailer, against a real SMTP conversation.
 *
 * `smtp-server` is a development dependency that speaks the protocol on loopback, so this test
 * proves what a mock could not: that `nodemailer` authenticates, that the envelope carries the
 * mailbox we configured and the address the caller asked for, and that the body that arrives is
 * the one the product wrote, link and all. No message leaves the machine, and nothing here
 * needs a mailbox to exist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { silentLogger } from '@bookrail/shared';
import { createLogMailer, createSmtpMailer, type Mailer } from '../src/mail/index.js';
import { confirmationLink, confirmationMessage } from '../src/mail/messages.js';

interface Received {
  from: string;
  to: string[];
  data: string;
}

/**
 * Undoes `quoted-printable`, which is what a compliant client uses for a plain text body: soft
 * line breaks (`=` at the end of a line) and `=XX` escapes. Reading the body without undoing it
 * would mean asserting on a wrapping that belongs to the encoder rather than to the message.
 */
function decodeQuotedPrintable(body: string): string {
  return body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

const USER = 'noreply@bookrail.dev';
const PASSWORD = 'a-test-password';

describe('the SMTP mailer', () => {
  const received: Received[] = [];
  let server: SMTPServer;
  let port: number;
  let mailer: Mailer;

  beforeAll(async () => {
    server = new SMTPServer({
      // No TLS on loopback in a test: the transport under test is the same one either way, and
      // a self signed certificate would only prove that we can ignore a certificate.
      secure: false,
      hideSTARTTLS: true,
      authOptional: false,
      onAuth(auth, _session, callback) {
        if (auth.username === USER && auth.password === PASSWORD) callback(null, { user: USER });
        else callback(new Error('bad credentials'));
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          received.push({
            from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
            data: Buffer.concat(chunks).toString('utf8'),
          });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.server.address() as AddressInfo).port;
    mailer = await createSmtpMailer({
      url: `smtp://${encodeURIComponent(USER)}:${PASSWORD}@127.0.0.1:${String(port)}`,
      from: `Bookrail <${USER}>`,
    });
  });

  afterAll(async () => {
    await mailer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers the confirmation to the address, from the mailbox, with the link', async () => {
    const message = confirmationMessage({
      to: 'ada@example.com',
      siteUrl: 'https://bookrail.dev',
      token: 'a-token-that-only-the-mailbox-sees',
    });
    await mailer.send(message);

    expect(received).toHaveLength(1);
    const sent = received[0];
    expect(sent?.from).toBe(USER);
    expect(sent?.to).toEqual(['ada@example.com']);
    const body = decodeQuotedPrintable(sent?.data ?? '');
    expect(body).toContain('Subject: Confirm your Bookrail test key');
    expect(body).toContain('To: ada@example.com');
    expect(body).toContain(`From: Bookrail <${USER}>`);
    // The token travels in the fragment, which no browser sends to a server.
    expect(body).toContain(
      'https://bookrail.dev/signup/confirm#token=a-token-that-only-the-mailbox-sees',
    );
    expect(body).toContain('This mailbox does not read replies. Questions: hello@bookrail.dev');
  });

  it('fails loudly when the credentials are wrong, rather than reporting success', async () => {
    const wrong = await createSmtpMailer({
      url: `smtp://${encodeURIComponent(USER)}:not-the-password@127.0.0.1:${String(port)}`,
      from: `Bookrail <${USER}>`,
    });
    try {
      await expect(
        wrong.send({ to: 'ada@example.com', subject: 'x', text: 'y' }),
      ).rejects.toThrow();
    } finally {
      await wrong.close();
    }
  });
});

describe('the confirmation message', () => {
  it('puts the token in the fragment and nowhere else in the link', () => {
    const link = confirmationLink('https://bookrail.dev/', 'tok en/+=');
    expect(link).toBe('https://bookrail.dev/signup/confirm#token=tok%20en%2F%2B%3D');
    expect(link.split('#')[0]).toBe('https://bookrail.dev/signup/confirm');
  });

  it('has no em dash, which is a rule for everything a person reads', () => {
    const emDash = String.fromCharCode(0x2014);
    const message = confirmationMessage({
      to: 'ada@example.com',
      siteUrl: 'https://bookrail.dev',
      token: 'token',
    });
    expect(message.text).not.toContain(emDash);
    expect(message.subject).not.toContain(emDash);
  });
});

describe('the log mailer', () => {
  it('keeps what it would have sent, which is what a test reads the link from', async () => {
    const mailer = createLogMailer(silentLogger);
    expect(mailer.last()).toBeUndefined();
    await mailer.send({ to: 'ada@example.com', subject: 'One', text: 'first' });
    await mailer.send({ to: 'grace@example.com', subject: 'Two', text: 'second' });
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.last()?.subject).toBe('Two');
    await mailer.close();
  });
});
