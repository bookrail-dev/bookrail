/**
 * The dashboard's one script.
 *
 * It holds the session token (`bds_...`) in `sessionStorage`, which dies with the tab: no cookie,
 * no `localStorage`, nothing that outlives the tab. It talks to the API and to nothing else, with
 * the session in an `Authorization` header, and it writes every value the API returns with
 * `textContent`: nothing from the network is parsed as HTML.
 *
 * What it can do is exactly what the session can: read the account, create a key, revoke a key,
 * open the Stripe checkout of a paid plan or the Stripe customer portal, and sign out. Payments
 * happen on Stripe's pages: this script only asks the API for the address of the page and sends
 * the browser there.
 */

import { SESSION_STORAGE_KEY } from './dashboard-session';

interface StoredSession {
  token: string;
  expires_at: string;
}

interface ApiKey {
  id: string;
  environment: 'test' | 'live';
  kind: string;
  name: string | null;
  prefix: string;
  status: 'active' | 'revoked';
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  secret_key?: string;
}

interface Project {
  id: string;
  name: string;
  default_timezone: string;
  default_currency: string;
  api_keys: ApiKey[];
}

interface Billing {
  status: string;
  /** Whether the account still has this subscription, as the API's one definition says. */
  live?: boolean;
  plan: 'pro' | 'scale';
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  scheduled_plan: 'pro' | 'scale' | null;
  past_due_since: string | null;
  grace_ends_at: string | null;
  /** An invoice left open when the subscription was closed for non payment. */
  unpaid_invoice?: {
    id: string;
    number: string | null;
    amount_due: number;
    currency: string;
    url: string | null;
  } | null;
}

interface Account {
  account: { id: string; name: string; plan: string; owner_email: string };
  billing: Billing | null;
  terms: { terms_version: string; dpa_version: string; accepted_at: string | null };
  usage: {
    month: string;
    bookings_confirmed: number;
    bookings_included: number | null;
    payment_volume: number;
    payment_volume_included: number | null;
    currency: string | null;
    blocks_at_limit: boolean;
  };
  reserved: { bookings_pending: number; payment_volume_pending: number };
  projects: Project[];
  session: { expires_at: string };
}

interface ApiError {
  error?: { code?: string; message?: string; fix?: string };
}

const root = document.getElementById('dashboard');
const API_URL = root?.dataset.apiUrl ?? 'https://api.bookrail.dev';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} is missing from the page`);
  return found as T;
}

/** The session of this tab, or `null` when there is none or it has run out. */
export function readSession(): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.token !== 'string' || typeof parsed.expires_at !== 'string') return null;
    if (Date.parse(parsed.expires_at) <= Date.now()) {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return { token: parsed.token, expires_at: parsed.expires_at };
  } catch {
    return null;
  }
}

function forgetSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage refused: there is nothing stored to forget either.
  }
}

async function call<T>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T & ApiError }> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as T & ApiError,
  };
}

function explain(body: ApiError, fallback: string): string {
  const error = body.error ?? {};
  return `${error.message ?? fallback}${error.fix === undefined ? '' : ` ${error.fix}`}`;
}

function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Minor units as a decimal amount with its currency: `45000` in EUR is `450.00 EUR`. */
function money(minor: number, currency: string | null): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const amount = `${sign}${thousands(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
  if (currency === null) return `${amount} EUR`;
  if (currency === 'mixed') return `${amount} (several currencies)`;
  return `${amount} ${currency.toUpperCase()}`;
}

/** `2026-09-24T10:00:00.000Z` as `2026-09-24 10:00 UTC`. */
function instant(value: string | null): string {
  if (value === null) return 'never';
  const date = new Date(value);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

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

function say(id: string, text: string): void {
  element(id).textContent = text;
}

function showSignIn(message?: string): void {
  element('dash-app').hidden = true;
  element('dash-signin').hidden = false;
  say('dash-status', '');
  if (message !== undefined) say('dash-login-status', message);
}

// ------------------------------------------------------------------------- signing in

function wireSignIn(): void {
  const form = element<HTMLFormElement>('dash-login');
  const email = element<HTMLInputElement>('dash-email');
  const submit = element<HTMLButtonElement>('dash-login-submit');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const address = email.value.trim();
    if (address === '') {
      say('dash-login-status', 'Type the address you signed up with.');
      email.focus();
      return;
    }
    submit.disabled = true;
    say('dash-login-status', 'Sending...');
    call<{ expires_at: string }>('POST', '/v1/dashboard/login', {
      body: { email: address, ...(pendingUpgrade === null ? {} : { upgrade: pendingUpgrade }) },
    })
      .then(({ status, body }) => {
        submit.disabled = false;
        if (status === 202) {
          say(
            'dash-login-status',
            `If ${address} has a Bookrail account, a link is on its way. Open it in this browser within 15 minutes.${pendingUpgrade === null ? '' : ` The checkout of ${planLabel(pendingUpgrade)} opens after you sign in.`}`,
          );
          form.reset();
          return;
        }
        say('dash-login-status', explain(body, 'That did not work.'));
      })
      .catch(() => {
        submit.disabled = false;
        say('dash-login-status', 'The API could not be reached. Try again in a minute.');
      });
  });
}

// ------------------------------------------------------------------------- the account

let current: Account | null = null;

/** True while the page waits for Stripe to confirm a checkout just paid. */
let awaitingCheckout = false;

/** How often the account is read again after a paid checkout, for half a minute. */
const CHECKOUT_POLL_MS = 2000;

function renderUsage(account: Account): void {
  const { usage, reserved } = account;
  say('usage-month', monthName(usage.month));
  say('usage-plan', account.account.plan.toUpperCase());

  const included = usage.bookings_included;
  say(
    'usage-bookings',
    included === null
      ? thousands(usage.bookings_confirmed)
      : `${thousands(usage.bookings_confirmed)} / ${thousands(included)}`,
  );
  const fill = element('usage-meter-fill');
  const pending = element('usage-meter-pending');
  const confirmedShare =
    included === null || included === 0 ? 0 : usage.bookings_confirmed / included;
  const pendingShare =
    included === null || included === 0 ? 0 : reserved.bookings_pending / included;
  const confirmedWidth = Math.min(1, confirmedShare);
  const pendingWidth = Math.max(0, Math.min(1 - confirmedWidth, pendingShare));
  fill.style.width = `${String(confirmedWidth * 100)}%`;
  pending.style.width = `${String(pendingWidth * 100)}%`;
  if (pendingWidth === 0) pending.setAttribute('data-empty', '');
  else pending.removeAttribute('data-empty');
  element('usage-meter').hidden = included === null;

  const pendingCount = reserved.bookings_pending;
  say(
    'usage-pending',
    pendingCount === 0
      ? 'No live bookings pending.'
      : `${thousands(pendingCount)} live ${pendingCount === 1 ? 'booking' : 'bookings'} pending, shown dashed.${usage.blocks_at_limit ? ' On Free they count against the limit already.' : ''}`,
  );

  const volumeIncluded = usage.payment_volume_included;
  say(
    'usage-volume',
    volumeIncluded === null
      ? money(usage.payment_volume, usage.currency)
      : `${money(usage.payment_volume, usage.currency)} / ${money(volumeIncluded, usage.currency ?? 'EUR')}`,
  );
  say(
    'usage-volume-open',
    reserved.payment_volume_pending === 0
      ? 'No payments open.'
      : `${money(reserved.payment_volume_pending, usage.currency)} in open payments.`,
  );

  const limit = element('usage-limit');
  if (usage.blocks_at_limit) {
    limit.hidden = false;
    limit.textContent =
      'At the limit, new live bookings are refused with 402 plan_limit_reached until the next month (UTC) or a paying plan. Bookings already made are not touched.';
  } else {
    limit.hidden = true;
  }

  renderBilling(account);
}

// ------------------------------------------------------------------------- billing

type PaidPlan = 'pro' | 'scale';

/** A subscription in one of these states is one the account still has. */

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  scale: 'Scale',
  enterprise: 'Enterprise',
};

function planLabel(plan: string): string {
  return PLAN_LABELS[plan] ?? plan;
}

/** `2026-11-01T00:00:00Z` as `1 November 2026`, in UTC like everything about the plan. */
function longDate(value: string | null): string {
  if (value === null) return 'the end of the period';
  const date = new Date(value);
  const month = monthName(
    `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
  );
  return `${String(date.getUTCDate())} ${month}`;
}

function isPaidPlan(value: string | null): value is PaidPlan {
  return value === 'pro' || value === 'scale';
}

/**
 * Whether the account still has its subscription: the API says so (`billing.live`), from the one
 * definition the database keeps. No copy of the list of statuses here.
 */
function hasLiveSubscription(account: Account): boolean {
  const billing = account.billing ?? null;
  return billing !== null && billing.live === true;
}

/**
 * The plans this account can buy with a checkout: none with a subscription or a contract, and
 * none while a checkout just paid is waiting for Stripe's confirmation (a second one would be a
 * second subscription).
 */
function buyable(account: Account): PaidPlan[] {
  if (awaitingCheckout) return [];
  // An invoice of the last plan is unpaid: a new one is bought once it is paid.
  if ((account.billing?.unpaid_invoice ?? null) !== null) return [];
  if (hasLiveSubscription(account) || account.account.plan === 'enterprise') return [];
  const plan = account.account.plan;
  return (['pro', 'scale'] as const).filter(
    (candidate) => !(plan === candidate || (plan === 'scale' && candidate === 'pro')),
  );
}

function renderBilling(account: Account): void {
  // `null` from an API that answers without the field, as well as from one that has no
  // subscription to report.
  const billing = account.billing ?? null;
  const choices = buyable(account);
  const pro = element<HTMLButtonElement>('dash-upgrade-pro');
  const scale = element<HTMLButtonElement>('dash-upgrade-scale');
  const manage = element<HTMLButtonElement>('dash-manage');
  pro.hidden = !choices.includes('pro');
  scale.hidden = !choices.includes('scale');
  // One filled button per section: the first thing this account can do.
  scale.classList.toggle('primary', pro.hidden);
  manage.hidden = billing === null;
  manage.classList.toggle('primary', choices.length === 0);

  // A change between the two paid plans is the dashboard's: up at once, down on the first.
  const switcher = element<HTMLButtonElement>('dash-switch');
  const keep = element<HTMLButtonElement>('dash-keep');
  const settled =
    billing !== null && billing.live === true && ['active', 'trialing'].includes(billing.status);
  const scheduled = billing !== null && isPaidPlan(billing.scheduled_plan);
  const other: PaidPlan | null = billing === null ? null : billing.plan === 'pro' ? 'scale' : 'pro';
  switcher.hidden = !settled || scheduled || billing?.cancel_at_period_end === true;
  if (other !== null) {
    switcher.dataset.changePlan = other;
    switcher.textContent = `Switch to ${planLabel(other)}`;
  }
  keep.hidden = !settled || !scheduled;
  if (billing !== null) keep.textContent = `Keep ${planLabel(billing.plan)}`;

  const unpaid = element('dash-unpaid');
  const invoice = billing?.unpaid_invoice ?? null;
  unpaid.hidden = invoice === null;
  if (invoice !== null) {
    element('dash-unpaid-text').textContent =
      `${invoice.number ?? 'An invoice'} of ${money(invoice.amount_due, invoice.currency)} was left open when the subscription closed. A paid plan can be bought again once it is paid.`;
    const link = element<HTMLAnchorElement>('dash-unpaid-link');
    link.hidden = invoice.url === null;
    if (invoice.url !== null) link.href = invoice.url;
  }

  const status = element('billing-status');
  const pastDue = element('dash-past-due');
  pastDue.hidden = true;
  if (billing === null) {
    status.hidden = true;
    return;
  }
  status.hidden = false;
  const period = longDate(billing.current_period_end);
  let text: string;
  switch (billing.status) {
    case 'active':
    case 'trialing':
      text = billing.cancel_at_period_end
        ? `${planLabel(billing.plan)} subscription, cancelled: it ends on ${period} (UTC), and the account goes back to Free then.`
        : isPaidPlan(billing.scheduled_plan)
          ? `${planLabel(billing.plan)} subscription. It moves to ${planLabel(billing.scheduled_plan)} on ${period} (UTC).`
          : `${planLabel(billing.plan)} subscription, active. It renews on ${period} (UTC).`;
      break;
    case 'past_due':
      text = `${planLabel(billing.plan)} subscription, payment failed.`;
      pastDue.hidden = false;
      element('dash-past-due-text').textContent =
        `Stripe is retrying the payment. If none succeeds by ${longDate(billing.grace_ends_at)} (UTC), the subscription closes and the account goes back to Free. Nothing is deleted.`;
      break;
    case 'incomplete':
      text = `${planLabel(billing.plan)} subscription: the first payment is being confirmed.`;
      break;
    default:
      text = `The ${planLabel(billing.plan)} subscription has ended.`;
  }
  status.textContent = text;
}

/** The plan asked for in the address, or by the sign in link: opened once the account is read. */
let pendingUpgrade: PaidPlan | null = null;

function openUpgrade(plan: PaidPlan): void {
  const account = current;
  if (account === null) return;
  const panel = element('dash-upgrade-panel');
  if (!buyable(account).includes(plan)) {
    say(
      'dash-status',
      hasLiveSubscription(account)
        ? 'This account already has a subscription: switch between Pro and Scale here, above.'
        : `This account is already on ${planLabel(account.account.plan)}.`,
    );
    return;
  }
  panel.dataset.plan = plan;
  element('upgrade-title').textContent = `Upgrade to ${planLabel(plan)}`;
  element('upgrade-offer').textContent =
    (plan === 'pro' ? panel.dataset.offerPro : panel.dataset.offerScale) ?? '';
  element('upgrade-terms').hidden = (account.terms?.accepted_at ?? null) !== null;
  element<HTMLInputElement>('upgrade-accept-terms').checked = false;
  element<HTMLInputElement>('upgrade-approve-clauses').checked = false;
  say('upgrade-status', '');
  panel.hidden = false;
  panel.scrollIntoView({ block: 'nearest' });
  element<HTMLButtonElement>('upgrade-submit').focus();
}

function wireBilling(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '#dash-app button[data-upgrade-plan]',
  )) {
    button.addEventListener('click', () => {
      const plan = button.dataset.upgradePlan ?? null;
      if (isPaidPlan(plan)) openUpgrade(plan);
    });
  }
  element('upgrade-cancel').addEventListener('click', () => {
    element('dash-upgrade-panel').hidden = true;
  });
  element('dash-upgrade-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void checkout();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-manage-billing]')) {
    button.addEventListener('click', () => {
      void portal(button);
    });
  }
  const switcher = element<HTMLButtonElement>('dash-switch');
  switcher.addEventListener('click', () => {
    const plan = switcher.dataset.changePlan ?? null;
    if (isPaidPlan(plan)) void changePlan(plan);
  });
  element<HTMLButtonElement>('dash-keep').addEventListener('click', () => {
    void keepPlan();
  });
}

/**
 * Pro to Scale at once (the difference for the rest of the month is invoiced now, so it is
 * confirmed first), Scale to Pro on the first of the next month.
 */
async function changePlan(plan: PaidPlan): Promise<void> {
  const session = readSession();
  if (session === null || current === null) return;
  const up = plan === 'scale';
  const confirmed = window.confirm(
    up
      ? 'Switch to Scale now? The difference for the rest of this month is invoiced and charged now, and Scale applies at once.'
      : 'Switch to Pro on the first of next month? Scale stays until then, and nothing is refunded.',
  );
  if (!confirmed) return;
  const button = element<HTMLButtonElement>('dash-switch');
  button.disabled = true;
  say('dash-status', up ? 'Switching to Scale...' : 'Scheduling the move to Pro...');
  let result: {
    status: number;
    body: {
      effective?: string;
      effective_at?: string | null;
      payment_url?: string | null;
    } & ApiError;
  };
  try {
    result = await call<{
      effective?: string;
      effective_at?: string | null;
      payment_url?: string | null;
    }>('POST', '/v1/dashboard/billing/change', {
      token: session.token,
      body: { plan },
    });
  } catch {
    button.disabled = false;
    say('dash-status', 'The API could not be reached. Try again in a minute.');
    return;
  }
  button.disabled = false;
  if (result.status !== 200) {
    say('dash-status', explain(result.body, 'The plan could not be changed.'));
    return;
  }
  await loadAccount(session, undefined, true);
  if (result.body.effective === 'pending_payment') {
    // The card refused the difference: Stripe keeps the move waiting for its payment, for about a
    // day, and the plan stays Pro until then.
    sayWithLink(
      'dash-status',
      'The payment of the difference did not go through, so you are still on Pro. Scale starts as soon as the invoice is paid: ',
      result.body.payment_url ?? null,
      'pay the invoice',
    );
    return;
  }
  say(
    'dash-status',
    up
      ? 'Your plan is now Scale.'
      : `Your plan moves to Pro on ${longDate(result.body.effective_at ?? null)} (UTC).`,
  );
}

/** A sentence with a link at its end, built with DOM nodes: nothing from the API is HTML. */
function sayWithLink(id: string, text: string, href: string | null, label: string): void {
  const target = element(id);
  target.textContent = text;
  if (href === null || !/^https:\/\//.test(href)) {
    target.append('the link is in the email Stripe sends.');
    return;
  }
  const link = document.createElement('a');
  link.href = href;
  link.rel = 'noopener';
  link.textContent = label;
  target.append(link, '.');
}

/** The scheduled move to Pro, cancelled: Scale stays. */
async function keepPlan(): Promise<void> {
  const session = readSession();
  if (session === null) return;
  const button = element<HTMLButtonElement>('dash-keep');
  button.disabled = true;
  let result: { status: number; body: ApiError };
  try {
    result = await call('POST', '/v1/dashboard/billing/change/cancel', { token: session.token });
  } catch {
    button.disabled = false;
    say('dash-status', 'The API could not be reached. Try again in a minute.');
    return;
  }
  button.disabled = false;
  if (result.status !== 200) {
    say('dash-status', explain(result.body, 'The scheduled change could not be cancelled.'));
    return;
  }
  await loadAccount(session, undefined, true);
  say('dash-status', 'The scheduled change is cancelled: your plan stays as it is.');
}

async function checkout(): Promise<void> {
  const session = readSession();
  const panel = element('dash-upgrade-panel');
  const plan = panel.dataset.plan ?? null;
  if (session === null || !isPaidPlan(plan)) return;
  const needsTerms = !element('upgrade-terms').hidden;
  const accept = element<HTMLInputElement>('upgrade-accept-terms');
  const approve = element<HTMLInputElement>('upgrade-approve-clauses');
  if (needsTerms && (!accept.checked || !approve.checked)) {
    say('upgrade-status', 'Tick both boxes first: the plan is sold under these terms.');
    (accept.checked ? approve : accept).focus();
    return;
  }
  const submit = element<HTMLButtonElement>('upgrade-submit');
  submit.disabled = true;
  say('upgrade-status', 'Opening the checkout...');
  let result: { status: number; body: { url?: string } & ApiError };
  try {
    result = await call<{ url?: string }>('POST', '/v1/dashboard/billing/checkout', {
      token: session.token,
      body: { plan, ...(needsTerms ? { accept_terms: true, approve_clauses: true } : {}) },
    });
  } catch {
    submit.disabled = false;
    say('upgrade-status', 'The API could not be reached. Try again in a minute.');
    return;
  }
  if (result.status === 401) {
    forgetSession();
    showSignIn('Your session has ended. Ask for a new link.');
    return;
  }
  if (result.status !== 200 || result.body.url === undefined) {
    submit.disabled = false;
    say('upgrade-status', explain(result.body, 'The checkout could not be opened.'));
    return;
  }
  // Stripe's own page: the card is typed there, never here.
  window.location.assign(result.body.url);
}

async function portal(button: HTMLButtonElement): Promise<void> {
  const session = readSession();
  if (session === null) return;
  button.disabled = true;
  let result: { status: number; body: { url?: string } & ApiError };
  try {
    result = await call<{ url?: string }>('POST', '/v1/dashboard/billing/portal', {
      token: session.token,
    });
  } catch {
    button.disabled = false;
    say('dash-status', 'The API could not be reached. Try again in a minute.');
    return;
  }
  button.disabled = false;
  if (result.status === 401) {
    forgetSession();
    showSignIn('Your session has ended. Ask for a new link.');
    return;
  }
  if (result.status !== 200 || result.body.url === undefined) {
    say('dash-status', explain(result.body, 'The billing portal could not be opened.'));
    return;
  }
  window.location.assign(result.body.url);
}

/**
 * The way back from Stripe. After a payment the plan changes when Stripe confirms it to the API,
 * usually within seconds: the page reads the account again a few times, and says so meanwhile.
 */
/**
 * Back from a paid checkout: the plan changes when Stripe's event arrives, so the account is read
 * again every two seconds, for half a minute. Meanwhile no upgrade button is offered: a second
 * checkout paid now would be a second subscription.
 */
async function afterCheckout(session: StoredSession): Promise<void> {
  awaitingCheckout = true;
  if (current !== null) renderBilling(current);
  say(
    'dash-status',
    'Thank you. The plan changes as soon as Stripe confirms the payment, usually within seconds.',
  );
  try {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, CHECKOUT_POLL_MS));
      if (!(await loadAccount(session, undefined, true))) return;
      if (current !== null && hasLiveSubscription(current)) {
        say('dash-status', `Your plan is now ${planLabel(current.account.plan)}.`);
        return;
      }
    }
    say('dash-status', 'Stripe has not confirmed yet. Reload the page in a minute.');
  } finally {
    awaitingCheckout = false;
    if (current !== null) renderBilling(current);
  }
}

function field<T extends HTMLElement = HTMLElement>(scope: ParentNode, name: string): T {
  const found = scope.querySelector<T>(`[data-field="${name}"]`);
  if (found === null) throw new Error(`[data-field="${name}"] is missing from a template`);
  return found;
}

function template(id: string): DocumentFragment {
  const found = document.getElementById(id);
  if (!(found instanceof HTMLTemplateElement)) throw new Error(`#${id} is not a template`);
  return found.content.cloneNode(true) as DocumentFragment;
}

function maskedPrefix(key: ApiKey): string {
  return `${key.kind === 'publishable' ? 'pk' : 'sk'}_${key.environment}_${key.prefix}…`;
}

async function copy(text: string, button: HTMLButtonElement, label?: HTMLElement): Promise<void> {
  if (navigator.clipboard === undefined) return;
  await navigator.clipboard.writeText(text);
  const target = label ?? button;
  const before = target.textContent;
  target.textContent = 'Copied';
  window.setTimeout(() => {
    target.textContent = before;
  }, 2000);
}

function renderKey(project: Project, key: ApiKey, session: StoredSession): DocumentFragment {
  const row = template('tpl-key');
  const tr = row.querySelector('tr');
  tr?.setAttribute('data-status', key.status);
  tr?.setAttribute('data-key-id', key.id);
  field(row, 'environment').textContent = key.environment;
  field(row, 'name').textContent = key.name ?? '';
  field(row, 'prefix').textContent = maskedPrefix(key);
  field(row, 'created').textContent = instant(key.created_at);
  field(row, 'last-used').textContent = instant(key.last_used_at);
  field(row, 'status').textContent = key.status === 'active' ? 'Active' : 'Revoked';
  field(row, 'copy-id-label').textContent = `Copy the id of ${maskedPrefix(key)}`;
  field(row, 'revoke-label').textContent = `Revoke ${maskedPrefix(key)}`;

  const copyId = row.querySelector<HTMLButtonElement>('[data-copy-id]');
  copyId?.addEventListener('click', () => {
    void copy(key.id, copyId);
  });

  const revoke = row.querySelector<HTMLButtonElement>('[data-revoke]');
  if (revoke !== null) {
    if (key.status === 'revoked') revoke.hidden = true;
    revoke.addEventListener('click', () => {
      void revokeKey(project, key, session);
    });
  }
  return row;
}

function renderProjects(account: Account, session: StoredSession): void {
  const container = element('dash-projects');
  container.replaceChildren();
  for (const project of account.projects) {
    const fragment = template('tpl-project');
    const article = fragment.querySelector('article');
    article?.setAttribute('data-project-id', project.id);
    field(fragment, 'name').textContent = project.name;
    field(fragment, 'meta').textContent =
      `${project.id} · ${project.default_timezone} · ${project.default_currency}`;
    const body = field(fragment, 'keys');
    for (const key of project.api_keys) body.append(renderKey(project, key, session));
    for (const button of fragment.querySelectorAll<HTMLButtonElement>('[data-create]')) {
      const environment = button.dataset.create === 'live' ? 'live' : 'test';
      button.addEventListener('click', () => {
        if (article !== null) void createKey(project, environment, session, article, button);
      });
    }
    container.append(fragment);
  }
}

/**
 * Reads the account and draws it. `stay` is for the read that follows a creation: then a failure
 * leaves the page as it is, secret included, and only says so; the caller writes the sentence.
 */
async function loadAccount(
  session: StoredSession,
  keepSecret?: () => void,
  stay = false,
): Promise<boolean> {
  if (!stay) say('dash-status', 'Loading...');
  let result: { status: number; body: Account & ApiError };
  try {
    result = await call<Account>('GET', '/v1/dashboard/account', { token: session.token });
  } catch {
    if (!stay) say('dash-status', 'The API could not be reached. Reload the page in a minute.');
    return false;
  }
  if (result.status === 401) {
    forgetSession();
    if (!stay) showSignIn('Your session has ended. Ask for a new link.');
    return false;
  }
  if (result.status !== 200) {
    if (!stay) say('dash-status', explain(result.body, 'The account could not be read.'));
    return false;
  }
  current = result.body;
  say('dash-status', '');
  element('dash-signin').hidden = true;
  element('dash-app').hidden = false;
  say('dash-account-name', current.account.name);
  say('dash-owner', `${current.account.owner_email} · ${current.account.id}`);
  renderUsage(current);
  renderProjects(current, session);
  keepSecret?.();
  return true;
}

async function createKey(
  project: Project,
  environment: 'test' | 'live',
  session: StoredSession,
  article: HTMLElement,
  button: HTMLButtonElement,
): Promise<void> {
  const status = field(article, 'project-status');
  button.disabled = true;
  status.textContent = `Creating a ${environment} key...`;
  let result: { status: number; body: ApiKey & ApiError };
  try {
    result = await call<ApiKey>('POST', `/v1/dashboard/projects/${project.id}/keys`, {
      token: session.token,
      body: { environment },
    });
  } catch {
    button.disabled = false;
    status.textContent = 'The API could not be reached. Try again in a minute.';
    return;
  }
  button.disabled = false;
  if (result.status === 401) {
    forgetSession();
    showSignIn('Your session has ended. Ask for a new link.');
    return;
  }
  if (result.status !== 201 || result.body.secret_key === undefined) {
    status.textContent = explain(result.body, 'The key could not be created.');
    return;
  }
  const secret = result.body.secret_key;
  const label = `New ${environment} key: ${result.body.name ?? ''}`;
  // The secret is shown from the answer of the creation, at once, before anything else can fail:
  // it exists in this tab and nowhere else. Then the list is read again, and the box is put back
  // in the fresh copy of the project. If that read fails, the box stays where it is and a line
  // says to reload for the list.
  showSecret(article, label, secret);
  const reloaded = await loadAccount(
    session,
    () => {
      const fresh = document.querySelector<HTMLElement>(`[data-project-id="${project.id}"]`);
      if (fresh !== null) showSecret(fresh, label, secret);
    },
    true,
  );
  if (!reloaded) {
    field(article, 'project-status').textContent =
      'Key created. The list could not be read again: copy the key now, then reload the page.';
  }
}

function showSecret(article: HTMLElement, label: string, secret: string): void {
  const box = field(article, 'secret');
  field(article, 'secret-label').textContent = label;
  field(article, 'secret-value').textContent = secret;
  box.hidden = false;
  const button = box.querySelector<HTMLButtonElement>('[data-copy-secret]');
  const buttonLabel = box.querySelector<HTMLElement>('.copy-label') ?? undefined;
  button?.addEventListener('click', () => {
    void copy(secret, button, buttonLabel);
  });
  field(article, 'project-status').textContent = 'Key created.';
}

async function revokeKey(project: Project, key: ApiKey, session: StoredSession): Promise<void> {
  const others = project.api_keys.filter(
    (candidate) =>
      candidate.id !== key.id &&
      candidate.status === 'active' &&
      candidate.environment === key.environment &&
      candidate.kind === 'secret',
  );
  const warning =
    others.length === 0
      ? `\n\nIt is the last active ${key.environment} key of ${project.name}: ${key.environment} requests of this project will be refused until you create a new one.`
      : '';
  const confirmed = window.confirm(
    `Revoke ${maskedPrefix(key)}? Every request made with it will be refused from now on. This cannot be undone.${warning}`,
  );
  if (!confirmed) return;
  let result: { status: number; body: ApiKey & ApiError };
  try {
    result = await call<ApiKey>('DELETE', `/v1/dashboard/keys/${key.id}`, {
      token: session.token,
    });
  } catch {
    say('dash-status', 'The API could not be reached. Try again in a minute.');
    return;
  }
  if (result.status === 401) {
    forgetSession();
    showSignIn('Your session has ended. Ask for a new link.');
    return;
  }
  if (result.status !== 200) {
    say('dash-status', explain(result.body, 'The key could not be revoked.'));
    return;
  }
  await loadAccount(session);
}

function wireSignOut(): void {
  element('dash-signout').addEventListener('click', () => {
    const session = readSession();
    forgetSession();
    current = null;
    showSignIn('Signed out.');
    if (session === null) return;
    // The session ends on the server too; the tab has already forgotten it either way.
    void call('POST', '/v1/dashboard/logout', { token: session.token }).catch(() => undefined);
  });
}

if (root !== null) {
  // What the address asks for, read once and taken off the address bar: a reload must not open
  // a checkout a second time.
  const params = new URLSearchParams(window.location.search);
  const asked = params.get('upgrade');
  const back = params.get('checkout');
  pendingUpgrade = isPaidPlan(asked) ? asked : null;
  if (params.has('upgrade') || params.has('checkout')) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  wireSignIn();
  wireSignOut();
  wireBilling();
  const session = readSession();
  if (session === null) {
    showSignIn(
      pendingUpgrade === null
        ? undefined
        : `Sign in to buy ${planLabel(pendingUpgrade)}: we send a link to the address of your account.`,
    );
  } else {
    void loadAccount(session).then((loaded) => {
      if (!loaded) return;
      if (back === 'success') void afterCheckout(session);
      else if (back === 'cancel')
        say('dash-status', 'The checkout was cancelled. Nothing was charged.');
      if (pendingUpgrade !== null) openUpgrade(pendingUpgrade);
      pendingUpgrade = null;
    });
  }
}
