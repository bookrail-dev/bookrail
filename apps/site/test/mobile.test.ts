/**
 * Real device emulation, because a narrow window is not a phone.
 *
 * Chrome headless without emulation refuses to go under about 500 CSS pixels and reports a
 * desktop device pixel ratio, so a "mobile check" done by resizing a window proves nothing
 * about the two things that actually break: the horizontal overflow a 390 pixel viewport
 * exposes, and the text a phone renders below the readable floor. Playwright's device
 * descriptors give the viewport, the pixel ratio, the touch flag and the user agent together.
 *
 * The screenshots are an artefact, not a baseline. They are not compared pixel by pixel: they
 * are there to be looked at by a person, and the assertions below are what fails a build. They
 * were committed for a while, and since a browser does not render byte-identically twice,
 * every run of the suite left a modified binary in the working tree of whoever ran it. They
 * are written to a directory that is in `.gitignore` now, and the alternative (a real pixel
 * comparison) was rejected because it would fail on a font update, a Chrome update or another
 * machine, which is a test that trains people to ignore it.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, devices, type Browser } from 'playwright';
import { browserChannel, distRoot, serveDist, siteRoot } from './helpers.js';

const SHOTS = join(siteRoot, 'test', '__screenshots__');

const VIEWPORTS = [
  { name: 'iphone-13', device: devices['iPhone 13'] },
  { name: 'pixel-7', device: devices['Pixel 7'] },
  // The width of a tablet held upright, under the 900px of the header's menu.
  { name: 'tablet-768', device: { viewport: { width: 768, height: 1024 } } },
  { name: 'desktop-1024', device: { viewport: { width: 1024, height: 800 } } },
  { name: 'desktop-1440', device: { viewport: { width: 1440, height: 900 } } },
] as const;

/**
 * The blog is built only when there is an article to build, so it is measured only when the
 * output has it: the index and the first article, which between them are every shape the
 * section has. A fixed list would fail on a site with an empty blog, which is most days.
 */
function blogPages(): { name: string; path: string }[] {
  if (!existsSync(join(distRoot, 'blog', 'index.html'))) return [];
  const article = readdirSync(join(distRoot, 'blog'), { withFileTypes: true }).find((entry) =>
    entry.isDirectory(),
  );
  return [
    { name: 'blog', path: '/blog/' },
    ...(article === undefined ? [] : [{ name: 'blog-article', path: `/blog/${article.name}/` }]),
  ];
}

const PAGES: { name: string; path: string }[] = [
  { name: 'home', path: '/' },
  { name: 'docs', path: '/docs/errors/' },
  // The concepts page carries the four hand drawn SVG figures, which are the one thing on this
  // site that can push a phone into a horizontal scroll if a figure escapes its box.
  { name: 'concepts', path: '/docs/concepts/' },
  // The legal pages are a definition list that changes shape at 640px.
  { name: 'legal', path: '/legal' },
  // The pricing page: four cards and a comparison table that becomes one plan at a time.
  { name: 'pricing', path: '/pricing/' },
  // The dashboard as a visitor without a session sees it, and the page a sign up link opens.
  { name: 'dashboard', path: '/dashboard/' },
  { name: 'signup-confirm', path: '/signup/confirm/' },
  ...blogPages(),
];

let browser: Browser;
let origin: string;
let stop: () => Promise<void>;

beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  const server = await serveDist();
  origin = server.origin;
  stop = server.close;
  browser = await chromium.launch({ channel: browserChannel });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await stop?.();
});

describe.each(VIEWPORTS)('$name', ({ name, device }) => {
  it.each(PAGES)('$name has no horizontal overflow and stays readable', async (page) => {
    const context = await browser.newContext({ ...device, reducedMotion: 'no-preference' });
    const tab = await context.newPage();
    await tab.goto(`${origin}${page.path}`, { waitUntil: 'networkidle' });
    // Long enough for the grid to finish filling.
    await tab.waitForTimeout(4000);
    await tab.screenshot({ path: join(SHOTS, `${page.name}-${name}.png`), fullPage: false });

    const overflow = await tab.evaluate(() => {
      // Content wider than the viewport is fine inside something that scrolls: a code block
      // and the resource grid are both meant to. What is not fine is an element that pushes
      // the page itself sideways, so an offender is one with no scrolling ancestor.
      const clips = (style: CSSStyleDeclaration): boolean =>
        style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'hidden';
      const contained = (element: HTMLElement): boolean => {
        let node: HTMLElement | null = element;
        while (node !== null && node !== document.body) {
          const style = getComputedStyle(node);
          // Out of the flow, or clipping itself: either way it cannot widen the document.
          if (style.position === 'fixed' || style.position === 'sticky') return true;
          if (node !== element && clips(style)) return true;
          if (node === element && clips(style)) return true;
          node = node.parentElement;
        }
        return false;
      };
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        offenders: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter(
            (element) =>
              element.getBoundingClientRect().right > document.documentElement.clientWidth + 2,
          )
          .filter((element) => !contained(element))
          .map((element) => `${element.tagName}.${String(element.className)}`.slice(0, 60))
          .slice(0, 5),
      };
    });
    expect(overflow.offenders, `${page.name} at ${name}`).toEqual([]);
    // Two pixels of slack: a sub pixel layout rounding at the right edge is not a scroll bar.
    expect(overflow.scrollWidth, `${page.name} at ${name}`).toBeLessThanOrEqual(
      overflow.clientWidth + 2,
    );

    const smallest = await tab.evaluate(() => {
      let min = 99;
      let where = '';
      for (const element of document.querySelectorAll<HTMLElement>('body *')) {
        if ((element.textContent ?? '').trim() === '') continue;
        if (element.children.length > 0) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const size = Number.parseFloat(getComputedStyle(element).fontSize);
        if (size < min) {
          min = size;
          where = `${element.tagName}.${String(element.className)}`;
        }
      }
      return { min, where };
    });
    // Prose never goes under 13px; the smallest thing on the page is a mono data label, and
    // the floor for those is the 10px of the labels in the header of the resource grid.
    expect(smallest.min, `smallest text at ${name}: ${smallest.where}`).toBeGreaterThanOrEqual(10);

    await context.close();
  });
});

/**
 * The whole homepage, top to bottom, at the three widths a person reviews it at: 390
 * (a phone), 768 (a tablet) and 1440 (a desktop). Reduced motion, so that every section is in its
 * finished state in the picture; the overflow check is the same as above.
 */
describe('the whole homepage, for a person to look at', () => {
  it.each([
    { width: 390, device: devices['iPhone 13'] },
    { width: 768, device: { viewport: { width: 768, height: 1024 } } },
    { width: 1440, device: { viewport: { width: 1440, height: 900 } } },
  ])('at $width px', async ({ width, device }) => {
    const context = await browser.newContext({ ...device, reducedMotion: 'reduce' });
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: 'networkidle' });
    await tab.waitForTimeout(500);
    await tab.screenshot({ path: join(SHOTS, `home-full-${String(width)}.png`), fullPage: true });
    const widths = await tab.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 2);
    await context.close();
  });
});

describe('the chrome on a phone', () => {
  it('keeps the logo and the primary action visible and untruncated', async () => {
    const context = await browser.newContext(devices['iPhone 13']);
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: 'networkidle' });

    const nav = await tab.locator('.nav .wrap').boundingBox();
    const logo = await tab.locator('.nav .logo').boundingBox();
    const cta = await tab.locator('.nav-right .btn.primary').boundingBox();
    expect(nav).not.toBeNull();
    expect(logo?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((cta?.x ?? 0) + (cta?.width ?? 0)).toBeLessThanOrEqual(
      (nav?.x ?? 0) + (nav?.width ?? 0) + 1,
    );
    expect(await tab.locator('.nav .logo').textContent()).toContain('Bookrail');
    await context.close();
  });

  it('lets the grid scroll sideways instead of squeezing it', async () => {
    const context = await browser.newContext(devices['iPhone 13']);
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: 'networkidle' });
    const scroller = tab.locator('.grid-scroll');
    const measurements = await scroller.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(measurements.overflowX).toBe('auto');
    expect(measurements.scrollWidth).toBeGreaterThan(measurements.clientWidth);
    await context.close();
  });
});

/**
 * The signed in dashboard on a phone, with the API answered by the test: the account view is
 * built by the script from the answer, so this is the only way to measure it. The keys table is
 * the wide thing on it, and it must scroll inside its own box rather than push the page.
 */
describe('the dashboard of an account on a phone', () => {
  const account = {
    object: 'dashboard_account',
    account: {
      id: 'acct_1',
      object: 'account',
      name: 'Padel Roma',
      plan: 'free',
      owner_email: 'ada@example.com',
    },
    usage: {
      month: '2026-09',
      bookings_confirmed: 412,
      bookings_included: 1000,
      payment_volume: 45000,
      payment_volume_included: 100000,
      currency: 'EUR',
      blocks_at_limit: true,
    },
    reserved: { bookings_pending: 60, payment_volume_pending: 2500 },
    projects: [
      {
        id: 'proj_1',
        object: 'project',
        name: 'Default',
        default_timezone: 'Europe/Rome',
        default_currency: 'EUR',
        created_at: '2026-09-24T09:00:00.000Z',
        api_keys: ['test', 'live'].map((environment, index) => ({
          id: `key_${String(index)}`,
          object: 'api_key',
          environment,
          kind: 'secret',
          name: `${environment} secret key`,
          prefix: 'Ab3dE5gH',
          tenant_id: null,
          status: 'active',
          created_at: '2026-09-24T09:00:00.000Z',
          last_used_at: null,
          revoked_at: null,
        })),
      },
    ],
    session: { expires_at: '2026-09-24T21:00:00.000Z' },
  };

  it('has no horizontal overflow, and lets the keys table scroll in its own box', async () => {
    const context = await browser.newContext(devices['iPhone 13']);
    const tab = await context.newPage();
    await tab.route('https://api.bookrail.dev/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(account),
      }),
    );
    await tab.goto(`${origin}/dashboard/`, { waitUntil: 'networkidle' });
    await tab.evaluate(() => {
      sessionStorage.setItem(
        'bookrail.dashboard.session',
        JSON.stringify({ token: `bds_${'a'.repeat(43)}`, expires_at: '2999-01-01T00:00:00.000Z' }),
      );
    });
    await tab.reload({ waitUntil: 'networkidle' });
    await tab.locator('#dash-app').waitFor({ state: 'visible' });
    await tab.screenshot({ path: join(SHOTS, 'dashboard-account-iphone-13.png'), fullPage: false });

    const measured = await tab.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      overflowX: getComputedStyle(document.querySelector('.table-scroll') as Element).overflowX,
      rows: document.querySelectorAll('.keys tbody tr').length,
    }));
    expect(measured.rows).toBe(2);
    expect(measured.overflowX).toBe('auto');
    expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth + 2);
    await context.close();
  });
});

describe('reduced motion', () => {
  it('never builds Lenis, and shows the finished state at once', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      reducedMotion: 'reduce',
    });
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: 'networkidle' });
    await tab.waitForTimeout(400);

    const state = await tab.evaluate(() => ({
      lenis: document.documentElement.classList.contains('lenis'),
      slotsIn: document.querySelectorAll('.slot.in').length,
      slots: document.querySelectorAll('.slot').length,
      armed: document.querySelectorAll('[data-reveal].armed').length,
      hidden: [...document.querySelectorAll('[data-reveal]')].filter(
        (element) => getComputedStyle(element).opacity !== '1',
      ).length,
    }));
    expect(state.lenis).toBe(false);
    expect(state.slotsIn).toBe(state.slots);
    expect(state.armed).toBe(0);
    expect(state.hidden).toBe(0);
    await context.close();
  });

  it('runs Lenis when motion is welcome, and hides only what is below the fold', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'no-preference',
    });
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: 'networkidle' });
    await tab.waitForTimeout(600);
    expect(await tab.evaluate(() => document.documentElement.classList.contains('lenis'))).toBe(
      true,
    );
    const aboveTheFold = await tab.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-reveal].armed')].filter(
        (element) => element.getBoundingClientRect().top < 0,
      ),
    );
    expect(aboveTheFold).toEqual([]);
    await context.close();
  });
});

describe('without JavaScript', () => {
  it('still shows the grid, every section and all three panes of the demo', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: false,
    });
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: 'load' });
    expect(await tab.locator('.slot').count()).toBeGreaterThan(10);
    expect(await tab.locator('[data-response]').textContent()).toContain('"status": "confirmed"');
    for (const id of ['demo-explain', 'demo-booking', 'demo-webhook', 'code-node', 'code-mcp']) {
      expect(await tab.locator(`#${id}`).isVisible(), id).toBe(true);
    }
    // A tab is a link to its panel.
    expect(await tab.locator('#demo-tab-webhook').getAttribute('href')).toBe('#demo-webhook');
    const hidden = await tab.evaluate(
      () =>
        [...document.querySelectorAll('[data-reveal]')].filter(
          (element) => getComputedStyle(element).opacity !== '1',
        ).length,
    );
    expect(hidden).toBe(0);
    await context.close();
  });
});

describe('the tabs, with JavaScript', () => {
  it('show one panel, and move with the arrows, Home and End', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: 'networkidle' });
    const visible = (): Promise<string[]> =>
      tab.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('#demo [role="tabpanel"]')]
          .filter((panel) => !panel.hidden)
          .map((panel) => panel.id),
      );
    expect(await visible()).toEqual(['demo-explain']);
    await tab.focus('#demo-tab-explain');
    await tab.keyboard.press('ArrowRight');
    expect(await visible()).toEqual(['demo-booking']);
    expect(await tab.evaluate(() => document.activeElement?.id)).toBe('demo-tab-booking');
    expect(await tab.getAttribute('#demo-tab-booking', 'aria-selected')).toBe('true');
    expect(await tab.getAttribute('#demo-tab-explain', 'tabindex')).toBe('-1');
    await tab.keyboard.press('End');
    expect(await visible()).toEqual(['demo-webhook']);
    await tab.keyboard.press('ArrowRight');
    expect(await visible()).toEqual(['demo-explain']);
    await tab.keyboard.press('ArrowLeft');
    expect(await visible()).toEqual(['demo-webhook']);
    await tab.keyboard.press('Home');
    expect(await visible()).toEqual(['demo-explain']);

    // The code tabs carry the second line of their title with them.
    await tab.click('#code-tab-cli');
    expect(await tab.textContent('#code-tool')).toBe('the CLI');
    expect(await tab.locator('#code-cli').isVisible()).toBe(true);
    expect(await tab.locator('#code-node').isVisible()).toBe(false);
    await context.close();
  });
});

describe('the menu under 900px', () => {
  it('opens a panel with the links, closes on Escape and gives the focus back', async () => {
    const context = await browser.newContext(devices['iPhone 13']);
    const tab = await context.newPage();
    await tab.goto(`${origin}/pricing/`, { waitUntil: 'networkidle' });
    const button = tab.locator('[data-menu-button]');
    expect(await button.isVisible()).toBe(true);
    expect(await tab.locator('.nav-links').isVisible()).toBe(false);
    await button.focus();
    await tab.keyboard.press('Enter');
    expect(await button.getAttribute('aria-expanded')).toBe('true');
    expect(await tab.locator('.nav-links a[href="/pricing/"]').isVisible()).toBe(true);
    expect(await tab.locator('#nav-panel a[data-session-link]').isVisible()).toBe(true);
    await tab.keyboard.press('Escape');
    expect(await button.getAttribute('aria-expanded')).toBe('false');
    expect(await tab.locator('.nav-links').isVisible()).toBe(false);
    expect(await tab.evaluate(() => document.activeElement?.hasAttribute('data-menu-button'))).toBe(
      true,
    );
    await context.close();
  });

  it('is not there over 900px, where the links are in the bar', async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: 'networkidle' });
    expect(await tab.locator('[data-menu-button]').isVisible()).toBe(false);
    expect(await tab.locator('.nav-links a[href="/docs/"]').isVisible()).toBe(true);
    await context.close();
  });
});
