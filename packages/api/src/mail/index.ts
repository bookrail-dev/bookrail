/**
 * Sending one message, and the two ways this deployment can send it.
 *
 * The messages of the product are few and plain: the confirmation link of a sign up, the
 * dashboard link, the usage warnings and the daily digest, and, with Billing, the change of a
 * plan, a failed payment, and the data of every paid invoice for the person who issues the
 * electronic invoice. That is why this module is a small interface and no template engine, no
 * HTML, no queue and no provider abstraction beyond the two implementations below.
 *
 * ## Why a mailer at all, and why SMTP
 *
 * The confirmation comes from a mailbox of the product's own domain, over authenticated SMTP:
 * no second service, no second account, no second set of records in DNS and nothing new to pay
 * for. The transport is `nodemailer`, which is the one maintained SMTP client of this
 * ecosystem: Node has no SMTP client of its own, and writing one would be several hundred lines
 * of protocol and TLS handling to save one dependency.
 *
 * The sending mailbox is a `noreply` one, separate from the address a person answers on, so
 * that automatic traffic and human correspondence do not share a reputation or an inbox. The
 * message says so, and gives the address that is read.
 *
 * ## Why `log` may not run in production
 *
 * The `log` mailer writes the recipient and the link to the log and returns success. That is
 * exactly what a developer wants and exactly what a customer must never get: a sign up that
 * reports success and sends nothing looks like a working sign up until somebody checks a
 * mailbox. `loadConfig` refuses to start a production process configured that way.
 */
import type { Logger } from '@bookrail/shared';

export interface MailMessage {
  /** One address. Nothing in this product sends to more than one person at a time. */
  to: string;
  subject: string;
  /** Plain text. No HTML anywhere, so there is no second rendering of anything. */
  text: string;
  /**
   * Files that ride with the text. One message has one: the monthly list of paid invoices, whose
   * CSV goes into the accounting software. `nodemailer` sends attachments natively, so this adds
   * nothing to the dependencies.
   */
  attachments?: readonly MailAttachment[];
}

export interface MailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface Mailer {
  /** Resolves when the message has been handed over, throws when it has not. */
  send(message: MailMessage): Promise<void>;
  /** For a log line and for `bookrail doctor`: `smtp` or `log`. */
  readonly kind: MailerKind;
  /** Releases the transport, if it holds one. Safe to call more than once. */
  close(): Promise<void>;
}

export const MAILER_KINDS = ['smtp', 'log'] as const;
export type MailerKind = (typeof MAILER_KINDS)[number];

export function isMailerKind(value: string): value is MailerKind {
  return (MAILER_KINDS as readonly string[]).includes(value);
}

export interface SmtpMailerOptions {
  /** `smtps://user:password@host:465`, implicit TLS. */
  url: string;
  /** `Bookrail <noreply@bookrail.dev>`: the mailbox this sends from, and nobody reads. */
  from: string;
  /** Connection, greeting and send timeouts. Ten seconds each. */
  timeoutMs?: number;
}

export const DEFAULT_SMTP_TIMEOUT_MS = 10_000;

/**
 * The real one.
 *
 * The transport is built once and reused, which is what lets `nodemailer` keep a connection
 * pool: a sign up is not a hot path, but opening a TLS session per message would put ten
 * seconds of handshake in front of an HTTP response that a person is waiting on.
 *
 * The import is dynamic so that a deployment that never configures SMTP never loads the
 * library, and so that this module stays importable in a test that only wants the log mailer.
 */
export async function createSmtpMailer(options: SmtpMailerOptions): Promise<Mailer> {
  const { createTransport } = await import('nodemailer');
  const timeout = options.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS;
  const transport = createTransport({
    url: options.url,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  });
  return {
    kind: 'smtp',
    async send(message: MailMessage): Promise<void> {
      await transport.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.attachments === undefined
          ? {}
          : {
              attachments: message.attachments.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content,
                contentType: attachment.contentType,
              })),
            }),
      });
    },
    close(): Promise<void> {
      transport.close();
      return Promise.resolve();
    },
  };
}

/** What a `log` mailer keeps, so that a test can read the message it would have sent. */
export interface RecordedMessage extends MailMessage {
  at: Date;
}

export interface LogMailer extends Mailer {
  /** The messages this process has "sent", oldest first. Empty in a fresh process. */
  readonly sent: readonly RecordedMessage[];
  /** The last message, or `undefined`. What a test reads the confirmation link out of. */
  last(): RecordedMessage | undefined;
}

/**
 * Development and tests.
 *
 * It keeps the messages in memory as well as logging them, which is the hook the end to end
 * test of the terminal command reads the link from: the test drives the real API and the real
 * command, and the only thing it replaces is the mail server.
 */
export function createLogMailer(logger: Logger): LogMailer {
  const sent: RecordedMessage[] = [];
  return {
    kind: 'log',
    get sent(): readonly RecordedMessage[] {
      return sent;
    },
    last(): RecordedMessage | undefined {
      return sent.at(-1);
    },
    send(message: MailMessage): Promise<void> {
      sent.push({ ...message, at: new Date() });
      logger.info('mail_logged', {
        to: message.to,
        subject: message.subject,
        // The whole body, because in this mailer the body is the point: it carries the link
        // somebody has to open. This mailer is refused in production for that very reason.
        text: message.text,
      });
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}
