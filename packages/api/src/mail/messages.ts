import type { MailMessage } from './index.js';

export const CONFIRMATION_SUBJECT = 'Confirm your Bookrail test key';

/**
 * The confirmation link.
 *
 * The token sits in the **fragment**, after the `#`. A browser never sends a fragment to a
 * server, so the token that opens an account does not appear in the access log of the web
 * server, in a proxy log, or in a `Referer` header on the way to anywhere else. The page reads
 * it out of `location.hash` and posts it to the API over TLS, which is the only hop it makes.
 */
export function confirmationLink(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/signup/confirm#token=${encodeURIComponent(token)}`;
}

/**
 * Plain text, English, no HTML.
 *
 * It says who asked, what happens if it was not them, and how long they have. It names the
 * company at the bottom because a message from an unknown domain with nobody behind it is a
 * message people report.
 *
 * It is sent from a mailbox that nobody reads, so it says so, and it gives the address that a
 * person does answer on. A confirmation that invites a reply into a void is worse than one that
 * admits where it came from.
 */
export function confirmationMessage(options: {
  to: string;
  siteUrl: string;
  token: string;
}): MailMessage {
  const link = confirmationLink(options.siteUrl, options.token);
  return {
    to: options.to,
    subject: CONFIRMATION_SUBJECT,
    text: [
      'Hi,',
      '',
      'Somebody, hopefully you, asked for a Bookrail test key with this address.',
      'Open this link within one hour to confirm:',
      '',
      `  ${link}`,
      '',
      'If you started from the terminal, `bookrail signup` is waiting and will store the key',
      'for you.',
      'If it was not you, ignore this message: nothing has been created.',
      '',
      'This mailbox does not read replies. Questions: hello@bookrail.dev',
      'Bookrail, a product of MP Informatica Srl, Treviso, Italy.',
      '',
    ].join('\n'),
  };
}
