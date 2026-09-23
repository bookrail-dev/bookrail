/**
 * `bookrail stripe connect|status|disconnect`.
 *
 * Connecting a payment account is the one thing in this CLI that a terminal cannot finish on
 * its own: the authorisation happens on Stripe's own pages, in a browser, signed in as the
 * owner of the account. So `connect` does what `signup` does with a mailbox: it prints a link,
 * opens it when there is something to open it with, and then waits, asking the API every two
 * seconds whether the browser has come back.
 *
 * **No Stripe key is ever typed here.** There is no `--secret-key`, and there will not be one:
 * Bookrail is a Connect platform and acts for the connected account with its own platform key,
 * so a key of the customer's would be a secret held for nothing.
 */
import type { Context } from '../context.js';
import { openInBrowser, type SpawnLike } from '../browser.js';
import { CliError, EXIT } from '../errors.js';
import { renderTable, type CommandResult } from '../output.js';
import { clientFor, confirm, sleep } from './helpers.js';

/** How often the terminal asks whether the browser has come back. The interval of `signup`. */
export const POLL_INTERVAL_MS = 2_000;

export interface StripeConnectionBody {
  object: 'stripe_connection';
  status: 'connected' | 'not_connected' | 'disconnected';
  environment: string;
  id: string | null;
  account_id: string | null;
  publishable_key: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  disconnect_reason: string | null;
  charges_enabled: boolean | null;
  /** Whether the deployment holds the incoming webhook signing secret of this environment. */
  webhook_configured: boolean;
}

interface StripeConnectLinkBody {
  object: 'stripe_connect_link';
  url: string;
  expires_at: string;
  environment: string;
}

function connectionTable(body: StripeConnectionBody): string {
  return renderTable(
    ['field', 'value'],
    [
      ['status', body.status],
      ['environment', body.environment],
      ['account', body.account_id ?? '-'],
      // `unknown` rather than `false`: Stripe may simply not have answered, and the two are
      // different answers (`charges_enabled` is `null` in both the API and here).
      ['charges_enabled', body.charges_enabled === null ? 'unknown' : String(body.charges_enabled)],
      ['webhook_configured', String(body.webhook_configured)],
      ['connected_at', body.connected_at ?? '-'],
      ['disconnected_at', body.disconnected_at ?? '-'],
      ['publishable_key', body.publishable_key ?? '-'],
    ],
  );
}

function statusSteps(body: StripeConnectionBody): string[] {
  if (body.status !== 'connected') return ['Run `bookrail stripe connect` to connect an account.'];
  if (body.charges_enabled === false) {
    return [
      'The account is connected but Stripe is not letting it take charges yet: finish its onboarding in the Stripe dashboard.',
    ];
  }
  if (!body.webhook_configured) {
    return [
      'This deployment holds no Stripe webhook signing secret for this environment: a payment would start and never be confirmed. Whoever operates it has to register the endpoint in Stripe and set STRIPE_WEBHOOK_SECRET_TEST or _LIVE.',
    ];
  }
  return ['Run `bookrail stripe status --json` whenever you need the account id back.'];
}

export interface StripeConnectOptions {
  /** `--no-open`: print the link and do not launch anything. */
  open?: boolean;
  /** `--no-wait`: return as soon as the link exists, without polling. */
  wait?: boolean;
  /** Only a test passes one, so that no test ever opens a real browser. */
  spawnImpl?: SpawnLike;
}

export async function stripeConnect(
  ctx: Context,
  options: StripeConnectOptions,
): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const link = (await client.post<StripeConnectLinkBody>('/v1/stripe/connect', {})).data;

  // Printed before anything is opened, and printed whether or not anything opens: the link is
  // the thing that matters, and a person on a machine with no desktop still has to see it.
  const shouldOpen = options.open !== false && ctx.io.isTTY && !ctx.presenter.json;
  const opened =
    shouldOpen &&
    openInBrowser(
      link.url,
      options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl },
    );

  if (!ctx.presenter.json) {
    ctx.presenter.print(`Open this link and authorise your Stripe account:\n\n  ${link.url}\n`);
    if (opened) ctx.presenter.print('Opened it in your browser.');
    ctx.presenter.print(`The link works until ${link.expires_at}.`);
  }

  if (options.wait === false) {
    return {
      data: { ...link, opened, connection: null },
      human: 'Not waiting. Run `bookrail stripe status` once you have authorised.',
      nextSteps: ['Run `bookrail stripe status --json` to see whether it went through.'],
    };
  }

  if (!ctx.presenter.json) ctx.presenter.print('Waiting...');
  const settled = await waitForConnection(ctx, client, link.expires_at);

  if (settled === 'interrupted') {
    return {
      data: { ...link, opened, connection: null, status: 'waiting_stopped' },
      human: 'Stopped waiting. The link still works until it expires.',
      exitCode: EXIT.user,
      nextSteps: ['Run `bookrail stripe status` to check, or open the link again.'],
    };
  }
  if (settled === 'expired') {
    throw new CliError(
      'stripe_link_expired',
      'The link was not authorised within fifteen minutes.',
      {
        fix: 'Run `bookrail stripe connect` again to get a fresh link.',
        exitCode: EXIT.conflict,
      },
    );
  }

  return {
    data: settled,
    human: [
      `${ctx.presenter.badge()} connected ${settled.account_id ?? ''}`,
      '',
      connectionTable(settled),
    ].join('\n'),
    nextSteps: statusSteps(settled),
  };
}

export async function stripeStatus(ctx: Context): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const data = (await client.get<StripeConnectionBody>('/v1/stripe')).data;
  return {
    data,
    human: `${ctx.presenter.badge()} ${data.status}\n\n${connectionTable(data)}`,
    nextSteps: statusSteps(data),
  };
}

export async function stripeDisconnect(
  ctx: Context,
  options: { yes?: boolean },
): Promise<CommandResult> {
  await confirm(
    ctx,
    `Disconnect the Stripe account of this project (${ctx.environment})?`,
    options,
    'Run `bookrail stripe disconnect --yes`. Bookrail will stop being able to charge on that account; nothing already taken is affected.',
  );
  const client = await clientFor(ctx);
  const data = (await client.delete<StripeConnectionBody>('/v1/stripe')).data;
  return {
    data,
    human: `${ctx.presenter.badge()} disconnected ${data.account_id ?? ''}\n\n${connectionTable(data)}`,
    nextSteps: ['Run `bookrail stripe connect` to connect an account again.'],
  };
}

/**
 * Asks `GET /v1/stripe` every two seconds until it says `connected`, or the link expires.
 *
 * The deadline is the server's own `expires_at`, so the terminal and the state row cannot
 * disagree about when the link stopped working. Ctrl-C stops the loop and makes no further
 * call: the link simply runs out.
 */
async function waitForConnection(
  ctx: Context,
  client: Awaited<ReturnType<typeof clientFor>>,
  expiresAt: string,
): Promise<StripeConnectionBody | 'interrupted' | 'expired'> {
  let stopped = false;
  const detach = ctx.io.onInterrupt?.(() => {
    stopped = true;
  });
  const deadline = Date.parse(expiresAt);
  try {
    for (;;) {
      if (stopped) return 'interrupted';
      const body = (await client.get<StripeConnectionBody>('/v1/stripe')).data;
      if (body.status === 'connected') return body;
      if (Number.isFinite(deadline) && Date.now() > deadline) return 'expired';
      if (stopped) return 'interrupted';
      // Woken in small steps so that Ctrl-C is not two seconds late, exactly as `signup` does.
      for (let waited = 0; waited < POLL_INTERVAL_MS && !stopped; waited += 50) {
        await sleep(Math.min(50, POLL_INTERVAL_MS - waited));
      }
    }
  } finally {
    detach?.();
  }
}
