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
    // Long enough for the grid to finish filling and the request pane to finish typing.
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

describe('the chrome on a phone', () => {
  it('keeps the logo and the primary action visible and untruncated', async () => {
    const context = await browser.newContext(devices['iPhone 13']);
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: 'networkidle' });

    const nav = await tab.locator('.nav .wrap').boundingBox();
    const logo = await tab.locator('.logo').boundingBox();
    const cta = await tab.locator('.nav-right .btn.primary').boundingBox();
    expect(nav).not.toBeNull();
    expect(logo?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((cta?.x ?? 0) + (cta?.width ?? 0)).toBeLessThanOrEqual(
      (nav?.x ?? 0) + (nav?.width ?? 0) + 1,
    );
    expect(await tab.locator('.logo').textContent()).toContain('Bookrail');
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
      revealed: document.querySelectorAll('[data-reveal].in').length,
      reveals: document.querySelectorAll('[data-reveal]').length,
      responseIn: document.querySelectorAll('.resp-line.in').length,
      response: document.querySelectorAll('.resp-line').length,
      request: (document.querySelector('[data-request]')?.textContent ?? '').length,
    }));
    expect(state.lenis).toBe(false);
    expect(state.slotsIn).toBe(state.slots);
    expect(state.revealed).toBe(state.reveals);
    expect(state.responseIn).toBe(state.response);
    expect(state.request).toBeGreaterThan(200);
    await context.close();
  });

  it('runs Lenis when motion is welcome', async () => {
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
    await context.close();
  });
});

describe('without JavaScript', () => {
  it('still shows the grid, the request and the response', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: false,
    });
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: 'load' });
    expect(await tab.locator('[data-request]').textContent()).toContain('bookrail.bookings.create');
    expect(await tab.locator('[data-response]').textContent()).toContain('"status": "confirmed"');
    expect(await tab.locator('.slot').count()).toBeGreaterThan(10);
    await context.close();
  });
});
