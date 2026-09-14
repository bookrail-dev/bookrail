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

const BASE = {
  DATABASE_URL: 'postgres://localhost:5432/bookrail_test_api',
  APP_DB_ROLE: 'bookrail_app',
} satisfies NodeJS.ProcessEnv;

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
    expect(() => loadConfig({ ...BASE, BOOKRAIL_MAILER: 'log', NODE_ENV: 'production' })).toThrow(
      /BOOKRAIL_MAILER=log/,
    );
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
    const config = loadConfig({
      ...BASE,
      NODE_ENV: 'production',
      BOOKRAIL_MAILER: 'smtp',
      SMTP_URL: 'smtps://user:password@smtp.example.com:465',
      MAIL_FROM: 'Bookrail <noreply@bookrail.dev>',
      BOOKRAIL_SITE_URL: 'https://staging.example.com/',
      BOOKRAIL_SITE_ORIGIN: 'http://localhost:4321',
    });
    expect(config.mailer).toBe('smtp');
    expect(config.smtpUrl).toBe('smtps://user:password@smtp.example.com:465');
    expect(config.mailFrom).toBe('Bookrail <noreply@bookrail.dev>');
    // The trailing slash goes, so that the link is never built with two of them.
    expect(config.siteUrl).toBe('https://staging.example.com');
    expect(config.siteOrigin).toBe('http://localhost:4321');
  });
});

describe('the rate limit configuration', () => {
  it('is on by default, with the ceilings the documents print', () => {
    const config = loadConfig({ ...BASE });
    expect(config.rateLimit).toEqual({
      enabled: true,
      test: { rate: 20, burst: 40 },
      live: { rate: 100, burst: 500 },
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
    expect(config.rateLimit.live.burst).toBe(500);
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
