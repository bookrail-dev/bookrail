/**
 * The configuration decisions that have to fail at boot rather than at run time.
 *
 * The first is about the mailer: `log` writes the confirmation link to the log and reports
 * success, which in production is a sign up that looks like it works and sends nothing. Nobody
 * notices that until somebody checks a mailbox, so the process refuses to start instead.
 *
 * The second is about the rate limit ceilings. A value that is set and malformed is an error and
 * not a silent fallback, because a deployment that believes it raised a ceiling and did not is a
 * deployment that finds out from a customer.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITS, loadConfig, MAX_RATE_LIMIT_PRODUCT } from '../src/config.js';
import { DEFAULT_USAGE_DIGEST_CRON } from '../src/jobs/worker.js';

const BASE = {
  DATABASE_URL: 'postgres://localhost:5432/bookrail_test_api',
  APP_DB_ROLE: 'bookrail_app',
} satisfies NodeJS.ProcessEnv;

/** Versions of the terms that are not drafts, for the cases that load a production configuration. */
const APPROVED = { legalVersions: { terms: '2026-10-01', dpa: '2026-10-01' } };

describe('the mailer configuration', () => {
  it('leaves sign up switched off when the variable is not set', () => {
    const config = loadConfig({ ...BASE });
    expect(config.mailer).toBeUndefined();
    expect(config.siteUrl).toBe('https://bookrail.dev');
    expect(config.siteOrigin).toBe('https://bookrail.dev');
  });

  it('accepts the log mailer outside production', () => {
    const config = loadConfig({ ...BASE, BOOKRAIL_MAILER: 'log', NODE_ENV: 'development' });
    expect(config.mailer).toBe('log');
  });

  it('refuses to start with the log mailer in production', () => {
    expect(() =>
      loadConfig({ ...BASE, BOOKRAIL_MAILER: 'log', NODE_ENV: 'production' }, APPROVED),
    ).toThrow(/BOOKRAIL_MAILER=log/);
  });

  it('refuses a mailer it does not know', () => {
    expect(() => loadConfig({ ...BASE, BOOKRAIL_MAILER: 'sendgrid' })).toThrow(
      /BOOKRAIL_MAILER must be one of/,
    );
  });

  it('refuses the SMTP mailer with half its configuration', () => {
    expect(() => loadConfig({ ...BASE, BOOKRAIL_MAILER: 'smtp' })).toThrow(/SMTP_URL/);
    expect(() =>
      loadConfig({ ...BASE, BOOKRAIL_MAILER: 'smtp', SMTP_URL: 'smtps://a:b@example.com:465' }),
    ).toThrow(/MAIL_FROM/);
  });

  it('reads the SMTP mailer, the site and the browser origin', () => {
    const config = loadConfig(
      {
        ...BASE,
        NODE_ENV: 'production',
        BOOKRAIL_MAILER: 'smtp',
        SMTP_URL: 'smtps://user:password@smtp.example.com:465',
        MAIL_FROM: 'Bookrail <noreply@bookrail.dev>',
        BOOKRAIL_SITE_URL: 'https://staging.example.com/',
        BOOKRAIL_SITE_ORIGIN: 'http://localhost:4321',
      },
      APPROVED,
    );
    expect(config.mailer).toBe('smtp');
    expect(config.smtpUrl).toBe('smtps://user:password@smtp.example.com:465');
    expect(config.mailFrom).toBe('Bookrail <noreply@bookrail.dev>');
    // The trailing slash goes, so that the link is never built with two of them.
    expect(config.siteUrl).toBe('https://staging.example.com');
    expect(config.siteOrigin).toBe('http://localhost:4321');
  });
});

describe('the usage digest configuration', () => {
  /**
   * No default address, and that is the point: the digest says who signed up and which keys
   * were used, so a deployment that has not named a mailbox must send it nowhere rather than
   * somewhere plausible.
   */
  it('is off until an address is named', () => {
    const config = loadConfig({ ...BASE });
    expect(config.usageDigestTo).toBeUndefined();
    expect(config.usageDigestCron).toBe(DEFAULT_USAGE_DIGEST_CRON);
  });

  it('reads the address and the cron the deployment sets', () => {
    const config = loadConfig({
      ...BASE,
      USAGE_DIGEST_TO: 'hello@bookrail.dev',
      USAGE_DIGEST_CRON: '30 6 * * *',
    });
    expect(config.usageDigestTo).toBe('hello@bookrail.dev');
    expect(config.usageDigestCron).toBe('30 6 * * *');
  });

  /**
   * The worker reads the same three mail variables as the API, through this same function, so
   * the refusal that keeps `log` out of production is the same refusal in both processes.
   */
  it('gives the worker the same mailer rules as the API', () => {
    expect(() =>
      loadConfig(
        {
          ...BASE,
          NODE_ENV: 'production',
          BOOKRAIL_MAILER: 'log',
          USAGE_DIGEST_TO: 'hello@bookrail.dev',
        },
        APPROVED,
      ),
    ).toThrow(/BOOKRAIL_MAILER=log/);
  });
});

describe('the rate limit configuration', () => {
  it('is on by default, with the ceilings the documents print', () => {
    const config = loadConfig({ ...BASE });
    expect(config.rateLimit).toEqual({
      enabled: true,
      test: { rate: 20, burst: 40 },
      // No override: a live key has the ceiling of its account's plan.
      live: null,
    });
    expect(DEFAULT_RATE_LIMITS.test).toEqual({ rate: 20, burst: 40 });
    expect(DEFAULT_RATE_LIMITS.live).toEqual({ rate: 100, burst: 500 });
  });

  it('reads all four ceilings from the environment', () => {
    const config = loadConfig({
      ...BASE,
      RATE_LIMIT_TEST_RPS: '2',
      RATE_LIMIT_TEST_BURST: '3',
      RATE_LIMIT_LIVE_RPS: '400',
      RATE_LIMIT_LIVE_BURST: '900',
    });
    expect(config.rateLimit.test).toEqual({ rate: 2, burst: 3 });
    expect(config.rateLimit.live).toEqual({ rate: 400, burst: 900 });
  });

  it('switches the limit off when asked, in any of the spellings', () => {
    for (const value of ['off', 'false', '0', 'no', 'OFF']) {
      expect(loadConfig({ ...BASE, RATE_LIMIT: value }).rateLimit.enabled, value).toBe(false);
    }
    expect(loadConfig({ ...BASE, RATE_LIMIT: 'on' }).rateLimit.enabled).toBe(true);
  });

  /**
   * A value that is set and wrong stops the process, where a sweep interval would quietly revert.
   *
   * The difference is what the number controls: a deployment that believes it raised a ceiling and
   * silently did not is a deployment that will find out from a customer.
   */
  it('refuses a ceiling that is not a positive integer', () => {
    expect(() => loadConfig({ ...BASE, RATE_LIMIT_TEST_RPS: '0' })).toThrow(
      /RATE_LIMIT_TEST_RPS must be a positive integer/,
    );
    expect(() => loadConfig({ ...BASE, RATE_LIMIT_TEST_BURST: '0' })).toThrow(
      /RATE_LIMIT_TEST_BURST/,
    );
    expect(() => loadConfig({ ...BASE, RATE_LIMIT_LIVE_RPS: '-5' })).toThrow(/RATE_LIMIT_LIVE_RPS/);
    expect(() => loadConfig({ ...BASE, RATE_LIMIT_LIVE_BURST: '1.5' })).toThrow(
      /RATE_LIMIT_LIVE_BURST/,
    );
    expect(() => loadConfig({ ...BASE, RATE_LIMIT_TEST_RPS: 'twenty' })).toThrow(
      /RATE_LIMIT_TEST_RPS/,
    );
  });

  it('treats an empty value as unset, the way an unexported variable arrives', () => {
    const config = loadConfig({ ...BASE, RATE_LIMIT_TEST_RPS: '', RATE_LIMIT_LIVE_BURST: '  ' });
    expect(config.rateLimit.test.rate).toBe(20);
    expect(config.rateLimit.live).toBeNull();
  });

  it('overrides every live key when one of the two live variables is set', () => {
    // The half that is not written comes from the default, not from a plan: an override is one
    // ceiling for every live key, and a plan's burst next to an operator's rate would be neither.
    expect(loadConfig({ ...BASE, RATE_LIMIT_LIVE_RPS: '50' }).rateLimit.live).toEqual({
      rate: 50,
      burst: 500,
    });
    expect(loadConfig({ ...BASE, RATE_LIMIT_LIVE_BURST: '60' }).rateLimit.live).toEqual({
      rate: 100,
      burst: 60,
    });
  });

  /**
   * The ceiling on the ceiling: a product the arithmetic of the limiter can still be exact about.
   *
   * The admission test forgives the rounding of a timestamp, and that forgiveness grows with the
   * burst while the emission interval shrinks with the rate. The limiter caps it at half an
   * interval, so it can never admit more than the burst; above the product, though, it starts
   * admitting a few **fewer**, and a deployment asking for numbers in that regime should be told
   * at boot rather than discover a ceiling that is off by a tenth of a percent.
   */
  it('refuses a rate and a burst whose product leaves the exact regime', () => {
    expect(DEFAULT_RATE_LIMITS.test.rate * (DEFAULT_RATE_LIMITS.test.burst + 1)).toBeLessThan(
      MAX_RATE_LIMIT_PRODUCT,
    );
    expect(DEFAULT_RATE_LIMITS.live.rate * (DEFAULT_RATE_LIMITS.live.burst + 1)).toBeLessThan(
      MAX_RATE_LIMIT_PRODUCT,
    );

    // The three products the second review measured, one per variable pair.
    expect(() =>
      loadConfig({ ...BASE, RATE_LIMIT_TEST_RPS: '1000', RATE_LIMIT_TEST_BURST: '5000' }),
    ).toThrow(/RATE_LIMIT_TEST_RPS times \(RATE_LIMIT_TEST_BURST \+ 1\) must be at most 1000000/);
    expect(() =>
      loadConfig({ ...BASE, RATE_LIMIT_LIVE_RPS: '5000', RATE_LIMIT_LIVE_BURST: '1000' }),
    ).toThrow(/and 5000 times \(1000 \+ 1\) is 5005000/);
    expect(() =>
      loadConfig({ ...BASE, RATE_LIMIT_LIVE_RPS: '10000', RATE_LIMIT_LIVE_BURST: '5000' }),
    ).toThrow(/Lower the rate, lower the burst/);

    // And the boundary itself is allowed, so the message cannot be off by one.
    const atTheEdge = loadConfig({
      ...BASE,
      RATE_LIMIT_TEST_RPS: '1000',
      RATE_LIMIT_TEST_BURST: '999',
    });
    expect(atTheEdge.rateLimit.test).toEqual({ rate: 1000, burst: 999 });
    expect(atTheEdge.rateLimit.test.rate * (atTheEdge.rateLimit.test.burst + 1)).toBe(
      MAX_RATE_LIMIT_PRODUCT,
    );
    expect(() =>
      loadConfig({ ...BASE, RATE_LIMIT_TEST_RPS: '1000', RATE_LIMIT_TEST_BURST: '1000' }),
    ).toThrow(/must be at most 1000000/);
  });
});

/**
 * The Stripe platform configuration, and the two mistakes it refuses to start with.
 *
 * Both are mistakes a person makes by hand, in a file whose lines are adjacent and whose names
 * are symmetrical, and the cost of each is a promise broken silently: a swapped pair publishes
 * the platform's **secret** key in the `publishable_key` of every `GET /v1/stripe`, and a key
 * of the wrong mode makes an environment look configured while no payment in it could ever
 * work.
 */
describe('the Stripe platform configuration', () => {
  const TEST_ENV = {
    STRIPE_CLIENT_ID_TEST: 'ca_TestApplication',
    STRIPE_SECRET_KEY_TEST: 'rk_test_platform',
    STRIPE_PUBLISHABLE_KEY_TEST: 'pk_test_platform',
  } satisfies NodeJS.ProcessEnv;

  it('is off when neither environment has its three variables', () => {
    expect(loadConfig(BASE).stripe).toBeNull();
  });

  it('carries a client id per environment, because a Stripe application has a mode', () => {
    const config = loadConfig({
      ...BASE,
      ...TEST_ENV,
      STRIPE_CLIENT_ID_LIVE: 'ca_LiveApplication',
      STRIPE_SECRET_KEY_LIVE: 'sk_live_platform',
      STRIPE_PUBLISHABLE_KEY_LIVE: 'pk_live_platform',
    }).stripe;
    expect(config?.environments.test?.clientId).toBe('ca_TestApplication');
    expect(config?.environments.live?.clientId).toBe('ca_LiveApplication');
    expect(config?.redirectUrl).toBe('https://api.bookrail.dev/v1/stripe/callback');
  });

  it('serves one environment while the other has nothing', () => {
    const config = loadConfig({ ...BASE, ...TEST_ENV }).stripe;
    expect(config?.environments.test).not.toBeNull();
    expect(config?.environments.live).toBeNull();
  });

  it('refuses to start on one or two variables out of three', () => {
    for (const missing of [
      'STRIPE_CLIENT_ID_TEST',
      'STRIPE_SECRET_KEY_TEST',
      'STRIPE_PUBLISHABLE_KEY_TEST',
    ] as const) {
      const partial: NodeJS.ProcessEnv = { ...BASE, ...TEST_ENV };
      delete partial[missing];
      expect(() => loadConfig(partial), missing).toThrow(/have to be set together/);
    }
  });

  it('refuses the secret and the publishable key swapped, and names neither value', () => {
    let message = '';
    try {
      loadConfig({
        ...BASE,
        ...TEST_ENV,
        STRIPE_SECRET_KEY_TEST: 'pk_test_platform',
        STRIPE_PUBLISHABLE_KEY_TEST: 'rk_test_platform',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('STRIPE_SECRET_KEY_TEST');
    expect(message).toContain('STRIPE_PUBLISHABLE_KEY_TEST');
    // The variable, never the value: an error message ends up in a journal.
    expect(message).not.toContain('pk_test_platform');
    expect(message).not.toContain('rk_test_platform');
  });

  it('refuses a key of the wrong mode in either direction', () => {
    expect(() =>
      loadConfig({ ...BASE, ...TEST_ENV, STRIPE_SECRET_KEY_TEST: 'rk_live_platform' }),
    ).toThrow(/STRIPE_SECRET_KEY_TEST must be a test mode secret or restricted key/);
    expect(() =>
      loadConfig({ ...BASE, ...TEST_ENV, STRIPE_PUBLISHABLE_KEY_TEST: 'pk_live_platform' }),
    ).toThrow(/STRIPE_PUBLISHABLE_KEY_TEST must be a test mode publishable key/);
    expect(() =>
      loadConfig({
        ...BASE,
        STRIPE_CLIENT_ID_LIVE: 'ca_LiveApplication',
        STRIPE_SECRET_KEY_LIVE: 'rk_test_platform',
        STRIPE_PUBLISHABLE_KEY_LIVE: 'pk_live_platform',
      }),
    ).toThrow(/STRIPE_SECRET_KEY_LIVE must be a live mode secret or restricted key/);
  });

  it('accepts both a full secret key and a restricted one', () => {
    for (const secretKey of ['sk_test_platform', 'rk_test_platform']) {
      const config = loadConfig({ ...BASE, ...TEST_ENV, STRIPE_SECRET_KEY_TEST: secretKey }).stripe;
      expect(config?.environments.test?.secretKey).toBe(secretKey);
    }
  });

  it('refuses a client id that is not a ca_', () => {
    expect(() =>
      loadConfig({ ...BASE, ...TEST_ENV, STRIPE_CLIENT_ID_TEST: 'acct_NotAnApplication' }),
    ).toThrow(/STRIPE_CLIENT_ID_TEST must be a Stripe Connect client id/);
  });
});

describe('the versions of the terms in production', () => {
  it('refuses to start while the terms or the DPA it records are drafts', () => {
    expect(() =>
      loadConfig(
        { ...BASE, NODE_ENV: 'production' },
        { legalVersions: { terms: '2026-09-24-draft', dpa: '2026-10-01' } },
      ),
    ).toThrow(/Terms of Service \(2026-09-24-draft\) is a draft/);
    expect(() =>
      loadConfig(
        { ...BASE, NODE_ENV: 'production' },
        { legalVersions: { terms: '2026-01-01-fixture', dpa: '2026-01-01-fixture' } },
      ),
    ).toThrow(/are drafts/);
  });

  it('starts with approved versions, and outside production with drafts', () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production' }, APPROVED)).not.toThrow();
    expect(() =>
      loadConfig(
        { ...BASE, NODE_ENV: 'development' },
        { legalVersions: { terms: '2026-09-24-draft', dpa: '2026-09-24-draft' } },
      ),
    ).not.toThrow();
  });
});
