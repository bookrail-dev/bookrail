/**
 * What an agent gets back when the key it was given has run out of budget.
 *
 * The server needed no change for this, and that is what the file checks: a `429` from the API
 * arrives at the agent as the structured error envelope every other failure arrives as, with
 * `code`, `message` and the `fix` the server sent, and the tool call ends as an error result rather
 * than as a crash or a stack trace on the one stream the protocol owns.
 *
 * A real HTTP server in front of `createApp`, with the real limiter and a ceiling of one request.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Project } from './harness.js';

let h: Harness;
let project: Project;

beforeAll(async () => {
  // Two a second, one in one go: the second immediate call is refused.
  h = await createHarness({ rateLimit: { rate: 2, burst: 1 } });
  project = await h.bootstrap('MCP Rate Limited');
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('a tool call that hits the ceiling', () => {
  it('answers the structured error, with the fix, and does not crash', async () => {
    const session = await h.session({ env: { BOOKRAIL_SECRET_KEY: project.testKey } });
    try {
      const served = await session.call('bookrail_project_info', {});
      expect(served.isError).toBe(false);

      const refused = await session.call('bookrail_project_info', {});
      expect(refused.isError).toBe(true);
      expect(refused.envelope.ok).toBe(false);
      expect(refused.envelope.error?.code).toBe('rate_limited');
      expect(refused.envelope.error?.message).toBe(
        'This key may make 2 requests per second, with bursts of 1.',
      );
      expect(refused.envelope.error?.fix).toBe(
        'Wait for Retry-After, or spread the calls. Live keys have higher limits.',
      );
      expect(refused.envelope.error?.doc_url).toBe('https://bookrail.dev/docs/errors#rate_limited');
      // The key never appears in anything the agent or the log can read.
      expect(JSON.stringify(refused.raw)).not.toContain(project.testKey);
      expect(session.stderr.join('\n')).not.toContain(project.testKey);

      // And the same tool works again once the bucket has drained. One request at two a second
      // is a token every five hundred milliseconds, so a second is twice what is needed.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const again = await session.call('bookrail_project_info', {});
      expect(again.isError).toBe(false);
    } finally {
      await session.close();
    }
  });
});
