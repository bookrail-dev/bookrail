/* eslint-disable no-console */
/**
 * `bookrail-bootstrap`: an account, a project and two keys, from a shell on the machine that
 * owns the database.
 *
 * This is the path a deployment should take. The alternative is to leave
 * `POST /internal/bootstrap` mounted: that means the process listening on the internet holds,
 * permanently, both the connection string that bypasses Row Level Security and the shared
 * secret that unlocks the route, in order to serve an operation that happens once per
 * customer. A command that opens the connection, creates, prints and exits holds them for the
 * length of one invocation, and only for somebody who already has an administrator's shell on
 * the machine.
 *
 * The connection string is read from the environment (`DATABASE_URL`, or `DATABASE_ADMIN_URL`),
 * which a deployment normally supplies from the same root readable environment file its
 * migrations already use. Nothing is passed on a command line except the two names.
 *
 *   bookrail-bootstrap "Acme" "Acme production"
 *   bookrail-bootstrap "Acme" "Acme production" --timezone Europe/Rome --currency EUR
 *   bookrail-bootstrap ... --json          the whole envelope, secrets included, for a pipe
 *
 * Without `--json` the two secret keys are printed on their own lines, once, and the envelope
 * is printed without them.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabase, createPool, resolveDatabaseUrls } from '@bookrail/db';
import { createBootstrap, type BootstrapInput } from './bootstrap.js';
import { bootstrapSchema } from './schemas/index.js';

/** Options that take a value. Anything else beginning with `--` is a flag. */
const VALUED_OPTIONS = ['timezone', 'currency', 'tenant-id'] as const;

export interface ParsedBootstrapArgs {
  body: BootstrapInput;
  json: boolean;
}

/**
 * The command line, parsed in one pass. Exported because this is the part with the most ways to
 * be wrong and it had no test at all for a long time:
 * `smoke.sh` depends on `--json` emitting `.secrets.test`, and a regression here
 * breaks the bootstrap of every future customer.
 *
 * One pass rather than a filter that looks at `argv[i - 1]`, which was the previous shape and
 * which mis-parsed `--json --timezone X Acme Project` as soon as two options met.
 */
export function parseBootstrapArgs(argv: readonly string[]): ParsedBootstrapArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!(VALUED_OPTIONS as readonly string[]).includes(name)) {
        throw new Error(`Unknown option --${name}.`);
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--${name} needs a value.`);
      }
      options.set(name, value);
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  const [accountName, projectName, ...extra] = positional;
  if (accountName === undefined || projectName === undefined) {
    throw new Error(
      'Usage: bookrail-bootstrap <account name> <project name> ' +
        '[--timezone Europe/Rome] [--currency EUR] [--tenant-id ...] [--json]',
    );
  }
  if (extra.length > 0) {
    throw new Error(`Too many arguments: ${extra.join(', ')}. Quote names that contain a space.`);
  }

  // The same schema the HTTP route validates against: one contract, one set of limits.
  const body = bootstrapSchema.parse({
    account_name: accountName,
    project_name: projectName,
    ...(options.has('timezone') ? { default_timezone: options.get('timezone') } : {}),
    ...(options.has('currency') ? { default_currency: options.get('currency') } : {}),
    ...(options.has('tenant-id') ? { tenant_id: options.get('tenant-id') } : {}),
  });
  return { body, json };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { body, json } = parseBootstrapArgs(argv);

  const urls = resolveDatabaseUrls();
  const pool = createPool({ connectionString: urls.admin, max: 1 });
  try {
    const result = await createBootstrap(createDatabase(pool), body);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const { secrets, ...envelope } = result;
    console.log(JSON.stringify(envelope, null, 2));
    console.log('');
    console.log('The two keys, shown once. Nothing writes them down.');
    console.log(`  test: ${secrets.test}`);
    console.log(`  live: ${secrets.live}`);
  } finally {
    await pool.end();
  }
}

/**
 * Only when this file is what was executed. Importing it, which is what its test does, must not
 * open a pool and create an account.
 *
 * **Both sides are resolved to a real path, and that is the whole of it.** Node leaves
 * `process.argv[1]` exactly as it was given, and resolves the module's real path before it
 * assigns `import.meta.url`. A deployment that keeps its releases in dated directories and
 * points a symlink at the current one therefore invokes this file through the symlink, while
 * `import.meta.url` names the directory behind it: comparing the two strings answers **false**,
 * and the command prints nothing and exits 0. A bootstrap that silently does nothing is worse
 * than one that fails, because the next step is a `jq` on an empty string, which also
 * succeeds.
 *
 * `realpathSync` can throw when `argv[1]` does not name an existing file, which happens with
 * `node --eval` and in some embedders, so it is guarded: not being able to resolve it means this
 * module was not the thing that was executed.
 */
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
