/**
 * `bookrail signup`: a test key and a live key, from a terminal, without writing to anybody.
 *
 * Both keys arrive together and are stored together: `keys.test` and `keys.live` of the
 * credentials file, mode 600. Test stays the default environment, as it is for every command: a
 * live key on disk is used only when `--live` is typed. The live key books for real, on the free
 * plan, which refuses new live bookings once the month's included ones are used.
 *
 * It is the only command that runs without a key, because it is the command that produces one.
 * The shape of it is: ask for a link, wait for the person to open it, store what comes back.
 *
 * ## Why it waits instead of asking for the token
 *
 * The link goes to a mailbox, and the mailbox is usually open in a browser somewhere else. A
 * command that asked the caller to paste a token back would work, and would also mean copying
 * a secret through a clipboard and a shell history for no reason. So the confirmation happens
 * where the link was opened, and this command polls a second token of its own until the key is
 * ready. The two tokens are different on purpose: the one in the message proves the mailbox,
 * the one held here proves the terminal.
 *
 * ## Ctrl-C
 *
 * Stopping is not an error and not a success either: nothing was stored, so a script must not
 * read it as "there is a key now". It exits 1, the code for "the command did not do what it was
 * asked", and it makes no further call: the sign up on the server simply runs out on its own.
 * The output says what to run to start again.
 */
import {
  DPA_URL,
  TERMS_ACCEPTANCE_TEXT,
  TERMS_CLAUSES_TEXT,
  TERMS_CLAUSES_URL,
  TERMS_URL,
} from '../terms.js';
import { ApiClient } from '../api/client.js';
import type { Context } from '../context.js';
import { loadCredentials, saveCredentials } from '../credentials.js';
import { CliError, EXIT } from '../errors.js';
import type { CommandResult } from '../output.js';

export interface SignupOptions {
  email?: string;
  accountName?: string;
  projectName?: string;
  timezone?: string;
  currency?: string;
  /** `--no-store`: print the keys once and write nothing to disk. */
  store?: boolean;
  /**
   * `--accept-terms`: the first tick, the Terms of Service and the DPA accepted on behalf of the
   * business. `--approve-clauses`: the second, the specific approval of the clauses of Section 17
   * (Articles 1341 and 1342 of the Italian Civil Code). Two flags for two acts: a tick is never
   * given by the other one. Without a terminal both are required; in a terminal the command asks
   * for each one that was not given, separately.
   */
  acceptTerms?: boolean;
  approveClauses?: boolean;
  apiUrl?: string;
}

/** How often the terminal asks whether the link has been opened. */
export const POLL_INTERVAL_MS = 2_000;

/**
 * How long to wait when something in the middle says «not so fast» and gives no advice.
 *
 * A poll every two seconds is well inside what the API allows, but this command runs for as
 * long as somebody takes to open an email, and anything between the terminal and the API can
 * have a limit of its own: a company proxy, a home router, the reverse proxy in front of the
 * deployment. A `429` there is a pause, not the end of the sign up: the link is still valid and
 * the key is still waiting, so the loop sleeps and asks again instead of throwing away the run.
 * `Retry-After` wins when the answer carries one.
 */
export const RATE_LIMIT_PAUSE_MS = 5_000;

/**
 * The longest pause a `Retry-After` may buy, in milliseconds.
 *
 * `Retry-After` is written by whatever refused the request, and that is not always this API: a
 * company proxy, a home router or a reverse proxy in front of a deployment can all send one, and
 * some of them say sixty seconds for a limit whose token comes back in one. A terminal that
 * believes such a number sits there doing nothing while the link in the mailbox is already valid,
 * which is how a sign up that takes two minutes starts taking three. Fifteen seconds is longer
 * than any wait this API asks for and short enough that a person does not think it has hung; past
 * it the loop simply asks again, and being refused again costs one request.
 */
export const MAX_RATE_LIMIT_PAUSE_MS = 15_000;

/** The shortest pause, so that a `Retry-After: 0` from anywhere cannot become a tight loop. */
export const MIN_RATE_LIMIT_PAUSE_MS = 1_000;

/**
 * How long to sleep after a `429`, from the `Retry-After` it carried, if it carried one.
 *
 * A floor as well as a ceiling. `Retry-After: 0` is a legal header and something in the middle can
 * send it; without the floor the loop would ask again immediately and keep asking, turning a pause
 * into a tight loop of HTTP requests for as long as the sign up is valid. One second is the
 * smallest wait this API ever asks for, and the smallest that is worth calling a pause.
 */
export function rateLimitPauseMs(retryAfterSeconds: number | undefined): number {
  const asked = (retryAfterSeconds ?? RATE_LIMIT_PAUSE_MS / 1000) * 1000;
  return Math.min(Math.max(asked, MIN_RATE_LIMIT_PAUSE_MS), MAX_RATE_LIMIT_PAUSE_MS);
}

interface SignupBody {
  id: string;
  object: 'signup';
  status: 'pending' | 'confirmed' | 'claimed' | 'email_taken' | 'expired';
  email?: string;
  expires_at?: string;
  poll_token?: string;
  delivered_to?: 'cli';
  secret_key?: string;
  live_secret_key?: string;
  account?: { id: string; name: string };
  project?: { id: string; name: string; default_timezone: string; default_currency: string };
  api_key?: { id: string; environment: string; kind: string; prefix: string };
  api_keys?: { id: string; environment: string; kind: string; prefix: string }[];
}

export async function signup(ctx: Context, options: SignupOptions): Promise<CommandResult> {
  const email = await resolveEmail(ctx, options);
  await resolveTerms(ctx, options);
  const apiUrl = options.apiUrl?.trim();
  const baseUrl = apiUrl && apiUrl !== '' ? apiUrl : await ctx.apiUrl();
  // No key: these three endpoints have none in front of them, and this is why.
  const client = new ApiClient({
    baseUrl,
    environment: 'test',
    ...(ctx.options.timeout === undefined ? {} : { timeoutMs: ctx.options.timeout }),
    actor: 'cli',
  });

  const created = (
    await client.post<SignupBody>('/v1/signups', {
      email,
      client: 'cli',
      accept_terms: true,
      approve_clauses: true,
      ...(options.accountName === undefined ? {} : { account_name: options.accountName }),
      ...(options.projectName === undefined ? {} : { project_name: options.projectName }),
      ...(options.timezone === undefined ? {} : { default_timezone: options.timezone }),
      ...(options.currency === undefined ? {} : { default_currency: options.currency }),
    })
  ).data;

  const pollToken = created.poll_token;
  if (pollToken === undefined) {
    throw new CliError('invalid_response', 'The API did not return a token to wait on.', {
      fix: 'Upgrade the CLI, or write to hello@bookrail.dev with the request id.',
      exitCode: EXIT.service,
    });
  }

  if (!ctx.presenter.json) {
    ctx.presenter.print(`We sent a link to ${email}. Open it, then come back here.`);
    if (created.expires_at !== undefined) {
      ctx.presenter.print(`The link works until ${created.expires_at}.`);
    }
    ctx.presenter.print('Waiting...');
  }

  const settled = await waitForKey(ctx, client, created.id, pollToken, created.expires_at);
  if (settled === 'interrupted') {
    return {
      data: { id: created.id, email, status: 'waiting_stopped' },
      human: 'Stopped waiting. Run bookrail signup again to get a new link.',
      exitCode: EXIT.user,
    };
  }

  if (settled.status === 'email_taken') {
    throw new CliError(
      'signup_email_taken',
      'This address already has a Bookrail account. Its keys are managed in the dashboard: https://bookrail.dev/dashboard/.',
      {
        fix: 'Sign in at https://bookrail.dev/dashboard/ with this address, create a key, then run `bookrail login --token sk_test_...`.',
        exitCode: EXIT.conflict,
      },
    );
  }
  if (settled.status === 'expired') {
    throw new CliError('signup_expired', 'The link was not opened within the hour.', {
      fix: 'Run `bookrail signup` again to get a new link.',
      exitCode: EXIT.conflict,
    });
  }

  const secret = settled.secret_key;
  if (secret === undefined) {
    throw new CliError('invalid_response', 'The API confirmed the sign up without a key.', {
      fix: 'Write to hello@bookrail.dev with the request id of the failed call.',
      exitCode: EXIT.service,
    });
  }
  // Absent only from an API older than the live key at sign up: the test key is then the whole
  // answer, and the live one comes from the dashboard.
  const live = settled.live_secret_key;
  const testKey = settled.api_keys?.find((key) => key.environment === 'test') ?? settled.api_key;
  const liveKey = settled.api_keys?.find((key) => key.environment === 'live');

  const store = options.store !== false;
  let path: string | null = null;
  if (store) {
    const credentials = await loadCredentials(ctx.io);
    const keys = {
      ...credentials.file.keys,
      test: secret,
      ...(live === undefined ? {} : { live }),
    };
    const file = { ...credentials.file, keys };
    if (apiUrl && apiUrl !== '') file.api_url = apiUrl;
    path = await saveCredentials(ctx.io, file);
  }

  return {
    data: {
      id: settled.id,
      email,
      status: 'confirmed',
      account: settled.account ?? null,
      project: settled.project ?? null,
      api_key: settled.api_key ?? null,
      api_keys: settled.api_keys ?? (settled.api_key === undefined ? [] : [settled.api_key]),
      // The keys are in the structured output **only** when they were not stored, because then
      // this is the one place they exist. With `--store` they are on disk and printing them as
      // well would put them in a log somebody keeps.
      ...(store
        ? { stored_in: path }
        : { secret_key: secret, ...(live === undefined ? {} : { live_secret_key: live }) }),
    },
    human: [
      `${ctx.presenter.badge()} account ${settled.account?.name ?? ''} (${settled.account?.id ?? ''})`,
      `project  ${settled.project?.name ?? ''} (${settled.project?.id ?? ''})`,
      `test key sk_test_${testKey?.prefix ?? ''}... (${testKey?.id ?? ''})`,
      ...(liveKey === undefined
        ? []
        : [`live key sk_live_${liveKey.prefix}... (${liveKey.id}), free plan`]),
      ...(store
        ? [`stored   ${path ?? ''} (mode 600)`]
        : [
            `test key ${secret}`,
            ...(live === undefined ? [] : [`live key ${live}`]),
            '         Not stored. This is the only time they are shown.',
          ]),
    ].join('\n'),
    nextSteps: [
      'Run `bookrail whoami` to confirm.',
      'Run `bookrail init --template <vertical>` to create a bookrail.config.ts.',
      'Everything runs against test until you add `--live`. The live key books for real, on the free plan.',
      'Run `bookrail doctor` to check the whole setup.',
    ],
  };
}

/**
 * Polls until the link is opened, the sign up settles, or the caller stops waiting.
 *
 * The interval is the product's, not a test's convenience: a person is clicking a link in
 * another window, and two seconds is short enough to feel immediate and long enough not to be
 * a busy loop. The deadline comes from the server's own `expires_at`, so the two cannot drift.
 */
async function waitForKey(
  ctx: Context,
  client: ApiClient,
  id: string,
  pollToken: string,
  expiresAt: string | undefined,
): Promise<SignupBody | 'interrupted'> {
  let stopped = false;
  const detach = ctx.io.onInterrupt?.(() => {
    stopped = true;
  });
  const deadline = expiresAt === undefined ? null : Date.parse(expiresAt);

  try {
    for (;;) {
      if (stopped) return 'interrupted';
      let body: SignupBody;
      try {
        body = (await client.post<SignupBody>(`/v1/signups/${id}/claim`, { poll_token: pollToken }))
          .data;
      } catch (error) {
        // A limit, ours or somebody else's, is a pause. Everything else is a real failure and
        // goes to the caller unchanged: a sign up that cannot be claimed is not a sign up to
        // keep waiting on.
        if (!(error instanceof CliError) || error.status !== 429) throw error;
        if (deadline !== null && Date.now() > deadline)
          return { id, object: 'signup', status: 'expired' };
        await sleep(rateLimitPauseMs(error.retryAfterSeconds), () => stopped);
        continue;
      }
      if (body.status !== 'pending') return body;
      if (deadline !== null && Date.now() > deadline) return { ...body, status: 'expired' };
      if (stopped) return 'interrupted';
      await sleep(POLL_INTERVAL_MS, () => stopped);
    }
  } finally {
    detach?.();
  }
}

/** Waits, but wakes up as soon as an interrupt has been seen, so Ctrl-C is not two seconds late. */
async function sleep(ms: number, stopped: () => boolean): Promise<void> {
  const step = 50;
  for (let waited = 0; waited < ms; waited += step) {
    if (stopped()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
  }
}

/**
 * The two ticks of the terms, before anything is sent.
 *
 * Each has its flag (`--accept-terms`, `--approve-clauses`) and its own question: the specific
 * approval of the clauses of Section 17 is a second act, and is never implied by the first. A
 * terminal is asked for each tick its flag did not give, one sentence at a time; with no terminal
 * to ask on (an agent, a pipe, `--non-interactive`) the command refuses and names the flags that
 * are missing, because an acceptance nobody typed is not an acceptance.
 */
async function resolveTerms(ctx: Context, options: SignupOptions): Promise<void> {
  const ticks = [
    {
      given: options.acceptTerms === true,
      flag: '--accept-terms',
      question: `${TERMS_ACCEPTANCE_TEXT}. Type yes to accept: `,
    },
    {
      given: options.approveClauses === true,
      flag: '--approve-clauses',
      question: `${TERMS_CLAUSES_TEXT}. Type yes to approve: `,
    },
  ];
  const missing = ticks.filter((tick) => !tick.given);
  if (missing.length === 0) return;
  if (ctx.options.nonInteractive || ctx.io.prompt === undefined) {
    const flags = missing.map((tick) => tick.flag).join(' and ');
    throw new CliError(
      'terms_not_accepted',
      'API keys are issued under the Terms of Service and the Data Processing Agreement, and there is no terminal to accept them on.',
      {
        param: missing[0]?.flag.slice(2) ?? 'accept-terms',
        fix: `Read ${TERMS_URL}, ${DPA_URL} and ${TERMS_CLAUSES_URL}, then run \`bookrail signup --accept-terms --approve-clauses\` on behalf of your business (missing: ${flags}).`,
        exitCode: EXIT.user,
      },
    );
  }
  // With --json the standard output is the envelope alone: the links go where the questions go.
  const show = (line: string): void =>
    ctx.presenter.json ? ctx.presenter.warn(line) : ctx.presenter.print(line);
  show(`Terms of Service: ${TERMS_URL}`);
  show(`Data Processing Agreement: ${DPA_URL}`);
  show(`Section 17 of the Terms: ${TERMS_CLAUSES_URL}`);
  for (const tick of missing) {
    const answer = await ctx.io.prompt(tick.question);
    if (answer.trim().toLowerCase() !== 'yes') {
      throw new CliError(
        'terms_not_accepted',
        'The terms were not accepted, so nothing was sent.',
        {
          fix: 'Run `bookrail signup` again and answer yes to both, or pass --accept-terms and --approve-clauses.',
          exitCode: EXIT.user,
        },
      );
    }
  }
}

async function resolveEmail(ctx: Context, options: SignupOptions): Promise<string> {
  const given = options.email?.trim();
  if (given !== undefined && given !== '') return given;
  if (ctx.options.nonInteractive || ctx.io.prompt === undefined) {
    throw new CliError('missing_input', 'No email address given and no terminal to ask on.', {
      param: 'email',
      fix: 'Run `bookrail signup --email you@example.com`.',
      exitCode: EXIT.user,
    });
  }
  const typed = (await ctx.io.prompt('Email address for the API keys: ')).trim();
  if (typed === '') {
    throw new CliError('missing_input', 'No email address given.', {
      param: 'email',
      fix: 'Run `bookrail signup --email you@example.com`.',
      exitCode: EXIT.user,
    });
  }
  return typed;
}
