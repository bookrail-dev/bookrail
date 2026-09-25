/**
 * The prices of the four plans, and what the pricing page says about each of them.
 *
 * Two tables of `@bookrail/shared`, never mixed and never copied. What a plan **includes and
 * enforces** (confirmed live bookings a month, the paid volume of the free plan, projects, the
 * rate limit of a live key) is read from `PLANS`, the table the API itself enforces, so the page
 * cannot promise a number the code does not apply. What a paid plan **costs** (the monthly price,
 * a booking over the quota, the price of the orchestrated payments) is read from `PLAN_PRICES`,
 * the table the checkout, the overage lines of the invoices and the Stripe catalogue are made
 * from, so the page cannot print a price that is not the one charged. Enterprise is a contract,
 * and its starting price is here.
 *
 * The page publishes only what is true today. `test/pricing.test.ts` compares this file and
 * `PLANS` with the published table of the internal pricing document, when that document is in
 * the working copy, and with the built page, cell by cell.
 */
import { PLANS, PLAN_PRICES, type PlanId } from '@bookrail/shared';

/** Cents as euro, for the page: `2900` is `29`, `3` is `0.03`. */
function eurOf(cents: number): number {
  return cents / 100;
}

/** Per mille as a percentage, for the page: `4` is `0.4`. */
function percentOf(perMille: number): number {
  return perMille / 10;
}

/** What a plan costs before any usage. */
export type BasePrice =
  | { kind: 'monthly'; eur: number }
  /** Enterprise: an annual contract, from this much a year. */
  | { kind: 'custom'; fromEurPerYear: number };

/** A confirmed live booking past the included ones. */
export type ExtraBooking =
  /** The free plan: new live bookings are refused at the limit. */
  { kind: 'blocked' } | { kind: 'eur'; eur: number } | { kind: 'negotiated' };

/** The price of orchestrating payments. */
export type Payments =
  /** The free plan: up to the volume `PLANS.free.paymentVolumeIncluded`, then blocked. */
  { kind: 'included' } | { kind: 'percent'; percent: number } | { kind: 'negotiated' };

export type Support =
  { kind: 'community' } | { kind: 'email'; businessDays: number } | { kind: 'dedicated' };

/**
 * The action of a card and of the header of the comparison table.
 *
 * `upgrade` is a link to the dashboard with the plan in the query (`/dashboard/?upgrade=pro`),
 * declared with `data-upgrade-plan`: the dashboard asks for the address if there is no session,
 * carries the plan through the sign in link, and opens the Stripe checkout of that plan.
 */
export type PlanAction =
  | { kind: 'signup'; label: string; href: '/signup' }
  | { kind: 'upgrade'; label: string; plan: Exclude<PlanId, 'free' | 'enterprise'> }
  | { kind: 'contact'; label: string; href: string };

export interface PricedPlan {
  id: PlanId;
  name: string;
  description: string;
  price: BasePrice;
  extraBooking: ExtraBooking;
  payments: Payments;
  support: Support;
  action: PlanAction;
  /** One plan is recommended, and it is Pro. */
  recommended: boolean;
}

export const CONTACT_EMAIL = 'hello@bookrail.dev';

/** Where the button of a paid plan goes: the dashboard, which opens the checkout of that plan. */
export function upgradeHref(plan: 'pro' | 'scale'): string {
  return `/dashboard/?upgrade=${plan}`;
}

export const PRICED_PLANS: readonly PricedPlan[] = [
  {
    id: 'free',
    name: 'Free',
    description: 'For building and launching: the whole API, free until it counts.',
    price: { kind: 'monthly', eur: 0 },
    extraBooking: { kind: 'blocked' },
    payments: { kind: 'included' },
    support: { kind: 'community' },
    action: { kind: 'signup', label: 'Start for free', href: '/signup' },
    recommended: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'For a product with customers. Bookings past the quota are billed, not refused.',
    price: { kind: 'monthly', eur: eurOf(PLAN_PRICES.pro.monthly) },
    extraBooking: { kind: 'eur', eur: eurOf(PLAN_PRICES.pro.extraBooking) },
    payments: { kind: 'percent', percent: percentOf(PLAN_PRICES.pro.paymentsPerMille) },
    support: { kind: 'email', businessDays: 4 },
    action: { kind: 'upgrade', label: 'Get started', plan: 'pro' },
    recommended: true,
  },
  {
    id: 'scale',
    name: 'Scale',
    description: 'For a product at volume, with a higher rate limit and a lower price per booking.',
    price: { kind: 'monthly', eur: eurOf(PLAN_PRICES.scale.monthly) },
    extraBooking: { kind: 'eur', eur: eurOf(PLAN_PRICES.scale.extraBooking) },
    payments: { kind: 'percent', percent: percentOf(PLAN_PRICES.scale.paymentsPerMille) },
    support: { kind: 'email', businessDays: 1 },
    action: { kind: 'upgrade', label: 'Get started', plan: 'scale' },
    recommended: false,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'For volumes and terms that need a contract.',
    price: { kind: 'custom', fromEurPerYear: 20_000 },
    extraBooking: { kind: 'negotiated' },
    payments: { kind: 'negotiated' },
    support: { kind: 'dedicated' },
    action: { kind: 'contact', label: 'Contact us', href: `mailto:${CONTACT_EMAIL}` },
    recommended: false,
  },
];

/** The test environment, on every plan. */
export const TEST_ENVIRONMENT = 'Free, never counted';

/** Where the data lives, on every plan, today. */
export const REGION = 'EU';

/** `1000` as `1,000`. */
export function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `0.03` as `€0.03`, `29` as `€29`, `20000` as `€20,000`. */
export function euro(value: number): string {
  const [whole = '0', cents] = String(value).split('.');
  return cents === undefined
    ? `€${thousands(Number(whole))}`
    : `€${thousands(Number(whole))}.${cents.padEnd(2, '0')}`;
}

/** The paid volume the free plan includes each month, in euro, from the enforced table. */
export function freeVolumeEur(): number {
  const cents = PLANS.free.paymentVolumeIncluded;
  if (cents === null) throw new Error('The free plan has no volume cap in PLANS.');
  return cents / 100;
}

/** The label of each cell of the published matrix, as the page prints it. */
export interface MatrixCell {
  value: string;
  /** The grey second line: what happens past the quota. */
  note?: string;
}

export interface MatrixRow {
  key: MatrixRowKey;
  label: string;
  /** What the «i» next to the label explains. */
  definition: string;
  cells: Record<PlanId, MatrixCell>;
}

export interface MatrixSection {
  title: string;
  rows: MatrixRow[];
}

/**
 * The rows the page publishes, in the order of the published table of the pricing document.
 * Nothing else is published: team members, retention of logs and events, managed notifications,
 * SMS, a hosted portal, SSO, SOC 2, a US region and an SLA do not exist today.
 */
export const MATRIX_ROW_KEYS = [
  'base_price',
  'bookings_included',
  'extra_booking',
  'payments',
  'projects',
  'rate_limit',
  'test_environment',
  'region',
  'support',
] as const;

export type MatrixRowKey = (typeof MATRIX_ROW_KEYS)[number];

function byPlan(cell: (plan: PricedPlan) => MatrixCell): Record<PlanId, MatrixCell> {
  return Object.fromEntries(PRICED_PLANS.map((plan) => [plan.id, cell(plan)])) as Record<
    PlanId,
    MatrixCell
  >;
}

function basePrice(plan: PricedPlan): MatrixCell {
  return plan.price.kind === 'monthly'
    ? { value: `${euro(plan.price.eur)} / month` }
    : { value: 'Custom', note: `from ${euro(plan.price.fromEurPerYear)} / year` };
}

function bookingsIncluded(plan: PricedPlan): MatrixCell {
  const included = PLANS[plan.id].bookingsIncluded;
  return { value: included === null ? 'Negotiated' : `${thousands(included)} / month` };
}

function extraBooking(plan: PricedPlan): MatrixCell {
  switch (plan.extraBooking.kind) {
    case 'blocked':
      return { value: 'Blocked at the limit', note: 'New live bookings get 402 until next month' };
    case 'eur':
      return { value: `${euro(plan.extraBooking.eur)} per booking` };
    case 'negotiated':
      return { value: 'Negotiated' };
  }
}

function payments(plan: PricedPlan): MatrixCell {
  switch (plan.payments.kind) {
    case 'included':
      return { value: `Up to ${euro(freeVolumeEur())} / month`, note: 'Then blocked' };
    case 'percent':
      return { value: `${String(plan.payments.percent)}% of volume` };
    case 'negotiated':
      return { value: 'Negotiated' };
  }
}

function projects(plan: PricedPlan): MatrixCell {
  const count = PLANS[plan.id].projects;
  return { value: count === null ? 'Unlimited' : String(count) };
}

function rateLimit(plan: PricedPlan): MatrixCell {
  if (plan.id === 'enterprise') return { value: 'Negotiated' };
  const { rate, burst } = PLANS[plan.id].rateLimit;
  return { value: `${thousands(rate)} req/s`, note: `bursts of ${thousands(burst)}` };
}

function support(plan: PricedPlan): MatrixCell {
  switch (plan.support.kind) {
    case 'community':
      return { value: 'Community (GitHub issues)' };
    case 'email':
      return {
        value: 'Email',
        note: `within ${String(plan.support.businessDays)} business ${plan.support.businessDays === 1 ? 'day' : 'days'}`,
      };
    case 'dedicated':
      return { value: 'Dedicated' };
  }
}

/** The comparison table, in sections, every cell derived from the two sources above. */
export const MATRIX: readonly MatrixSection[] = [
  {
    title: 'Bookings',
    rows: [
      {
        key: 'base_price',
        label: 'Base price',
        definition: 'What the plan costs each month before any usage.',
        cells: byPlan(basePrice),
      },
      {
        key: 'bookings_included',
        label: 'Confirmed live bookings included',
        definition:
          'Live bookings that reach confirmed in a calendar month (UTC), each counted once. Cancellations, holds, no-shows and reschedules do not count again.',
        cells: byPlan(bookingsIncluded),
      },
      {
        key: 'extra_booking',
        label: 'Each booking past the quota',
        definition:
          'On Free, new live bookings are refused with 402 plan_limit_reached until the next month or a paying plan. Bookings already made are not touched.',
        cells: byPlan(extraBooking),
      },
    ],
  },
  {
    title: 'Payments',
    rows: [
      {
        key: 'payments',
        label: 'Orchestrated payments',
        definition:
          'The price of the service, not a fee on the money: deposits and payments are charged on your own Stripe account and the money goes there. Measured on live payments that succeeded in the month, net of refunds.',
        cells: byPlan(payments),
      },
    ],
  },
  {
    title: 'API',
    rows: [
      {
        key: 'projects',
        label: 'Projects',
        definition: 'Separate projects in one account, each with its own keys and data.',
        cells: byPlan(projects),
      },
      {
        key: 'rate_limit',
        label: 'Rate limit per live key',
        definition:
          'Requests per second one live key may make, with its burst. A test key has 20 per second with bursts of 40 on every plan.',
        cells: byPlan(rateLimit),
      },
      {
        key: 'test_environment',
        label: 'Test environment',
        definition: 'Test keys and test data are free on every plan and never counted.',
        cells: byPlan(() => ({ value: TEST_ENVIRONMENT })),
      },
      {
        key: 'region',
        label: 'Region',
        definition: 'Where the data is stored and processed.',
        cells: byPlan(() => ({ value: REGION })),
      },
    ],
  },
  {
    title: 'Support',
    rows: [
      {
        key: 'support',
        label: 'Support',
        definition: 'Where to ask, and how soon an answer comes.',
        cells: byPlan(support),
      },
    ],
  },
];

/** One line of a card: the claim, and the grey second line with the price past the quota. */
export interface CardFeature {
  text: string;
  note?: string;
}

/** What the list of a card starts with. */
export function cardLead(plan: PricedPlan): string {
  const index = PRICED_PLANS.findIndex((candidate) => candidate.id === plan.id);
  const previous = PRICED_PLANS[index - 1];
  return previous === undefined ? 'Get started with:' : `Everything in ${previous.name}, plus:`;
}

/**
 * The lines of a card, derived from the same two sources as the matrix. Each card lists what it
 * adds to the one before it, so a line that would repeat the previous card is left out.
 */
export function cardFeatures(plan: PricedPlan): CardFeature[] {
  const limits = PLANS[plan.id];
  const features: CardFeature[] = [];
  if (limits.bookingsIncluded !== null) {
    features.push({
      text: `${thousands(limits.bookingsIncluded)} confirmed live bookings a month`,
      ...(plan.extraBooking.kind === 'eur'
        ? { note: `then ${euro(plan.extraBooking.eur)} per booking` }
        : {}),
    });
  } else {
    features.push({ text: 'Negotiated bookings and price per booking' });
  }
  switch (plan.payments.kind) {
    case 'included':
      features.push({
        text: `Payments on your own Stripe, up to ${euro(freeVolumeEur())} a month`,
      });
      break;
    case 'percent':
      features.push({ text: `Payments at ${String(plan.payments.percent)}% of volume` });
      break;
    case 'negotiated':
      features.push({ text: 'Negotiated price on payments' });
      break;
  }
  if (plan.id === 'free') {
    features.push({ text: `${String(limits.projects ?? 0)} projects` });
  } else if (plan.id === 'pro') {
    features.push({ text: 'Unlimited projects' });
  }
  if (plan.id === 'enterprise') {
    features.push({ text: 'An annual contract' });
  } else {
    features.push({ text: `${thousands(limits.rateLimit.rate)} requests a second per live key` });
  }
  if (plan.id === 'free') features.push({ text: 'Test environment, free and never counted' });
  switch (plan.support.kind) {
    case 'community':
      features.push({ text: 'Community support on GitHub issues' });
      break;
    case 'email':
      features.push({
        text: `Email support within ${String(plan.support.businessDays)} business ${plan.support.businessDays === 1 ? 'day' : 'days'}`,
      });
      break;
    case 'dedicated':
      features.push({ text: 'Dedicated support' });
      break;
  }
  return features;
}

/** The big number of a card, and what goes under or beside it. */
export function cardPrice(plan: PricedPlan): { amount: string; per?: string; note?: string } {
  return plan.price.kind === 'monthly'
    ? { amount: euro(plan.price.eur), per: '/ month' }
    : { amount: 'Custom', note: `from ${euro(plan.price.fromEurPerYear)} / year` };
}

/** Under the Free card: what happens at the limit, with the number from the enforced table. */
export function freeLimitSentence(): string {
  return `At ${thousands(PLANS.free.bookingsIncluded ?? 0)} confirmed live bookings in a month, new live bookings are refused with 402 until the next month or a paying plan. Bookings already made are not touched.`;
}

/**
 * The sentence under the title of the page, the one of the pricing document's fourth principle:
 * «Free up to 1,000 bookings a month. Then €29 for 5,000, and 3 cents for each one after that.»
 * Every number is read, none is written: the free and pro quotas from `PLANS`, the price of Pro
 * and its price per extra booking from this file.
 */
export function pricingLede(): string {
  const pro = PRICED_PLANS.find((plan) => plan.id === 'pro');
  if (pro === undefined || pro.price.kind !== 'monthly' || pro.extraBooking.kind !== 'eur') {
    throw new Error('The pro plan has no monthly price or no price per extra booking.');
  }
  const free = PLANS.free.bookingsIncluded;
  const included = PLANS.pro.bookingsIncluded;
  if (free === null || included === null) throw new Error('A quota the sentence needs is null.');
  const cents = Math.round(pro.extraBooking.eur * 100);
  return `Free up to ${thousands(free)} bookings a month. Then ${euro(pro.price.eur)} for ${thousands(included)}, and ${String(cents)} ${cents === 1 ? 'cent' : 'cents'} for each one after that.`;
}
