/**
 * The billing of the dashboard, in a real browser, with the API answered by the test.
 *
 *  - a free account sees the two paid plans; the panel asks for the two boxes of the terms when
 *    the account has not accepted them, sends them with the checkout, and goes to Stripe;
 *  - `/dashboard/?upgrade=scale` opens the panel of Scale once the account is read;
 *  - a subscribed account sees its plan, the renewal or the scheduled move, and «Manage billing»;
 *  - a failed payment is said at the top, with the date the grace ends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { browserChannel, serveDist } from './helpers.js';

let browser: Browser;
let origin: string;
let stop: () => Promise<void>;

beforeAll(async () => {
  const server = await serveDist();
  origin = server.origin;
  stop = server.close;
  browser = await chromium.launch({ channel: browserChannel });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await stop?.();
});

const SESSION = JSON.stringify({
  token: `bds_${'a'.repeat(43)}`,
  expires_at: '2999-01-01T00:00:00.000Z',
});

function accountBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'dashboard_account',
    account: {
      id: 'acct_0190f2a17c3e7d4b8a9f0123456789ab',
      object: 'account',
      name: 'Padel Roma',
      plan: 'free',
      owner_email: 'owner@example.com',
    },
    usage: {
      month: '2026-09',
      bookings_confirmed: 12,
      bookings_included: 1000,
      payment_volume: 0,
      payment_volume_included: 100000,
      currency: null,
      blocks_at_limit: true,
    },
    reserved: { bookings_pending: 0, payment_volume_pending: 0 },
    projects: [],
    session: { expires_at: '2999-01-01T00:00:00.000Z' },
    billing: null,
    terms: { terms_version: 'v', dpa_version: 'v', accepted_at: '2026-09-24T10:00:00.000Z' },
    ...overrides,
  };
}

interface Seen {
  checkout: Record<string, unknown>[];
  portal: number;
  change: Record<string, unknown>[];
  cancel: number;
}

/** The API, answered: the account as given, the checkout and the portal pointing at a fake Stripe. */
async function mockApi(page: Page, account: Record<string, unknown>): Promise<Seen> {
  const seen: Seen = { checkout: [], portal: 0, change: [], cancel: 0 };
  await page.route('https://api.bookrail.dev/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const json = (status: number, body: unknown): Promise<void> =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/v1/dashboard/account') return json(200, account);
    if (url.pathname === '/v1/dashboard/billing/checkout') {
      seen.checkout.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
      return json(200, {
        object: 'billing_checkout',
        url: 'https://checkout.stripe.test/c/pay/cs_1',
      });
    }
    if (url.pathname === '/v1/dashboard/billing/change') {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      seen.change.push(body);
      return json(200, {
        object: 'billing_change',
        plan: body.plan,
        effective: body.plan === 'scale' ? 'now' : 'period_end',
        effective_at: '2026-11-01T00:00:00.000Z',
      });
    }
    if (url.pathname === '/v1/dashboard/billing/change/cancel') {
      seen.cancel += 1;
      return json(200, {
        object: 'billing_change',
        plan: 'scale',
        effective: 'now',
        effective_at: '2026-10-15T00:00:00.000Z',
      });
    }
    if (url.pathname === '/v1/dashboard/billing/portal') {
      seen.portal += 1;
      return json(200, {
        object: 'billing_portal',
        url: 'https://billing.stripe.test/p/session/1',
      });
    }
    return json(404, { error: { code: 'unknown_endpoint', message: 'no' } });
  });
  // Stripe's pages, answered too, so that the navigation there can be observed.
  await page.route('https://*.stripe.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Stripe</title>' }),
  );
  await page.goto(`${origin}/pricing/`);
  await page.evaluate((value) => {
    sessionStorage.setItem('bookrail.dashboard.session', value);
  }, SESSION);
  return seen;
}

async function visible(page: Page, selector: string): Promise<boolean> {
  return page.isVisible(selector);
}

describe('a free account', () => {
  it('buys Pro: the two boxes first, then Stripe Checkout', async () => {
    const page = await browser.newPage();
    try {
      const seen = await mockApi(
        page,
        accountBody({ terms: { terms_version: 'v', dpa_version: 'v', accepted_at: null } }),
      );
      await page.goto(`${origin}/dashboard/`);
      await page.waitForSelector('#dash-app:not([hidden])');
      expect(await visible(page, '#dash-upgrade-pro')).toBe(true);
      expect(await visible(page, '#dash-upgrade-scale')).toBe(true);
      expect(await visible(page, '#dash-manage')).toBe(false);
      expect(await visible(page, '#billing-status')).toBe(false);

      await page.click('#dash-upgrade-pro');
      await page.waitForSelector('#dash-upgrade-panel:not([hidden])');
      expect(await page.textContent('#upgrade-title')).toBe('Upgrade to Pro');
      expect(await page.textContent('#upgrade-offer')).toContain('€29 a month, VAT excluded');
      expect(await visible(page, '#upgrade-terms')).toBe(true);

      // Without the boxes nothing is sent.
      await page.click('#upgrade-submit');
      await page.waitForFunction(
        () => (document.getElementById('upgrade-status')?.textContent ?? '') !== '',
      );
      expect(await page.textContent('#upgrade-status')).toContain('Tick both boxes');
      expect(seen.checkout).toEqual([]);

      await page.check('#upgrade-accept-terms');
      await page.check('#upgrade-approve-clauses');
      await Promise.all([
        page.waitForURL('https://checkout.stripe.test/**'),
        page.click('#upgrade-submit'),
      ]);
      expect(seen.checkout).toEqual([{ plan: 'pro', accept_terms: true, approve_clauses: true }]);
    } finally {
      await page.close();
    }
  });

  it('opens the panel of the plan in the address, without the boxes once they are accepted', async () => {
    const page = await browser.newPage();
    try {
      const seen = await mockApi(page, accountBody());
      await page.goto(`${origin}/dashboard/?upgrade=scale`);
      await page.waitForSelector('#dash-upgrade-panel:not([hidden])');
      expect(await page.textContent('#upgrade-title')).toBe('Upgrade to Scale');
      expect(await visible(page, '#upgrade-terms')).toBe(false);
      // The address no longer asks for anything: a reload does not open a second checkout.
      expect(new URL(page.url()).search).toBe('');
      await Promise.all([
        page.waitForURL('https://checkout.stripe.test/**'),
        page.click('#upgrade-submit'),
      ]);
      expect(seen.checkout).toEqual([{ plan: 'scale' }]);
    } finally {
      await page.close();
    }
  });
});

describe('back from a paid checkout', () => {
  it('offers no second checkout while Stripe confirms, then says the plan changed', async () => {
    const page = await browser.newPage();
    try {
      let reads = 0;
      const free = accountBody();
      const pro = accountBody({
        account: {
          id: 'acct_0190f2a17c3e7d4b8a9f0123456789ab',
          object: 'account',
          name: 'Padel Roma',
          plan: 'pro',
          owner_email: 'owner@example.com',
        },
        billing: {
          status: 'active',
          live: true,
          plan: 'pro',
          current_period_end: '2026-11-01T00:00:00.000Z',
          cancel_at_period_end: false,
          scheduled_plan: null,
          past_due_since: null,
          grace_ends_at: null,
        },
      });
      await mockApi(page, free);
      // The event of Stripe arrives after the second reading.
      await page.route('https://api.bookrail.dev/v1/dashboard/account', (route) => {
        reads += 1;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(reads <= 2 ? free : pro),
        });
      });
      await page.clock.install();
      await page.goto(`${origin}/dashboard/?checkout=success`);
      await page.waitForSelector('#dash-app:not([hidden])');
      await page.waitForFunction(() =>
        (document.getElementById('dash-status')?.textContent ?? '').includes('Thank you'),
      );
      // Waiting: the account is still free, and no upgrade is offered.
      expect(await visible(page, '#dash-upgrade-pro')).toBe(false);
      expect(await visible(page, '#dash-upgrade-scale')).toBe(false);
      // The address no longer carries the return: a reload does not wait again.
      expect(new URL(page.url()).search).toBe('');

      // Two seconds of the page's clock at a time, each followed by the reading it triggers,
      // until the page has read the account in which Stripe's confirmation has arrived.
      for (let tick = 0; tick < 10 && reads < 3; tick += 1) {
        const before = reads;
        await page.clock.runFor(2000);
        const deadline = Date.now() + 2000;
        while (reads === before && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(reads).toBeGreaterThanOrEqual(3);
      await page.waitForFunction(
        () =>
          (document.getElementById('dash-status')?.textContent ?? '') === 'Your plan is now Pro.',
      );
      expect(await page.textContent('#billing-status')).toContain('Pro subscription, active.');
      expect(await visible(page, '#dash-manage')).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe('a subscribed account', () => {
  it('shows the plan, the renewal and the portal, and no checkout', async () => {
    const page = await browser.newPage();
    try {
      const seen = await mockApi(
        page,
        accountBody({
          account: {
            id: 'acct_0190f2a17c3e7d4b8a9f0123456789ab',
            object: 'account',
            name: 'Padel Roma',
            plan: 'pro',
            owner_email: 'owner@example.com',
          },
          billing: {
            status: 'active',
            live: true,
            plan: 'pro',
            current_period_end: '2026-11-01T00:00:00.000Z',
            cancel_at_period_end: false,
            scheduled_plan: null,
            past_due_since: null,
            grace_ends_at: null,
          },
        }),
      );
      await page.goto(`${origin}/dashboard/`);
      await page.waitForSelector('#dash-app:not([hidden])');
      expect(await page.textContent('#billing-status')).toBe(
        'Pro subscription, active. It renews on 1 November 2026 (UTC).',
      );
      expect(await visible(page, '#dash-upgrade-pro')).toBe(false);
      expect(await visible(page, '#dash-upgrade-scale')).toBe(false);
      expect(await visible(page, '#dash-past-due')).toBe(false);
      await Promise.all([
        page.waitForURL('https://billing.stripe.test/**'),
        page.click('#dash-manage'),
      ]);
      expect(seen.portal).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('says when a move down is scheduled, and when a payment failed, with the end of the grace', async () => {
    const page = await browser.newPage();
    try {
      await mockApi(
        page,
        accountBody({
          account: {
            id: 'acct_0190f2a17c3e7d4b8a9f0123456789ab',
            object: 'account',
            name: 'Padel Roma',
            plan: 'scale',
            owner_email: 'owner@example.com',
          },
          billing: {
            status: 'past_due',
            live: true,
            plan: 'scale',
            current_period_end: '2026-11-01T00:00:00.000Z',
            cancel_at_period_end: false,
            scheduled_plan: 'pro',
            past_due_since: '2026-10-01T00:10:00.000Z',
            grace_ends_at: '2026-10-15T00:10:00.000Z',
          },
        }),
      );
      await page.goto(`${origin}/dashboard/`);
      await page.waitForSelector('#dash-past-due:not([hidden])');
      expect(await page.textContent('#dash-past-due-text')).toContain('by 15 October 2026 (UTC)');
      expect(await page.textContent('#billing-status')).toBe('Scale subscription, payment failed.');

      await page.unroute('https://api.bookrail.dev/**');
      await mockApi(
        page,
        accountBody({
          account: {
            id: 'acct_0190f2a17c3e7d4b8a9f0123456789ab',
            object: 'account',
            name: 'Padel Roma',
            plan: 'scale',
            owner_email: 'owner@example.com',
          },
          billing: {
            status: 'active',
            live: true,
            plan: 'scale',
            current_period_end: '2026-11-01T00:00:00.000Z',
            cancel_at_period_end: false,
            scheduled_plan: 'pro',
            past_due_since: null,
            grace_ends_at: null,
          },
        }),
      );
      await page.goto(`${origin}/dashboard/`);
      await page.waitForSelector('#dash-app:not([hidden])');
      await page.waitForFunction(
        () => document.getElementById('billing-status')?.textContent !== '',
      );
      expect(await page.textContent('#billing-status')).toBe(
        'Scale subscription. It moves to Pro on 1 November 2026 (UTC).',
      );
      expect(await visible(page, '#dash-past-due')).toBe(false);
    } finally {
      await page.close();
    }
  });
});

describe('the plan of a subscribed account', () => {
  const scale = (scheduled: 'pro' | null) =>
    accountBody({
      account: {
        id: 'acct_0190f2a17c3e7d4b8a9f0123456789ab',
        object: 'account',
        name: 'Padel Roma',
        plan: 'scale',
        owner_email: 'owner@example.com',
      },
      billing: {
        status: 'active',
        live: true,
        plan: 'scale',
        current_period_end: '2026-11-01T00:00:00.000Z',
        cancel_at_period_end: false,
        scheduled_plan: scheduled,
        past_due_since: null,
        grace_ends_at: null,
        unpaid_invoice: null,
      },
    });

  it('switches Scale to Pro on the first, after asking, and keeps Scale when asked', async () => {
    const page = await browser.newPage();
    try {
      const seen = await mockApi(page, scale(null));
      page.on('dialog', (dialog) => void dialog.accept());
      await page.goto(`${origin}/dashboard/`);
      await page.waitForSelector('#dash-switch:not([hidden])');
      expect(await page.textContent('#dash-switch')).toContain('Switch to Pro');
      expect(await visible(page, '#dash-keep')).toBe(false);
      await page.click('#dash-switch');
      await page.waitForFunction(() =>
        (document.getElementById('dash-status')?.textContent ?? '').includes('moves to Pro'),
      );
      expect(seen.change).toEqual([{ plan: 'pro' }]);
    } finally {
      await page.close();
    }
  });

  it('says a move up waits for its payment, with the link to the invoice, when the card refused it', async () => {
    const page = await browser.newPage();
    try {
      const pro = accountBody({
        billing: {
          status: 'active',
          live: true,
          plan: 'pro',
          current_period_end: '2026-11-01T00:00:00.000Z',
          cancel_at_period_end: false,
          scheduled_plan: null,
          past_due_since: null,
          grace_ends_at: null,
          unpaid_invoice: null,
        },
      });
      await mockApi(page, pro);
      await page.route('https://api.bookrail.dev/v1/dashboard/billing/change', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            object: 'billing_change',
            plan: 'scale',
            effective: 'pending_payment',
            effective_at: null,
            payment_url: 'https://invoice.stripe.test/i/in_1',
          }),
        }),
      );
      page.on('dialog', (dialog) => void dialog.accept());
      await page.goto(`${origin}/dashboard/`);
      await page.waitForSelector('#dash-switch:not([hidden])');
      await page.click('#dash-switch');
      await page.waitForFunction(() =>
        (document.getElementById('dash-status')?.textContent ?? '').includes('still on Pro'),
      );
      expect(await page.getAttribute('#dash-status a', 'href')).toBe(
        'https://invoice.stripe.test/i/in_1',
      );
      expect(await page.textContent('#dash-status')).not.toContain('now Scale');
    } finally {
      await page.close();
    }
  });

  it('offers to keep Scale while the move to Pro is scheduled', async () => {
    const page = await browser.newPage();
    try {
      const seen = await mockApi(page, scale('pro'));
      await page.goto(`${origin}/dashboard/`);
      await page.waitForSelector('#dash-keep:not([hidden])');
      expect(await page.textContent('#dash-keep')).toContain('Keep Scale');
      expect(await visible(page, '#dash-switch')).toBe(false);
      await page.click('#dash-keep');
      await page.waitForFunction(() =>
        (document.getElementById('dash-status')?.textContent ?? '').includes(
          'scheduled change is cancelled',
        ),
      );
      expect(seen.cancel).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('shows an invoice left unpaid by a closed subscription, with its link, and no upgrade', async () => {
    const page = await browser.newPage();
    try {
      await mockApi(
        page,
        accountBody({
          billing: {
            status: 'canceled',
            live: false,
            plan: 'pro',
            current_period_end: '2026-10-01T00:00:00.000Z',
            cancel_at_period_end: false,
            scheduled_plan: null,
            past_due_since: null,
            grace_ends_at: null,
            unpaid_invoice: {
              id: 'in_1',
              number: 'BR-0042',
              amount_due: 8455,
              currency: 'eur',
              url: 'https://invoice.stripe.test/i/in_1',
            },
          },
        }),
      );
      await page.goto(`${origin}/dashboard/`);
      await page.waitForSelector('#dash-unpaid:not([hidden])');
      expect(await page.textContent('#dash-unpaid-text')).toContain('BR-0042 of 84.55 EUR');
      expect(await page.getAttribute('#dash-unpaid-link', 'href')).toBe(
        'https://invoice.stripe.test/i/in_1',
      );
      expect(await visible(page, '#dash-upgrade-pro')).toBe(false);
      expect(await visible(page, '#dash-switch')).toBe(false);
    } finally {
      await page.close();
    }
  });
});
