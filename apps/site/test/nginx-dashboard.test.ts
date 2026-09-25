/**
 * The reverse proxy configuration of the dashboard, read as text.
 *
 * `nginx -t` cannot run on the development machine, so these are the facts a reader could check
 * by eye, checked by a test instead: the sign in endpoints have a zone of their own, the preflight
 * is not counted, the `429` is the JSON envelope with the CORS header of the site, the dashboard
 * pages get their security headers, and `/early-access` goes to `/signup`. That nginx accepts the
 * file is established on the server at release (`nginx -t`), not here.
 *
 * The deployment directory is not part of the public repository, so in a clone of that
 * repository there is nothing to read and the checks are skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers.js';

function read(name: string): string | null {
  const path = join(repoRoot, 'infra', 'deploy', 'remote', name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const API_CONF = read('nginx-api.conf');
const SITE_CONF = read('nginx-site.conf');

/** Byte for byte the body of `location @dashboard_rate_limited`. */
const DASHBOARD_429 = JSON.stringify({
  error: {
    type: 'rate_limit',
    code: 'rate_limited',
    message: 'Too many requests from this address. The dashboard sign in accepts five a minute.',
    fix: 'Wait a minute and try again. A link you already received works for fifteen minutes.',
    doc_url: 'https://bookrail.dev/docs/errors#rate_limited',
  },
});

/** The body of one named or exact `location` block, up to its closing brace. */
function block(conf: string, opening: string): string {
  const start = conf.indexOf(opening);
  if (start === -1) throw new Error(`no block "${opening}"`);
  const end = conf.indexOf('\n    }', start);
  return conf.slice(start, end);
}

describe.skipIf(API_CONF === null)('the API proxy in front of the dashboard', () => {
  const conf = API_CONF ?? '';

  it('passes the Stripe Billing events through with one method, a megabyte, and no rate limit', () => {
    const billing = block(conf, 'location = /v1/billing/webhook {');
    expect(billing).toContain('limit_except POST { deny all; }');
    expect(billing).toContain('client_max_body_size 1m;');
    expect(billing).not.toContain('limit_req');
    expect(billing).toContain('proxy_pass http://127.0.0.1:3000;');
  });

  it('limits the two sign in endpoints by address, in a zone of their own, without the preflight', () => {
    expect(conf).toContain('limit_req_zone $signup_limit_key zone=dashboard_login:1m rate=5r/m;');
    for (const path of ['/v1/dashboard/login', '/v1/dashboard/login/confirm']) {
      const location = block(conf, `location = ${path} {`);
      expect(location, path).toContain('limit_req zone=dashboard_login burst=5 nodelay;');
      expect(location, path).toContain('error_page 429 = @dashboard_rate_limited;');
      expect(location, path).toContain('proxy_pass http://127.0.0.1:3000;');
    }
  });

  it('answers the 429 as the JSON envelope, with the CORS header of the site', () => {
    const page = block(conf, 'location @dashboard_rate_limited {');
    expect(page).toContain(`return 429 '${DASHBOARD_429}';`);
    expect(page).toContain('default_type application/json;');
    expect(page).toContain('add_header Access-Control-Allow-Origin @SITE_ORIGIN@ always;');
    expect(page).toContain('add_header Vary Origin always;');
    expect(page).toContain('add_header Retry-After 12 always;');
    expect(page).toContain('add_header Strict-Transport-Security');
  });

  it('leaves the rest of /v1/dashboard to the API, which limits it per session', () => {
    expect(conf).not.toMatch(/location[^{]*\/v1\/dashboard\/account/);
    expect(conf).not.toMatch(/location ~[^{]*\/v1\/dashboard/);
  });
});

describe.skipIf(SITE_CONF === null)('the site server in front of the dashboard pages', () => {
  const conf = SITE_CONF ?? '';

  it.each(['/dashboard', '/signup'])(
    'gives %s a strict policy, no referrer and no cache',
    (prefix) => {
      // No trailing slash: `/dashboard` and `/signup` themselves must not fall to `location /`.
      const location = block(conf, `location ${prefix} {`);
      const csp = /add_header Content-Security-Policy "([^"]+)" always;/.exec(location)?.[1] ?? '';
      const directives = new Map(
        csp.split(';').map((part) => {
          const [name, ...values] = part.trim().split(/\s+/);
          return [name ?? '', values.join(' ')] as const;
        }),
      );
      expect(directives.get('default-src')).toBe("'self'");
      expect(directives.get('script-src')).toBe("'self'");
      expect(directives.get('connect-src')).toBe('https://api.bookrail.dev');
      expect(directives.get('frame-ancestors')).toBe("'none'");
      // Never an inline script and never code from a string.
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).not.toContain('unsafe-eval');
      expect(location).toContain('add_header Referrer-Policy "no-referrer" always;');
      expect(location).toContain('add_header Cache-Control "no-store" always;');
      // The two headers of the server block, repeated: a location's add_header replaces them.
      expect(location).toContain('add_header Strict-Transport-Security');
      expect(location).toContain('add_header X-Content-Type-Options "nosniff" always;');
    },
  );

  it('sends /early-access to /signup, permanently', () => {
    expect(conf).toContain('location ~ ^/early-access(/|\\.html)?$ { return 301 /signup; }');
  });
});
