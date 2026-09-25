/**
 * The two sign up pages, driven in a real browser, answering a real `429`.
 *
 * The reason this file exists: before the reverse proxy learned to answer a JSON body with a CORS
 * header, its `429` was 162 bytes of HTML that the browser refused to let the page read, so the
 * `catch` of the `fetch` fired and the form said "The API could not be reached". A visitor who had
 * simply asked twice too quickly was told the service was down.
 *
 * So the pages are served from `dist`, the call to the API is intercepted, and the answer given
 * back is the exact body the proxy now returns. What the page must show is the sentence the server
 * wrote, not the network failure sentence.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { browserChannel, repoRoot, serveDist } from './helpers.js';

/** Byte for byte the body of `location @rate_limited` in `nginx-api.conf`. */
const NGINX_429 = JSON.stringify({
  error: {
    type: 'rate_limit',
    code: 'rate_limited',
    message: 'Too many requests from this address. The sign up endpoints accept five a minute.',
    fix: 'Wait a minute and try again.',
    doc_url: 'https://bookrail.dev/docs/errors#rate_limited',
  },
});

/** Byte for byte the body of `location @claim_rate_limited`, the wide zone of the same file. */
const NGINX_CLAIM_429 = JSON.stringify({
  error: {
    type: 'rate_limit',
    code: 'rate_limited',
    message:
      'Too many requests from this address. The sign up claim endpoint accepts sixty a minute.',
    fix: 'Wait two seconds and ask again. The sign up link is still valid.',
    doc_url: 'https://bookrail.dev/docs/errors#rate_limited',
  },
});

/**
 * The template the two bodies above are copied from, read rather than remembered. The deployment
 * directory is not part of the public repository (the release scripts describe one machine), so
 * a clone of that repository has the two bodies and not the file: there, the checks on the file
 * are skipped and the browser tests still run.
 */
const NGINX_CONF_PATH = join(repoRoot, 'infra', 'deploy', 'remote', 'nginx-api.conf');
const NGINX_CONF = existsSync(NGINX_CONF_PATH) ? readFileSync(NGINX_CONF_PATH, 'utf8') : null;

/** What the API itself answers when a key has run out of budget. */
const API_429 = JSON.stringify({
  error: {
    type: 'rate_limit',
    code: 'rate_limited',
    message: 'This key may make 20 requests per second, with bursts of 40.',
    fix: 'Wait for Retry-After, or spread the calls. Live keys have higher limits.',
    doc_url: 'https://bookrail.dev/docs/errors#rate_limited',
    request_id: 'req_01',
  },
});

const UNREACHABLE = 'The API could not be reached';

let browser: Browser;
let origin: string;
let stopServing: () => Promise<void>;

beforeAll(async () => {
  const server = await serveDist();
  origin = server.origin;
  stopServing = server.close;
  browser = await chromium.launch({ channel: browserChannel });
}, 120_000);

afterAll(async () => {
  await browser.close();
  await stopServing();
});

/**
 * A page with every call to the API answered by the given status and body.
 *
 * The pages are built against `https://api.bookrail.dev`, so that is the pattern intercepted. The
 * interception answers with the `content-type` and the CORS header the proxy sends. It cannot
 * reproduce a CORS **refusal**, because a browser treats a fulfilled route as same origin; the
 * missing header is exactly what the proxy configuration now sets, and the check for that is a real
 * `OPTIONS` and a real burst against the running proxy at deploy time.
 */
async function pageWith(path: string, status: number, body: string): Promise<Page> {
  const page = await browser.newPage();
  await page.route('https://api.bookrail.dev/**', (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': origin, 'retry-after': '12' },
      body,
    }),
  );
  await page.goto(`${origin}${path}`);
  return page;
}

describe('/signup when the proxy refuses the request', () => {
  it('shows the message and the fix the proxy sent, and not a network failure', async () => {
    const page = await pageWith('/signup', 429, NGINX_429);
    try {
      await page.fill('#signup-email', 'someone@example.com');
      await page.check('#signup-accept-terms');
      await page.check('#signup-approve-clauses');
      await page.click('#signup-submit');
      await page.waitForFunction(
        () => (document.getElementById('signup-status')?.textContent ?? '') !== 'Sending...',
      );
      const status = (await page.textContent('#signup-status')) ?? '';
      expect(status).toContain('Too many requests from this address');
      expect(status).toContain('Wait a minute and try again.');
      expect(status).not.toContain(UNREACHABLE);
      expect(await page.getAttribute('#signup-status', 'data-state')).toBe('error');
      // The button is usable again: a refusal is something to try later, not a dead end.
      expect(await page.getAttribute('#signup-submit', 'disabled')).toBeNull();
    } finally {
      await page.close();
    }
  });

  it('keeps the network sentence for a call that really produces no response', async () => {
    // The other half of the same fact. When the `fetch` itself fails there is no body to read and
    // the network sentence is the honest one; the point of the block above is that a refusal the
    // server took the trouble to explain must no longer land here.
    const page = await browser.newPage();
    try {
      await page.route('https://api.bookrail.dev/**', (route) => route.abort('failed'));
      await page.goto(`${origin}/signup`);
      await page.fill('#signup-email', 'someone@example.com');
      await page.check('#signup-accept-terms');
      await page.check('#signup-approve-clauses');
      await page.click('#signup-submit');
      await page.waitForFunction(
        () => (document.getElementById('signup-status')?.textContent ?? '') !== 'Sending...',
      );
      expect(await page.textContent('#signup-status')).toContain(UNREACHABLE);
    } finally {
      await page.close();
    }
  });
});

describe('/signup/confirm when the proxy refuses the request', () => {
  it('shows the message and the fix the proxy sent, and not a network failure', async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://api.bookrail.dev/**', (route) =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': origin, 'retry-after': '12' },
          body: NGINX_429,
        }),
      );
      // The token lives in the fragment, which is where the confirmation link puts it.
      await page.goto(`${origin}/signup/confirm#token=whatever`);
      await page.waitForFunction(
        () =>
          (document.getElementById('confirm-status')?.textContent ?? '') !== 'Checking the link...',
      );
      const status = (await page.textContent('#confirm-status')) ?? '';
      expect(status).toContain('Too many requests from this address');
      expect(status).toContain('Wait a minute and try again.');
      expect(status).not.toContain(UNREACHABLE);
      // And no key panel: there is no key to show.
      expect(await page.getAttribute('#confirm-key', 'hidden')).not.toBeNull();
    } finally {
      await page.close();
    }
  });
});

describe('a 429 from the API itself', () => {
  it('reads the same way on both pages, because it is the same envelope', async () => {
    const form = await pageWith('/signup', 429, API_429);
    try {
      await form.fill('#signup-email', 'someone@example.com');
      await form.check('#signup-accept-terms');
      await form.check('#signup-approve-clauses');
      await form.click('#signup-submit');
      await form.waitForFunction(
        () => (document.getElementById('signup-status')?.textContent ?? '') !== 'Sending...',
      );
      const status = (await form.textContent('#signup-status')) ?? '';
      expect(status).toContain('This key may make 20 requests per second');
      expect(status).toContain('Wait for Retry-After');
      expect(status).not.toContain(UNREACHABLE);
    } finally {
      await form.close();
    }
  });
});

/**
 * The half of the sign up `429` that no browser test can reach, checked on the text of the file.
 *
 * A preflight refused by `limit_req` is a CORS failure before the page exists, so the page cannot
 * be the thing that proves it does not happen. What can be proved here is the configuration that
 * stops it: `OPTIONS` maps to an empty key, an empty key is the documented way of telling
 * `limit_req_zone` not to count a request, and both sign up zones use that key rather than the
 * address directly. The real proof is `nginx -t` and a burst of `OPTIONS` against the running
 * deployment, which is part of the release checklist.
 */
describe.skipIf(NGINX_CONF === null)(
  'the reverse proxy configuration these bodies come from',
  () => {
    it('does not count a preflight against either sign up zone', () => {
      expect(NGINX_CONF).toContain('map $request_method $signup_limit_key {');
      expect(NGINX_CONF).toMatch(/map \$request_method \$signup_limit_key \{[^}]*OPTIONS\s+"";/);
      expect(NGINX_CONF).toMatch(
        /map \$request_method \$signup_limit_key \{[^}]*default\s+\$binary_remote_addr;/,
      );
      expect(NGINX_CONF).toContain('limit_req_zone $signup_limit_key zone=signups:1m');
      expect(NGINX_CONF).toContain('limit_req_zone $signup_limit_key zone=signup_claim:1m');
      // And no zone left counting addresses directly, which is what the two lines above replaced.
      expect(NGINX_CONF).not.toContain('limit_req_zone $binary_remote_addr');
    });

    it('answers each zone with a body that is true for that zone', () => {
      expect(NGINX_CONF).toContain(`return 429 '${NGINX_429}';`);
      expect(NGINX_CONF).toContain(`return 429 '${NGINX_CLAIM_429}';`);
      // Twelve seconds is when five a minute gives a token back, two seconds is when sixty does.
      expect(NGINX_CONF).toContain('add_header Retry-After 12 always;');
      expect(NGINX_CONF).toContain('add_header Retry-After 2 always;');
      // The claim endpoint is the one that points at the second page.
      expect(NGINX_CONF).toMatch(
        /location ~ \^\/v1\/signups\/\[\^\/\]\+\/claim\$ \{[^}]*error_page 429 = @claim_rate_limited;/,
      );
    });
  },
);
