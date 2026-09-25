/**
 * Three behaviours of the pages that hold a session or show a key, in a real browser, with the
 * API answered by the test.
 *
 *  - the header says «Dashboard» instead of «Sign in» when the tab has a session, with no call;
 *  - the title of `/signup/confirm` follows what happened;
 *  - a key just created in the dashboard stays on screen even when the list cannot be read again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
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

async function withSession(page: Page): Promise<void> {
  await page.evaluate((value) => {
    sessionStorage.setItem('bookrail.dashboard.session', value);
  }, SESSION);
}

describe('the header', () => {
  // The pricing page loads the header's own script; the homepage carries the same module inside
  // its one file (`nav.ts?home`). Both have to relabel the link.
  it.each(['/pricing/', '/'])(
    'says Sign in without a session, and Dashboard with one, calling nobody (%s)',
    async (path) => {
      const page = await browser.newPage();
      const calls: string[] = [];
      const link = '#site-nav a[data-session-link]';
      page.on('request', (request) => {
        if (request.url().startsWith('https://api.bookrail.dev')) calls.push(request.url());
      });
      try {
        await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
        expect((await page.textContent(link))?.trim()).toBe('Sign in');
        await withSession(page);
        await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
        await page.waitForFunction(
          (selector) => document.querySelector(selector)?.textContent === 'Dashboard',
          link,
        );
        expect(await page.getAttribute(link, 'href')).toBe('/dashboard/');
        expect(calls).toEqual([]);
      } finally {
        await page.close();
      }
    },
  );
});

describe('the title of /signup/confirm', () => {
  const cases: [string, number, Record<string, unknown>, string][] = [
    [
      'keys shown',
      200,
      {
        id: 'sgn_1',
        object: 'signup',
        status: 'confirmed',
        secret_key: `sk_test_${'a'.repeat(43)}`,
        live_secret_key: `sk_live_${'b'.repeat(43)}`,
      },
      'Your keys',
    ],
    [
      'terminal',
      200,
      { id: 'sgn_1', object: 'signup', status: 'confirmed', delivered_to: 'cli' },
      'Your terminal has the keys',
    ],
    [
      'address taken',
      200,
      { id: 'sgn_1', object: 'signup', status: 'email_taken' },
      'This address already has an account',
    ],
    [
      'expired',
      410,
      { error: { type: 'conflict', code: 'signup_expired', message: 'x' } },
      'This link has expired',
    ],
    [
      'used',
      409,
      { error: { type: 'conflict', code: 'signup_already_confirmed', message: 'x' } },
      'This link has been used',
    ],
  ];

  it.each(cases)('%s', async (_what, status, body, title) => {
    const page = await browser.newPage();
    try {
      await page.route('https://api.bookrail.dev/**', (route) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
      );
      await page.goto(`${origin}/signup/confirm#token=whatever`);
      await page.waitForFunction(
        () => document.getElementById('confirm-title')?.textContent !== 'Confirming',
      );
      expect(await page.textContent('#confirm-title')).toBe(title);
    } finally {
      await page.close();
    }
  });
});

describe('a key created in the dashboard', () => {
  it('stays on screen when the list cannot be read again', async () => {
    const account = {
      object: 'dashboard_account',
      account: {
        id: 'acct_1',
        object: 'account',
        name: 'Padel',
        plan: 'free',
        owner_email: 'a@example.com',
      },
      usage: {
        month: '2026-09',
        bookings_confirmed: 0,
        bookings_included: 1000,
        payment_volume: 0,
        payment_volume_included: 100000,
        currency: null,
        blocks_at_limit: true,
      },
      reserved: { bookings_pending: 0, payment_volume_pending: 0 },
      projects: [
        {
          id: 'proj_1',
          object: 'project',
          name: 'Default',
          default_timezone: 'UTC',
          default_currency: 'EUR',
          created_at: '2026-09-24T09:00:00.000Z',
          api_keys: [],
        },
      ],
      session: { expires_at: '2999-01-01T00:00:00.000Z' },
    };
    const secret = `sk_live_${'c'.repeat(43)}`;
    let reads = 0;
    const page = await browser.newPage();
    try {
      await page.route('https://api.bookrail.dev/**', (route) => {
        const url = route.request().url();
        if (url.endsWith('/v1/dashboard/account')) {
          reads += 1;
          // The first read draws the page; the one after the creation fails.
          return reads === 1
            ? route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(account),
              })
            : route.abort('failed');
        }
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'key_1',
            object: 'api_key',
            environment: 'live',
            kind: 'secret',
            name: 'live secret key',
            prefix: 'cccccccc',
            tenant_id: null,
            status: 'active',
            created_at: '2026-09-24T09:00:00.000Z',
            last_used_at: null,
            revoked_at: null,
            secret_key: secret,
          }),
        });
      });
      await page.goto(`${origin}/dashboard/`);
      await withSession(page);
      await page.reload();
      await page.locator('#dash-app').waitFor({ state: 'visible' });
      await page.click('#dash-projects [data-create="live"]');
      await page.waitForFunction(() =>
        (document.querySelector('[data-field="project-status"]')?.textContent ?? '').includes(
          'reload',
        ),
      );
      expect(await page.textContent('[data-field="secret-value"]')).toBe(secret);
      expect(await page.isVisible('[data-field="secret"]')).toBe(true);
    } finally {
      await page.close();
    }
  });
});
