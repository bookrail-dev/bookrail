/**
 * The consent banner is dormant, and these are the tests that keep it both correct and asleep.
 *
 * Asleep: the compiled site must contain neither the markup nor the cookie name, because
 * Bookrail's website sets no cookie and a banner that protects nothing is a dark pattern.
 * Correct: the state machine has to already behave lawfully on the day it is switched on, and
 * "we will get the consent logic right later" is how everybody ends up with a banner that
 * stores a cookie before the visitor has clicked anything.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  CONSENT_VERSION,
  createController,
  readChoice,
  serializeChoice,
  type ConsentEnvironment,
} from '../src/scripts/consent.js';
import { distRoot, siteRoot, walk } from './helpers.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');

/** A browser that records what was written to it and never lies about what it holds. */
function fakeEnvironment({ cookies = '', reducedMotion = false } = {}): ConsentEnvironment & {
  written: string[];
  jar: () => string;
} {
  const written: string[] = [];
  let jar = cookies;
  return {
    written,
    jar: () => jar,
    readCookies: () => jar,
    writeCookie: (value: string) => {
      written.push(value);
      jar = value.split(';')[0] ?? '';
    },
    prefersReducedMotion: () => reducedMotion,
    now: () => NOW,
  };
}

describe('before a choice is made', () => {
  it('writes no cookie at all', () => {
    const environment = fakeEnvironment();
    const controller = createController(environment);
    expect(environment.written).toEqual([]);
    expect(controller.choice).toBeNull();
    expect(controller.visible).toBe(true);
  });

  it('treats an unreadable or outdated cookie as no choice, never as consent', () => {
    expect(readChoice('')).toBeNull();
    expect(readChoice(`${CONSENT_COOKIE}=not-json`)).toBeNull();
    expect(readChoice(`${CONSENT_COOKIE}=${encodeURIComponent('{"version":0}')}`)).toBeNull();
    expect(readChoice('other=1; another=2')).toBeNull();
  });

  it('opens the panel without deciding anything when Manage is pressed', () => {
    const environment = fakeEnvironment();
    const controller = createController(environment);
    controller.manage();
    expect(controller.managing).toBe(true);
    expect(controller.visible).toBe(true);
    expect(environment.written).toEqual([]);
    expect(controller.choice).toBeNull();
  });
});

describe('after a choice is made', () => {
  it('accept all switches every category on, and stores it for six months', () => {
    const environment = fakeEnvironment();
    const controller = createController(environment);
    const choice = controller.acceptAll();

    expect(choice).toMatchObject({ necessary: true, analytics: true, external_media: true });
    expect(environment.written).toHaveLength(1);
    const cookie = environment.written[0] ?? '';
    expect(cookie).toContain(`${CONSENT_COOKIE}=`);
    expect(cookie).toContain(`Max-Age=${String(CONSENT_MAX_AGE_SECONDS)}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    // Six months, give or take a day.
    expect(CONSENT_MAX_AGE_SECONDS / 86_400).toBeGreaterThan(175);
    expect(CONSENT_MAX_AGE_SECONDS / 86_400).toBeLessThan(190);
    expect(controller.visible).toBe(false);
  });

  it('reject all leaves every non necessary category off', () => {
    const environment = fakeEnvironment();
    const choice = createController(environment).rejectAll();
    expect(choice).toMatchObject({ necessary: true, analytics: false, external_media: false });
    expect(readChoice(environment.jar())).toEqual(choice);
  });

  it('takes exactly the categories the panel selected, and never necessary off', () => {
    const environment = fakeEnvironment();
    const choice = createController(environment).save({ analytics: true, necessary: false });
    expect(choice).toMatchObject({ necessary: true, analytics: true, external_media: false });
  });

  it('round trips through the cookie', () => {
    const environment = fakeEnvironment();
    const choice = createController(environment).acceptAll();
    const cookie = serializeChoice(choice).split(';')[0] ?? '';
    expect(readChoice(cookie)).toEqual(choice);
    expect(choice.version).toBe(CONSENT_VERSION);
  });

  it('reopens from the footer showing the stored choice, without clearing it', () => {
    const first = fakeEnvironment();
    createController(first).save({ analytics: true });

    const second = fakeEnvironment({ cookies: first.jar() });
    const controller = createController(second);
    expect(controller.visible).toBe(false);
    expect(controller.choice).toMatchObject({ analytics: true, external_media: false });

    controller.reopen();
    expect(controller.visible).toBe(true);
    expect(controller.managing).toBe(true);
    // Reopening is not a decision: nothing new is written until a button is pressed.
    expect(second.written).toEqual([]);
    expect(controller.choice).toMatchObject({ analytics: true });
  });
});

describe('prefers-reduced-motion', () => {
  it('reports no animation, so the caller shows the final state at once', () => {
    expect(createController(fakeEnvironment({ reducedMotion: true })).animate).toBe(false);
    expect(createController(fakeEnvironment({ reducedMotion: false })).animate).toBe(true);
  });
});

const source = await readFile(join(siteRoot, 'src', 'components', 'ConsentBanner.astro'), 'utf8');

describe('the component', () => {
  it('is a dialog with a label, and is hidden until the script shows it', () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-labelledby="consent-title"');
    expect(source).toContain('aria-describedby="consent-text"');
    expect(source).toMatch(/id="consent-banner"[\s\S]{0,400}hidden/);
  });

  it('gives the three actions one class, one height and no colour of their own', () => {
    // Four buttons, one class between them: accept, reject, manage, and save inside the panel.
    expect([...source.matchAll(/class="consent-action"/g)]).toHaveLength(4);
    for (const action of ['accept', 'reject', 'manage', 'save']) {
      expect(source, action).toContain(`data-consent="${action}"`);
    }
    // No second button style exists, so none of them can be made to look heavier than another.
    expect([...source.matchAll(/\.consent-action\b/g)].length).toBeGreaterThan(0);
    expect(source).not.toMatch(/\.consent-action\.[a-z]/);
    // Cobalt appears once in the stylesheet, on the focus ring, and once on a checked category.
    const accents = [...source.matchAll(/var\(--accent\)/g)].length;
    expect(accents).toBeLessThanOrEqual(2);
    expect(source).not.toMatch(/\.consent-action\.primary|background:\s*var\(--ink\)/);
  });

  it('has no close button and listens to no scroll, because neither is consent', () => {
    expect(source).not.toMatch(/data-consent="close"|aria-label="Close"/);
    expect(source).not.toContain("addEventListener('scroll'");
  });

  it('links the privacy notice and the cookie list, and never covers the page', () => {
    expect(source).toContain('href="/privacy"');
    expect(source).toContain('href="/cookies"');
    expect(source).toContain('max-height: 40vh');
    expect(source).toContain('bottom: 0');
    expect(source).not.toContain('position: fixed;\n    inset: 0');
  });

  it('carries no em dash and no emoji', () => {
    // Assembled from its code point, so that this file is not itself an occurrence of it.
    expect(source).not.toContain(String.fromCharCode(0x2014));
    expect(source).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('renders nothing without the build variable', () => {
    expect(source).toContain("import.meta.env.PUBLIC_CONSENT_BANNER === '1'");
  });
});

describe('the compiled site', () => {
  it('contains no banner, no cookie name and sets no cookie anywhere', async () => {
    const files = (await walk()).filter(
      (file) =>
        !file.startsWith('pagefind/') &&
        (file.endsWith('.html') || file.endsWith('.js') || file.endsWith('.css')),
    );
    expect(files.length).toBeGreaterThan(50);
    const guilty: string[] = [];
    for (const file of files) {
      const text = await readFile(join(distRoot, file), 'utf8');
      if (/consent-banner|ConsentBanner|bookrail_consent|document\.cookie/.test(text)) {
        guilty.push(file);
      }
    }
    expect(guilty).toEqual([]);
  });
});
