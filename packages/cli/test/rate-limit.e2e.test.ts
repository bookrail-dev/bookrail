/**
 * What the terminal shows when the key has run out of budget, end to end.
 *
 * A real HTTP server in front of `createApp`, with the per key limiter mounted and a ceiling of
 * one request, so the second call of the file is refused by the real thing. Nothing is mocked.
 *
 * The CLI needed no change for this: a `429` is a `rate_limit` error like any other, the exit code
 * of that family is 3 ("the service refused this for a moment"), and the `fix` printed is the
 * server's, because what to do about a ceiling is something only the server knows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Project } from './harness.js';

describe('bookrail against a key that has run out of budget', () => {
  let h: Harness;
  let project: Project;

  beforeAll(async () => {
    // Two a second, one in one go: the second immediate call is refused.
    h = await createHarness({ rateLimit: { rate: 2, burst: 1 } });
    project = await h.bootstrap('Rate limited');
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  // Each case spends the budget it needs from a full one. Waiting for the bucket to refill
  // instead would make the assertion depend on how long the case before it took.
  beforeEach(() => {
    h.resetRateLimit();
  });

  const env = (): { env: Record<string, string> } => ({
    env: { BOOKRAIL_SECRET_KEY: project.testKey },
  });

  it('exits 3 with the message and the fix the server sent, in JSON', async () => {
    const served = await h.cli(['whoami', '--json'], env());
    expect(served.code).toBe(0);

    const refused = await h.cli(['whoami', '--json'], env());
    expect(refused.code).toBe(3);
    const envelope = refused.json();
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('rate_limited');
    expect(envelope.error?.message).toBe(
      'This key may make 2 requests per second, with bursts of 1.',
    );
    expect(envelope.error?.fix).toBe(
      'Wait for Retry-After, or spread the calls. Live keys have higher limits.',
    );
    expect(envelope.error?.doc_url).toBe('https://bookrail.dev/docs/errors#rate_limited');
    // Nothing on stdout but the envelope, and nothing about the key itself anywhere.
    expect(refused.stdout).not.toContain(project.testKey);
  });

  it('prints the message and the fix to a human too', async () => {
    expect((await h.cli(['whoami'], env())).code).toBe(0);

    const refused = await h.cli(['whoami'], env());
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('This key may make 2 requests per second');
    expect(refused.stderr).toContain('Fix:');
    expect(refused.stderr).toContain('Wait for Retry-After');
  });

  it('serves the same command again after the wait', async () => {
    // The one case where the budget has to come back on its own, so it is spent here and waited
    // out rather than cleared. One request at two a second is a token every five hundred
    // milliseconds, so a second is twice the wait needed and the assertion is not on its edge.
    expect((await h.cli(['whoami', '--json'], env())).code).toBe(0);
    expect((await h.cli(['whoami', '--json'], env())).code).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const served = await h.cli(['whoami', '--json'], env());
    expect(served.code).toBe(0);
    expect(served.json().ok).toBe(true);
  });
});
