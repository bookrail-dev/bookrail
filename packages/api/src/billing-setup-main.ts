/* eslint-disable no-console */
/**
 * `setup-stripe-billing`: creates, or brings up to date, the catalogue of Billing on one Stripe
 * account (the products, the prices of Pro and Scale, the customer portal), and archives the tax
 * rates of the catalogue before Stripe Tax.
 *
 *   STRIPE_SECRET_KEY_TEST=sk_test_... node dist/billing-setup-main.js --mode test
 *   STRIPE_SECRET_KEY_LIVE=sk_live_... node dist/billing-setup-main.js --mode live
 *
 * Run by a person, first on the sandbox and then on the live account, and again whenever a
 * price in the code changes. It is idempotent (see `billing/setup.ts`): a second run creates
 * nothing. The key is read from the environment, never from the command line, and nothing it
 * prints is a secret: it prints what it did, with the identifiers of the objects.
 *
 * `STRIPE_API_BASE` points it at a fake Stripe in a test, and is refused with `--mode live`.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SITE_URL } from './config.js';
import { setupStripeBillingCatalog, type SetupReport } from './billing/setup.js';
import { DEFAULT_STRIPE_API_BASE } from './stripe/client.js';
import { StripeBillingClient } from './stripe/billing-client.js';

export const SETUP_USAGE = [
  'Usage: setup-stripe-billing --mode <test|live> [--site-url <url>]',
  '',
  'Creates or updates, on the Stripe account of the key, without ever duplicating:',
  '  the products bookrail_pro, bookrail_scale, bookrail_bookings_over_quota and',
  '  bookrail_orchestrated_payments, with the tax code of SaaS for business use (txcd_10103001);',
  '  the monthly prices bookrail_pro_monthly and bookrail_scale_monthly (EUR, VAT excluded);',
  '  the configuration of the customer portal (no plan changes: the dashboard makes them).',
  'It archives the product bookrail_plan and the tax rates of the catalogue before Stripe Tax.',
  'The tax is Stripe Tax: its registrations and origin address are set in the Stripe dashboard.',
  '',
  'With --mode live, --site-url must be https://.',
  '',
  'The key comes from STRIPE_SECRET_KEY_TEST or STRIPE_SECRET_KEY_LIVE, by mode.',
  'It prints the identifiers of what it made. It never prints a key.',
].join('\n');

export interface SetupArgs {
  mode: 'test' | 'live';
  siteUrl: string;
}

export function parseSetupArgs(argv: readonly string[]): SetupArgs | 'help' {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  let mode: string | undefined;
  let siteUrl = DEFAULT_SITE_URL;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') mode = argv[++index];
    else if (arg === '--site-url') siteUrl = (argv[++index] ?? '').replace(/\/+$/, '');
    else throw new Error(`Unknown argument "${arg ?? ''}".\n${SETUP_USAGE}`);
  }
  if (mode !== 'test' && mode !== 'live')
    throw new Error(`--mode must be test or live.\n${SETUP_USAGE}`);
  if (!/^https?:\/\//.test(siteUrl)) throw new Error(`--site-url must be a URL.\n${SETUP_USAGE}`);
  // The live portal sends real customers back to this address: never a development server.
  if (mode === 'live' && !/^https:\/\/[^/]+/.test(siteUrl)) {
    throw new Error(`--site-url must be an https:// URL with --mode live.\n${SETUP_USAGE}`);
  }
  return { mode, siteUrl };
}

export async function runSetup(
  args: SetupArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SetupReport> {
  const name = `STRIPE_SECRET_KEY_${args.mode.toUpperCase()}`;
  const key = env[name]?.trim() ?? '';
  if (!new RegExp(`^[sr]k_${args.mode}_`).test(key)) {
    throw new Error(`${name} must be set to a ${args.mode} mode secret key (sk_${args.mode}_...).`);
  }
  const apiBase = (env.STRIPE_API_BASE?.trim() || DEFAULT_STRIPE_API_BASE).replace(/\/+$/, '');
  if (args.mode === 'live' && apiBase !== DEFAULT_STRIPE_API_BASE) {
    throw new Error(
      'STRIPE_API_BASE is for a fake Stripe in a test and is refused with --mode live.',
    );
  }
  const client = new StripeBillingClient({ secretKey: key, apiBase });
  return setupStripeBillingCatalog(client, { siteUrl: args.siteUrl });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseSetupArgs(argv);
  if (args === 'help') {
    console.log(SETUP_USAGE);
    return;
  }
  const report = await runSetup(args);
  console.log(JSON.stringify({ mode: args.mode, ...report }, null, 2));
}

/** Only when this file is what was executed; see the same guard in `plan-main.ts`. */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
