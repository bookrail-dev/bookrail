/** The few strings that repeat across the marketing pages, and the one that is still missing. */

/**
 * The product is **Bookrail** (founder's decision, 7 September 2026). `Bookrail` survives in the
 * code: package names, the `bookrail` command, the `Bookrail-*` headers and the identifier
 * prefixes are what actually works today, so no snippet on this site is rewritten.
 */
export const BRAND = 'Bookrail';
export const ORIGIN = 'https://bookrail.dev';

export const TAGLINE = 'Booking infrastructure for developers.';

/**
 * The two lines of the homepage h1, the second in the accent. The founder's choice of
 * 25 September 2026; the tagline above stays what the title of the page and the footer say.
 */
export const HEADLINE = ['Bookings that never collide.', 'One API for developers.'] as const;

export const DESCRIPTION =
  'Availability, resources, holds, bookings, policies and webhooks for anything bookable, behind one API. Capacity is enforced by Postgres, not by application code.';

/**
 * The address a person answers on.
 *
 * Nobody has to write to it for a key any more: `/signup` hands out a test key and a live key,
 * and the dashboard makes and revokes more. It is the address for everything a form cannot do,
 * an Enterprise contract included.
 *
 * The confirmation message of a sign up is sent from a different mailbox, `noreply@`, which is
 * not read; it says so, and points here.
 */
export const CONTACT_EMAIL = 'hello@bookrail.dev';
export const CONTACT_SUBJECT = 'Bookrail';
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(CONTACT_SUBJECT)}`;

/**
 * The repository, and the two places in it a visitor is sent to. A link, never an embed: the
 * compiled site asks nothing of GitHub, and no star count is shown, because it would be either a
 * request to a third party on every visit or a number frozen at the build.
 */
export const GITHUB_REPO = 'https://github.com/bookrail-dev/bookrail';
export const GITHUB_DISCUSSIONS = `${GITHUB_REPO}/discussions`;
export const GITHUB_LICENSE = `${GITHUB_REPO}/blob/main/LICENSE`;
export const GITHUB_CONTRIBUTING = `${GITHUB_REPO}/blob/main/CONTRIBUTING.md`;
export const GITHUB_CHANGELOG = `${GITHUB_REPO}/blob/main/CHANGELOG.md`;

/**
 * The header, on every page. «Product» is the grid of what the product does, on the homepage;
 * the blog goes in front of «For AI agents» when it has an article (`withBlog`).
 */
export const NAV_LINKS = [
  { href: '/#product', label: 'Product' },
  { href: '/docs/', label: 'Docs' },
  { href: '/docs/api/', label: 'API' },
  { href: '/pricing/', label: 'Pricing' },
  { href: '/docs/for-ai-agents/', label: 'For AI agents' },
];

/** Where the blog link goes in the header: in front of this one. */
export const NAV_BLOG_BEFORE = '/docs/for-ai-agents/';

/**
 * On every page, marketing and documentation alike. `/legal` is required of an Italian company
 * by article 2250 of the civil code, and `/privacy` is required of anybody who runs a web
 * server, even one that only writes a log line. `/terms` and `/dpa` are what a key and a paid
 * plan are issued under.
 */
export const LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/legal', label: 'Legal' },
  { href: '/terms', label: 'Terms' },
  { href: '/dpa', label: 'DPA' },
];

export interface FooterColumn {
  title: string;
  links: { href: string; label: string }[];
  /** The blog goes in this column, in front of this link, when it has an article. */
  blogBefore?: string;
}

/**
 * The footer, in four columns. The legal links of `LEGAL_LINKS` stay in the last one, on every
 * page; the documentation carries them in its own footer (`DocsFooter.astro`).
 */
export const FOOTER_COLUMNS: FooterColumn[] = [
  {
    title: 'Product',
    links: [
      { href: '/pricing/', label: 'Pricing' },
      { href: '/docs/', label: 'Docs' },
      { href: '/docs/api/reference/', label: 'API reference' },
      { href: '/dashboard/', label: 'Dashboard' },
      { href: GITHUB_CHANGELOG, label: 'Changelog' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { href: '/docs/quickstart/', label: 'Quickstart' },
      { href: '/docs/cli/', label: 'CLI' },
      { href: '/docs/mcp/', label: 'MCP' },
      { href: '/docs/sdk/', label: 'SDK' },
      { href: '/docs/for-ai-agents/', label: 'For AI agents' },
      { href: '/llms.txt', label: 'llms.txt' },
      { href: '/openapi.json', label: 'openapi.json' },
    ],
  },
  {
    title: 'Community',
    links: [
      { href: GITHUB_REPO, label: 'GitHub' },
      { href: GITHUB_DISCUSSIONS, label: 'Discussions' },
      { href: '/docs/open-source/', label: 'Open source' },
    ],
    blogBefore: '/docs/open-source/',
  },
  {
    title: 'Company',
    links: [...LEGAL_LINKS, { href: CONTACT_MAILTO, label: CONTACT_EMAIL }],
  },
];
