import type { MailMessage } from './index.js';

export const CONFIRMATION_SUBJECT = 'Confirm your Bookrail keys';

export const DASHBOARD_LINK_SUBJECT = 'Your Bookrail dashboard link';

/** Where an account on the free plan buys Pro: the dashboard opens the checkout after sign in. */
export const DASHBOARD_UPGRADE_URL = 'https://bookrail.dev/dashboard/?upgrade=pro';

export const DASHBOARD_URL = 'https://bookrail.dev/dashboard/';

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
  /** The confirmed live bookings the free plan includes each month, from the plan table. */
  freeBookingsIncluded: number;
}): MailMessage {
  const link = confirmationLink(options.siteUrl, options.token);
  return {
    to: options.to,
    subject: CONFIRMATION_SUBJECT,
    text: [
      'Hi,',
      '',
      'Somebody, hopefully you, asked for Bookrail API keys with this address.',
      'Open this link within one hour to confirm:',
      '',
      `  ${link}`,
      '',
      'The link creates your account and hands you two keys, once:',
      '  a test key, which is free and never counted;',
      '  a live key, which makes real bookings, on the free plan: up to',
      `  ${thousands(options.freeBookingsIncluded)} confirmed live bookings a month, then new live bookings`,
      '  are refused until the next month or a paying plan.',
      '',
      'If you started from the terminal, `bookrail signup` is waiting and will store both',
      'keys for you.',
      'If it was not you, ignore this message: nothing has been created.',
      '',
      'This mailbox does not read replies. Questions: hello@bookrail.dev',
      'Bookrail, a product of MP Informatica Srl, Treviso, Italy.',
      '',
    ].join('\n'),
  };
}

/** `1000` as `1,000`: how a number of bookings reads in an English sentence. */
function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The dashboard link, with its token in the **fragment** for the reason
 * {@link confirmationLink} gives: a browser never sends a fragment to a server, so the token that
 * opens a session appears in no access log and in no `Referer`.
 */
export function dashboardLink(siteUrl: string, token: string, upgrade?: string): string {
  const next = upgrade === undefined ? '' : `&upgrade=${encodeURIComponent(upgrade)}`;
  return `${siteUrl.replace(/\/+$/, '')}/dashboard/confirm#token=${encodeURIComponent(token)}${next}`;
}

/**
 * The message with the dashboard link. Plain text, English, no HTML, like the confirmation.
 *
 * It is sent only to the owner address of an account, and it says what the link opens, for how
 * long, and that it works once: a person who did not ask for it has nothing to do.
 */
export function dashboardLinkMessage(options: {
  to: string;
  siteUrl: string;
  token: string;
  /** The plan the person was about to buy when they asked for the link, carried through it. */
  upgrade?: string;
}): MailMessage {
  const link = dashboardLink(options.siteUrl, options.token, options.upgrade);
  return {
    to: options.to,
    subject: DASHBOARD_LINK_SUBJECT,
    text: [
      'Hi,',
      '',
      'Somebody, hopefully you, asked to sign in to the Bookrail dashboard with this address.',
      'Open this link within 15 minutes. It works once:',
      '',
      `  ${link}`,
      '',
      'It opens a session of 12 hours in that browser tab, where you can see your plan and',
      "this month's usage, and create or revoke API keys.",
      'If it was not you, ignore this message: without the link nobody can sign in.',
      '',
      'This mailbox does not read replies. Questions: hello@bookrail.dev',
      'Bookrail, a product of MP Informatica Srl, Treviso, Italy.',
      '',
    ].join('\n'),
  };
}

/** Minor units as a decimal amount: `123456` is `1234.56`. */
function amountOf(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/** `2026-09` as `September 2026`, which is how a person reads a month. */
function monthName(month: string): string {
  const [year, number] = month.split('-');
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${names[Number(number) - 1] ?? month} ${year ?? ''}`.trim();
}

/**
 * The usage warning, at 80 % and at 100 % of the bookings a plan includes.
 *
 * Plain text, English, no HTML, like the confirmation above. It gives the two numbers, the month
 * they are about (a calendar month in UTC), and what happens next, which is different on the
 * free plan, where new live bookings stop at 100 %, and on a paying one, where they do not.
 */
export function planWarningMessage(options: {
  to: string;
  warning: {
    plan: string;
    month: string;
    threshold: number;
    bookingsConfirmed: number;
    bookingsIncluded: number;
    paymentVolume: number;
    paymentVolumeIncluded: number | null;
    currency: string | null;
  };
}): MailMessage {
  const w = options.warning;
  const month = monthName(w.month);
  const blocks = w.plan === 'free';
  const reached = w.threshold >= 100;
  const currency = w.currency === null || w.currency === 'mixed' ? '' : ` ${w.currency}`;
  const volume =
    w.paymentVolumeIncluded === null
      ? `${amountOf(w.paymentVolume)}${currency}`
      : `${amountOf(w.paymentVolume)} of ${amountOf(w.paymentVolumeIncluded)}${currency}`;
  const next = blocks
    ? reached
      ? [
          'The free plan refuses new live bookings once the included ones are used,',
          'so new live bookings of this account are now answered with',
          '402 plan_limit_reached until the end of the month, or until the account',
          'moves to a paying plan. Bookings already made are not touched.',
        ]
      : [
          'The free plan refuses new live bookings once the included ones are used.',
          'When that happens, new live bookings are answered with',
          '402 plan_limit_reached until the end of the month, or until the account',
          'moves to a paying plan.',
        ]
    : [
        `The ${w.plan} plan does not refuse bookings past the included ones.`,
        'This message is so that the number does not come as a surprise.',
      ];
  return {
    to: options.to,
    subject: `Bookrail: ${String(w.threshold)}% of the ${w.plan} plan used in ${month}`,
    text: [
      'Hi,',
      '',
      `Your Bookrail account has used ${String(w.threshold)}% of the confirmed live`,
      `bookings its ${w.plan} plan includes in ${month} (UTC).`,
      '',
      `  Confirmed live bookings  ${String(w.bookingsConfirmed)} of ${String(w.bookingsIncluded)}`,
      `  Paid volume              ${volume}`,
      '',
      ...next,
      'The count starts again on the first day of next month, in UTC.',
      '',
      ...(blocks
        ? [`Upgrade in the dashboard: ${DASHBOARD_UPGRADE_URL}`]
        : w.plan === 'pro'
          ? [`To move to Scale, open Manage billing in the dashboard: ${DASHBOARD_URL}`]
          : []),
      'GET /v1/project and `bookrail whoami` show the numbers at any time.',
      '',
      'This mailbox does not read replies. Questions: hello@bookrail.dev',
      'Bookrail, a product of MP Informatica Srl, Treviso, Italy.',
      '',
    ].join('\n'),
  };
}

const PLAN_NAMES: Readonly<Record<string, string>> = {
  free: 'Free',
  pro: 'Pro',
  scale: 'Scale',
  enterprise: 'Enterprise',
};

function planName(plan: string): string {
  return PLAN_NAMES[plan] ?? plan;
}

/**
 * The plan of the account has changed. Sent to the owner address after the change has committed.
 *
 * It says what the plan is now and why, in words, because the owner may not be the person who
 * clicked (a failed payment moves an account back to Free with nobody clicking anything).
 */
export function planChangedMessage(options: {
  to: string;
  accountName: string;
  from: string;
  to_plan: string;
  reason: string;
  /** The confirmed live bookings the free plan includes each month, from the plan table. */
  freeBookingsIncluded: number;
}): MailMessage {
  const why: Record<string, string> = {
    checkout: 'the subscription you bought is active.',
    subscription_update: 'the subscription changed plan.',
    payment_failed:
      'the payment of the subscription kept failing for fourteen days, so it has been closed.',
    canceled: 'the subscription has ended.',
    admin: 'the plan was changed by Bookrail.',
  };
  const now = planName(options.to_plan);
  const free = options.to_plan === 'free';
  return {
    to: options.to,
    subject: `Your Bookrail plan is now ${now}`,
    text: [
      'Hi,',
      '',
      `The plan of ${options.accountName} has changed from ${planName(options.from)} to ${now}, because`,
      why[options.reason] ?? 'of a change of the subscription.',
      '',
      ...(free
        ? [
            'On Free, new live bookings are refused with 402 plan_limit_reached once the month',
            `includes ${thousands(options.freeBookingsIncluded)} confirmed ones. Nothing has been deleted: your projects, keys and`,
            `bookings are all there. To buy a plan again: ${DASHBOARD_UPGRADE_URL}`,
          ]
        : [
            'The new quantities and the new rate limit apply from now. The plan, the usage and',
            `the invoices are in the dashboard: ${DASHBOARD_URL}`,
          ]),
      '',
      'This mailbox does not read replies. Questions: hello@bookrail.dev',
      'Bookrail, a product of MP Informatica Srl, Treviso, Italy.',
      '',
    ].join('\n'),
  };
}

/**
 * The subscription was closed because its payment never came, and invoices are still open: the
 * link to pay each. Stripe no longer collects them, and a new plan cannot be bought until they
 * are paid.
 */
export function subscriptionClosedUnpaidMessage(options: {
  to: string;
  accountName: string;
  invoices: readonly {
    number: string | null;
    amount: number;
    currency: string;
    url: string | null;
  }[];
}): MailMessage {
  return {
    to: options.to,
    subject: 'Your Bookrail subscription was closed: an invoice is unpaid',
    text: [
      'Hi,',
      '',
      `The Bookrail subscription of ${options.accountName} was closed, because its payment did`,
      'not go through within fourteen days. The account is on the Free plan now. Nothing is',
      'deleted.',
      '',
      'This invoice is still to pay:',
      ...options.invoices.map(
        (invoice) =>
          `  ${invoice.number ?? 'Invoice'}: ${money(invoice.amount, invoice.currency)}${invoice.url === null ? '' : `, ${invoice.url}`}`,
      ),
      '',
      'A paid plan can be bought again once it is paid.',
      `The dashboard shows it too: ${DASHBOARD_URL}`,
      '',
      'This mailbox does not read replies. Questions: hello@bookrail.dev',
      'Bookrail, a product of MP Informatica Srl, Treviso, Italy.',
      '',
    ].join('\n'),
  };
}

/** Cents as an amount in English: `8455` in eur is `EUR 84.55`. */
function money(cents: number, currency: string): string {
  return `${currency.toUpperCase()} ${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/** A payment of the subscription failed: the first failure of the period only. */
export function paymentFailedMessage(options: {
  to: string;
  accountName: string;
  graceEndsAt: string;
}): MailMessage {
  const until = options.graceEndsAt.slice(0, 10);
  return {
    to: options.to,
    subject: 'Your Bookrail payment failed',
    text: [
      'Hi,',
      '',
      `The last payment of the Bookrail subscription of ${options.accountName} did not go through.`,
      'Stripe will try again over the next days and has written to you as well.',
      '',
      `Your plan stays as it is until ${until} (UTC). If no payment has succeeded by then,`,
      'the subscription is closed and the account goes back to Free. Nothing is deleted.',
      '',
      `Update the card in the dashboard, under Manage billing: ${DASHBOARD_URL}`,
      '',
      'This mailbox does not read replies. Questions: hello@bookrail.dev',
      'Bookrail, a product of MP Informatica Srl, Treviso, Italy.',
      '',
    ].join('\n'),
  };
}
