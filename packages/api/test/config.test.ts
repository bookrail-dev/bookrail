/**
 * The configuration decisions that have to fail at boot rather than at run time.
 *
 * There is one of them today and it is about the mailer: `log` writes the confirmation link to
 * the log and reports success, which in production is a sign up that looks like it works and
 * sends nothing. Nobody notices that until somebody checks a mailbox, so the process refuses to
 * start instead.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

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
