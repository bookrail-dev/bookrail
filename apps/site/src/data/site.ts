/** The few strings that repeat across the marketing pages, and the one that is still missing. */

/**
 * The product is **Bookrail** (founder's decision, 7 September 2026). `Bookrail` survives in the
 * code: package names, the `bookrail` command, the `Bookrail-*` headers and the identifier
 * prefixes are what actually works today, so no snippet on this site is rewritten.
 */
export const BRAND = 'Bookrail';
export const ORIGIN = 'https://bookrail.dev';

export const TAGLINE = 'Booking infrastructure for developers.';

export const DESCRIPTION =
  'Availability, resources, holds, bookings, policies and webhooks for anything bookable, behind one API. Capacity is enforced by Postgres, not by application code.';

/**
 * The address a person answers on, and the one thing it is now asked for.
 *
 * A **test** key needs nobody: `/signup` sends a link and the key comes back. A **live** key
 * still comes from a person, and will until there is a paid plan behind it, so this is the
 * address for that and for everything else a form cannot do.
 *
 * The confirmation message of a sign up is sent from a different mailbox, `noreply@`, which is
 * not read; it says so, and points here.
 */
export const CONTACT_EMAIL = 'hello@bookrail.dev';
export const CONTACT_SUBJECT = 'Bookrail live key';
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(CONTACT_SUBJECT)}`;

export const NAV_LINKS = [
  { href: '/docs/', label: 'Docs' },
  { href: '/docs/api/', label: 'API' },
  { href: '/docs/for-ai-agents/', label: 'For AI agents' },
  { href: '/docs/open-source/', label: 'Open source' },
];

/**
 * On every page, marketing and documentation alike. `/legal` is required of an Italian company
 * by article 2250 of the civil code, and `/privacy` is required of anybody who runs a web
 * server, even one that only writes a log line.
 */
export const LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/legal', label: 'Legal' },
];

export const FOOTER_LINKS = [
  { href: '/docs/', label: 'Docs' },
  { href: '/docs/api/reference/', label: 'API reference' },
  { href: '/docs/for-ai-agents/', label: 'For AI agents' },
  { href: '/llms.txt', label: 'llms.txt' },
  { href: '/openapi.json', label: 'openapi.json' },
  { href: CONTACT_MAILTO, label: CONTACT_EMAIL },
  ...LEGAL_LINKS,
];
