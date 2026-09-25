import { Command, CommanderError } from 'commander';
import { createContext, readGlobalOptions, type Context } from './context.js';
import { CliError, EXIT, type ExitCode } from './errors.js';
import type { Io } from './io.js';
import { createPresenter, type CommandResult } from './output.js';
import { CLI_VERSION } from './version.js';
import { envCommand, login, logout, version, whoami } from './commands/auth.js';
import { signup } from './commands/signup.js';
import { stripeConnect, stripeDisconnect, stripeStatus } from './commands/stripe.js';
import {
  createEntity,
  deleteEntity,
  ENTITIES,
  entityByCommand,
  getEntity,
  listEntities,
  updateEntity,
} from './commands/crud.js';
import { docs } from './commands/docs.js';
import { doctor } from './commands/doctor.js';
import { examples } from './commands/examples.js';
import { init, FRAMEWORKS } from './commands/init.js';
import { notYetAvailable } from './commands/helpers.js';
import { mcpInstall, MCP_CLIENT_NAMES } from './commands/mcp.js';
import { schema, SCHEMA_NAMES } from './commands/schema.js';
import { diff, pull, push } from './commands/sync.js';
import { TEMPLATE_NAMES } from './templates/index.js';
import { availability, availabilityCheck, availabilityNext } from './commands/availability.js';
import { holdCreate, holdGet, holdRelease } from './commands/holds.js';
import { resourceBlocks } from './commands/blocks.js';
import {
  bookingAction,
  bookingCancel,
  bookingCreate,
  bookingGet,
  bookingList,
  bookingReschedule,
  TRANSITIONS,
} from './commands/bookings.js';
import { paymentGet, paymentList } from './commands/payments.js';
import { eventGet, eventList } from './commands/events.js';
import { webhooksListen } from './commands/listen.js';
import {
  webhookCreate,
  webhookDeliveries,
  webhookDelete,
  webhookGet,
  webhookList,
  webhookRetry,
  webhookTest,
  webhookUpdate,
} from './commands/webhooks.js';

export interface Outcome {
  code: ExitCode;
}

type Handler = (
  ctx: Context,
  options: Record<string, unknown>,
  args: string[],
) => Promise<CommandResult> | CommandResult;

/**
 * Wraps a command implementation so that every command has the same shape: resolve the global
 * options, build a context, run, print through the presenter, and set the exit code.
 *
 * No command ever calls `process.exit` or writes to a stream itself, which is what lets the
 * whole CLI be driven in-process by a test, and by the MCP server.
 */
function action(io: Io, outcome: Outcome, handler: Handler) {
  return async (...raw: unknown[]): Promise<void> => {
    const command = raw[raw.length - 1] as Command;
    const options = (raw[raw.length - 2] ?? {}) as Record<string, unknown>;
    const positional = raw.slice(0, -2) as string[];
    const merged = { ...command.optsWithGlobals(), ...options };

    let ctx: Context | null = null;
    try {
      ctx = createContext(io, readGlobalOptions(merged, io));
      outcome.code = ctx.presenter.emit(await handler(ctx, merged, positional));
    } catch (error) {
      const presenter =
        ctx?.presenter ??
        createPresenter(io, {
          json: merged.json === true,
          environment: merged.live === true ? 'live' : 'test',
        });
      outcome.code = presenter.fail(toCliError(error));
    }
  };
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError('unexpected_error', message, {
    fix: 'This is a bug in the CLI. Re-run with `--json` and report the output.',
    exitCode: EXIT.service,
  });
}

const ENV_NOTE =
  'Runs against the test environment unless --live is given. The environment is in every output.';

export function buildProgram(io: Io, outcome: Outcome): Command {
  const program = new Command();

  program
    .name('bookrail')
    .description(
      [
        'Bookrail: booking infrastructure as code.',
        '',
        'Describe locations, schedules, resources, groups, policies and services in',
        'bookrail.config.ts, then push them. Every command takes --json and prints',
        '{ ok, environment, data, error?, next_steps? }.',
        '',
        'Exit codes: 0 success, 1 user or config error, 2 authentication, 3 network or',
        'service, 4 conflict.',
      ].join('\n'),
    )
    .version(CLI_VERSION, '-V, --version', 'Print the CLI version and exit.')
    .option('--json', 'Print the structured envelope instead of a human table.')
    .option('--live', 'Operate on the live environment. Without it everything is test.')
    .option(
      '--non-interactive',
      'Never prompt; fail with a fix instead. Implied when stdout is not a terminal.',
    )
    .option(
      '--api-url <url>',
      'Base URL of the API. Defaults to BOOKRAIL_API_URL, then the stored one.',
    )
    .option('--timeout <seconds>', 'Per-request timeout. Default 30.')
    .showHelpAfterError('Run `bookrail --help` to see the commands.')
    .enablePositionalOptions();

  // --- authentication ---------------------------------------------------------------------

  program
    .command('login')
    .description('Store an API key for its environment.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: a sk_test_ or sk_live_ secret key, from --token or from the terminal.',
        'Returns: the environment, the masked key, and where it was stored (mode 600).',
        'Next: `bookrail whoami`, then `bookrail init`.',
      ].join('\n'),
    )
    .option(
      '--token <key>',
      'The secret key, or `-` to read it from standard input. Without it, and with a terminal, you are asked.',
    )
    .option('--api-url <url>', 'Store a non-default API base URL alongside the key.')
    .option('--skip-verification', 'Do not call the API to check the key before storing it.')
    .action(action(io, outcome, (ctx, options) => login(ctx, options)));

  program
    .command('signup')
    .description('Get a test key and a live key by email, without asking anybody.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: an email address, from --email or from the terminal. No API key.',
        'It sends a confirmation link, waits for you to open it, and stores both keys.',
        'Returns: the account, the project, the two key prefixes and where they were stored.',
        'The live key books for real, on the free plan. Test stays the default: live needs --live.',
        'The keys are issued under the Terms of Service (https://bookrail.dev/terms) and the',
        'Data Processing Agreement (https://bookrail.dev/dpa). In a terminal you are asked, one at',
        'a time, to accept them and to approve the clauses of their Section 17; without one,',
        '--accept-terms and --approve-clauses are required.',
        'More keys, and revoking them: the dashboard at https://bookrail.dev/dashboard/.',
        'Next: `bookrail whoami`, then `bookrail init`.',
      ].join('\n'),
    )
    .option('--email <address>', 'Where to send the confirmation link.')
    .option('--account-name <name>', 'Name of the account. Defaults to the part before the @.')
    .option('--project-name <name>', 'Name of the first project. Defaults to Default.')
    .option('--timezone <zone>', 'Default time zone of the project. Defaults to UTC.')
    .option('--currency <code>', 'Default currency of the project. Defaults to EUR.')
    .option('--no-store', 'Print the keys once instead of writing them to the credentials file.')
    .option(
      '--accept-terms',
      'Accept the Terms of Service and the DPA on behalf of your business. Required without a terminal.',
    )
    .option(
      '--approve-clauses',
      'Specifically approve the clauses listed in Section 17 of the Terms (Articles 1341 and 1342 of the Italian Civil Code). Required without a terminal.',
    )
    .option('--api-url <url>', 'Base URL of the API to sign up against.')
    .action(action(io, outcome, (ctx, options) => signup(ctx, options)));

  program
    .command('logout')
    .description('Forget the stored key for this environment.')
    .addHelpText('after', '\nReturns: which key was removed and from which file.')
    .option('--all', 'Remove the whole credentials file, both environments.')
    .action(action(io, outcome, (ctx, options) => logout(ctx, options)));

  program
    .command('whoami')
    .description('Show which key, environment and API this invocation would use.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: a stored key or BOOKRAIL_SECRET_KEY.',
        'Returns: environment, masked key, key source, API URL and version.',
        'Fails with exit 2 when the key is missing, wrong or refused.',
      ].join('\n'),
    )
    .action(action(io, outcome, (ctx) => whoami(ctx)));

  program
    .command('version')
    .description('Print the CLI version, the API version it asks for, and the Node version.')
    .action(action(io, outcome, (ctx) => version(ctx)));

  program
    .command('env')
    .description('Print the environment variables to set for this environment.')
    .addHelpText('after', '\nThe key is masked: read the real one from the credentials file.')
    .action(action(io, outcome, (ctx) => envCommand(ctx)));

  // --- configuration as code ---------------------------------------------------------------

  program
    .command('init')
    .description('Write bookrail.config.ts (and .env.example) from a vertical template.')
    .addHelpText(
      'after',
      [
        '',
        `Templates: ${TEMPLATE_NAMES.join(', ')}.`,
        `Frameworks: ${FRAMEWORKS.join(', ')} (non-none also writes bookrail.ts, a minimal client).`,
        'Needs: nothing. It never contacts the API and never prompts.',
        'Returns: the files written.',
        'Next: `bookrail push --dry-run`.',
      ].join('\n'),
    )
    .option('--template <name>', 'Vertical to start from. Default: empty.')
    .option('--framework <name>', 'Also write a minimal client for this framework.')
    .option('--dir <path>', 'Directory to write into. Default: the working directory.')
    .option('--project <name>', 'Override the `project` field of the template.')
    .option('--force', 'Overwrite files that already exist.')
    .action(action(io, outcome, (ctx, options) => init(ctx, options)));

  program
    .command('push')
    .description('Make the project match bookrail.config.ts.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: a key, and a bookrail.config.* in the working directory (or --config).',
        'Returns: the plan (create / update / delete / unchanged) and what was applied.',
        'Objects with no metadata.config_id are never touched; they are listed as unmanaged.',
        'Deletions require --yes. ' + ENV_NOTE,
        '--adopt kind:config_id=remote_id makes one existing object managed, by stamping',
        'metadata.config_id on it. Never by name: names are not unique, and adopting the wrong',
        '"Court 1" would write one court\'s hours onto another. Repeatable.',
        'Next: run `bookrail diff`. It must report no differences.',
      ].join('\n'),
    )
    .option('--config <path>', 'Path to the configuration file.')
    .option('--dry-run', 'Compute and print the plan; change nothing.')
    .option('--yes', 'Accept the deletions in the plan.')
    .option(
      '--adopt <kind:config_id=remote_id>',
      'Take over an existing object under this logical id. Repeatable.',
      collect,
      [],
    )
    .action(action(io, outcome, (ctx, options) => push(ctx, options)));

  program
    .command('pull')
    .description('Write the current project out as a bookrail.config.ts.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: a key.',
        'Returns: the file written, and the objects that carry no metadata.config_id.',
        'Refuses to overwrite an existing file without --force.',
        '--adopt also STAMPS metadata.config_id on every unmanaged object, with the logical id',
        'this command derived from its name, so the file it writes is one push will reconcile',
        'instead of duplicating. It is the only way this command writes anything.',
      ].join('\n'),
    )
    .option('--out <path>', 'Where to write. Default: bookrail.config.ts.')
    .option('--stdout', 'Print the file instead of writing it.')
    .option('--force', 'Overwrite an existing file.')
    .option('--adopt', 'Stamp metadata.config_id on the unmanaged objects before writing.')
    .action(action(io, outcome, (ctx, options) => pull(ctx, options)));

  program
    .command('diff')
    .description('Show what push would change, without changing anything.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: a key and a configuration file.',
        'Returns: `has_changes` plus the same plan `push --dry-run` prints.',
        'Exit code stays 0 whether or not there are differences: branch on `has_changes`.',
      ].join('\n'),
    )
    .option('--config <path>', 'Path to the configuration file.')
    .action(action(io, outcome, (ctx, options) => diff(ctx, options)));

  // --- CRUD --------------------------------------------------------------------------------

  for (const entity of ENTITIES) {
    const group = program
      .command(entity.command)
      .description(`Create, read, update and delete ${entity.command}.`)
      .addHelpText(
        'after',
        [
          '',
          `Sub-commands: list, get <id>, create, update <id>, delete <id>.`,
          entity.expandable.length > 0
            ? `Expandable: ${entity.expandable.join(', ')} (repeat --expand).`
            : 'Nothing is expandable on this collection.',
          'Bodies come from --data \'{"..."}\', --file body.json (or --file - for stdin), or --set key=value.',
          ENV_NOTE,
        ].join('\n'),
      );

    group
      .command('list')
      .description(`List ${entity.command}, one cursor page at a time.`)
      .option('--limit <n>', 'Page size, 1 to 100. Default 20.')
      .option('--starting-after <id>', 'Cursor: the id of the last item of the previous page.')
      .option('--all', 'Follow the cursor to the end and return everything.')
      .option('--expand <field>', 'Expand a related object. Repeatable.', collect, [])
      .action(
        action(io, outcome, (ctx, options) =>
          listEntities(ctx, entityByCommand(entity.command), options),
        ),
      );

    group
      .command('get <id>')
      .description(`Read one ${entity.singular} by its prefixed id.`)
      .option('--expand <field>', 'Expand a related object. Repeatable.', collect, [])
      .action(
        action(io, outcome, (ctx, options, args) =>
          getEntity(ctx, entityByCommand(entity.command), args[0] as string, options),
        ),
      );

    group
      .command('create')
      .description(`Create one ${entity.singular}.`)
      .option('--data <json>', 'The body, as a JSON object.')
      .option('--file <path>', 'Read the body from a file, or from stdin with `-`.')
      .option('--set <key=value>', 'Set one field. Repeatable. Dotted keys nest.', collect, [])
      .action(
        action(io, outcome, (ctx, options) =>
          createEntity(ctx, entityByCommand(entity.command), options),
        ),
      );

    group
      .command('update <id>')
      .description(`Update one ${entity.singular}. Sub-lists are replaced wholesale.`)
      .option('--data <json>', 'The body, as a JSON object.')
      .option('--file <path>', 'Read the body from a file, or from stdin with `-`.')
      .option('--set <key=value>', 'Set one field. Repeatable. Dotted keys nest.', collect, [])
      .action(
        action(io, outcome, (ctx, options, args) =>
          updateEntity(ctx, entityByCommand(entity.command), args[0] as string, options),
        ),
      );

    group
      .command('delete <id>')
      .description(`Delete one ${entity.singular}. Requires --yes.`)
      .option('--yes', 'Confirm the deletion.')
      .action(
        action(io, outcome, (ctx, options, args) =>
          deleteEntity(ctx, entityByCommand(entity.command), args[0] as string, options),
        ),
      );

    // The one collection with a sub-resource of its own. It is registered here rather than in
    // the generic loop because `blocks` is not CRUD: a block is created by an action
    // (`POST /v1/resources/{id}/block`) and removed by another, and this is the read that makes
    // the second one possible at all.
    if (entity.command === 'resources') {
      group
        .command('blocks <id>')
        .description('List the periods this resource is closed for.')
        .addHelpText(
          'after',
          [
            '',
            'Returns: the resource_block objects, oldest start first, one cursor page at a time.',
            'Without --from/--to it lists the blocks that have not finished yet, which are the',
            'ones you can still lift. Instants are UTC: a block carries no time zone of its own.',
            'Next: POST /v1/resources/<id>/unblock with the blk_... you find here.',
          ].join('\n'),
        )
        .option('--from <instant>', 'Only blocks that end at or after this instant.')
        .option('--to <instant>', 'Only blocks that start before this instant.')
        .option('--limit <n>', 'Page size, 1 to 100. Default 20.')
        .option('--starting-after <id>', 'Cursor: the blk_... of the last item of the page before.')
        .option('--all', 'Follow the cursor to the end and return everything.')
        .action(
          action(io, outcome, (ctx, options, args) =>
            resourceBlocks(ctx, args[0] as string, options),
          ),
        );
    }
  }

  // --- operations ---------------------------------------------------------------

  const availabilityCommand = program
    .command('availability')
    .description('Ask what is bookable, and why an instant is not.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: --service, --from and --to, each an ISO 8601 instant with an explicit offset.',
        'Returns: the slots (or ranges), with capacity, price and the concrete resource options.',
        '--explain adds one row per rejected instant and reason. It is capped at 7 days.',
        'A window may not span more than 90 days. ' + ENV_NOTE,
        'Next: `bookrail holds create` on a start you got here, or `bookrail bookings create`.',
        'Sub-commands: next (the first bookable instant), check (one precise instant).',
      ].join('\n'),
    )
    .option('--service <id>', 'The service to ask about. Required.')
    .option('--from <instant>', 'Start of the window, e.g. 2026-09-08T00:00:00+02:00. Required.')
    .option('--to <instant>', 'End of the window, exclusive. Required.')
    .option(
      '--tz <timezone>',
      'Time zone of the answer. Presentation only: it never moves the grid.',
    )
    .option('--quantity <n>', 'Units per booking. Default: the service capacity_per_booking.')
    .option('--resource <id>', 'Restrict the candidate resources. Repeatable.', collect, [])
    .option('--customer <id>', 'Apply this customer’s limits.')
    .option('--granularity <kind>', 'slots (default) or ranges, for free-duration services.')
    .option('--explain', 'Say why every rejected instant was rejected. Max 7 days.')
    .action(action(io, outcome, (ctx, options) => availability(ctx, options)));

  availabilityCommand
    .command('next')
    .description('The first bookable instant, searched up to 90 days ahead.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: --service. --from defaults to now.',
        'Returns: next_available (null when there is none), the slot, and searched_through.',
      ].join('\n'),
    )
    .option('--service <id>', 'The service to search. Required.')
    .option('--from <instant>', 'Where to start looking. Default: now.')
    .option('--quantity <n>', 'Units per booking.')
    .option('--tz <timezone>', 'Time zone of the answer.')
    .action(action(io, outcome, (ctx, options) => availabilityNext(ctx, options)));

  availabilityCommand
    .command('check')
    .description('Is this precise instant bookable, and if not, why.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: --service and --start.',
        'Returns: available, capacity, price, resource options, and structured reasons when not.',
        'It checks feasibility at that instant, not alignment to the slot grid.',
      ].join('\n'),
    )
    .option('--service <id>', 'The service. Required.')
    .option('--start <instant>', 'The instant to check. Required.')
    .option('--duration <minutes>', 'One of the durations the service offers.')
    .option('--quantity <n>', 'Units per booking.')
    .option('--resource <id>', 'Restrict the candidate resources. Repeatable.', collect, [])
    .action(action(io, outcome, (ctx, options) => availabilityCheck(ctx, options)));

  const holds = program
    .command('holds')
    .description('Take capacity for a few minutes, or give it back.')
    .addHelpText(
      'after',
      [
        '',
        'Sub-commands: create, get <id>, release <id>.',
        'A hold expires by itself (policy.hold_duration_seconds, 10 minutes by default, 30 max).',
        ENV_NOTE,
      ].join('\n'),
    );

  holds
    .command('create')
    .description('Hold capacity on one slot.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: --service and --start. Everything else has a default.',
        'Returns: the hold, its allocations and expires_at.',
        'Carries an Idempotency-Key, so a retried invocation never takes the capacity twice.',
        'Next: `bookrail bookings create ... --hold hold_...`, or `bookrail holds release`.',
      ].join('\n'),
    )
    .option('--service <id>', 'The service. Required.')
    .option('--start <instant>', 'The instant to hold. Required.')
    .option('--duration <minutes>', 'One of the durations the service offers.')
    .option('--quantity <n>', 'Units to take.')
    .option('--resource <id>', 'Force a resource. Repeatable.', collect, [])
    .option('--customer <id>', 'An existing customer.')
    .option('--customer-email <email>', 'Create or find a customer by email.')
    .option('--customer-name <name>', 'Name of the inline customer.')
    .option('--customer-phone <phone>', 'Phone of the inline customer.')
    .option('--customer-external-id <id>', 'Your own identifier for the customer.')
    .option('--ttl <duration>', 'How long to hold it: 10m, 600s, 1h. Capped at 30 minutes.')
    .option('--metadata <json>', 'Metadata object.')
    .option('--data <json>', 'Extra body fields, merged over the flags.')
    .option('--file <path>', 'Extra body fields from a file, or `-` for stdin.')
    .option('--set <key=value>', 'Set one body field. Repeatable.', collect, [])
    .action(action(io, outcome, (ctx, options) => holdCreate(ctx, options)));

  holds
    .command('get <id>')
    .description('Read one hold: is it still alive, until when, and what it became.')
    .addHelpText(
      'after',
      [
        '',
        'Returns: the hold, with status (active | released | expired | converted), expires_at,',
        'the resources it holds and booking_id when it was converted.',
        'price is null on a read: a hold has no stored price, only a booking freezes one.',
      ].join('\n'),
    )
    .action(action(io, outcome, (ctx, _options, args) => holdGet(ctx, args[0] as string)));

  holds
    .command('release <id>')
    .description('Give the capacity back before the hold expires.')
    .addHelpText(
      'after',
      [
        '',
        'Returns: { id, deleted: true }. Idempotent: releasing twice is a success, and needs no',
        '--yes. A hold already converted into a booking answers 409 hold_not_active.',
      ].join('\n'),
    )
    .action(action(io, outcome, (ctx, _options, args) => holdRelease(ctx, args[0] as string)));

  const bookings = program
    .command('bookings')
    .description('Create, read and move bookings through their life cycle.')
    .addHelpText(
      'after',
      [
        '',
        'Sub-commands: create, get <id>, list, confirm <id>, cancel <id>, reschedule <id>,',
        'check-in <id>, no-show <id>, complete <id>.',
        'There is no `update`: a booking changes by an action, never by a field edit.',
        'Expandable on get and list: customer, allocations.resource. ' + ENV_NOTE,
      ].join('\n'),
    );

  bookings
    .command('create')
    .description('Book one slot, or convert a hold.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: --service and --start; --hold converts an existing hold instead of taking',
        'new capacity, and the service, instant, duration and quantity must match it.',
        'Returns: the booking, confirmed (or pending when the policy requires a confirmation).',
        'With --payment deposit|full the booking is pending, a Stripe PaymentIntent is created',
        'on your connected account, and the answer carries the client_secret **once**.',
        'Carries an Idempotency-Key: a retry replays the answer instead of booking twice.',
      ].join('\n'),
    )
    .option('--service <id>', 'The service. Required.')
    .option('--start <instant>', 'The instant to book. Required.')
    .option('--duration <minutes>', 'One of the durations the service offers.')
    .option('--quantity <n>', 'Units to book.')
    .option('--resource <id>', 'Force a resource. Repeatable.', collect, [])
    .option('--hold <id>', 'Convert this hold.')
    .option(
      '--payment <mode>',
      'none (default), deposit or full. Takes the money on your connected Stripe account.',
    )
    .option('--customer <id>', 'An existing customer.')
    .option('--customer-email <email>', 'Create or find a customer by email.')
    .option('--customer-name <name>', 'Name of the inline customer.')
    .option('--customer-phone <phone>', 'Phone of the inline customer.')
    .option('--customer-external-id <id>', 'Your own identifier for the customer.')
    .option('--notes <text>', 'Free text stored on the booking.')
    .option('--source <source>', 'api | widget | portal | import. Default: api.')
    .option('--metadata <json>', 'Metadata object.')
    .option('--data <json>', 'Extra body fields, merged over the flags.')
    .option('--file <path>', 'Extra body fields from a file, or `-` for stdin.')
    .option('--set <key=value>', 'Set one body field. Repeatable.', collect, [])
    .action(action(io, outcome, (ctx, options) => bookingCreate(ctx, options)));

  bookings
    .command('get <id>')
    .description('Read one booking, with its allocations.')
    .addHelpText(
      'after',
      '\nNeeds: a bk_... id. Returns: the booking, its allocations, and what it may do next.',
    )
    .option('--expand <field>', 'customer or allocations.resource. Repeatable.', collect, [])
    .action(
      action(io, outcome, (ctx, options, args) => bookingGet(ctx, args[0] as string, options)),
    );

  bookings
    .command('list')
    .description('List bookings, filtered and paginated.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: nothing; every filter is optional and they are ANDed.',
        'Returns: a cursor page of bookings, plus next_cursor when another page exists.',
        '--from is inclusive and --to exclusive, both on the start instant.',
      ].join('\n'),
    )
    .option('--customer <id>', 'Only this customer.')
    .option('--service <id>', 'Only this service.')
    .option('--resource <id>', 'Only bookings that allocate this resource.')
    .option(
      '--status <status>',
      'held|pending|confirmed|in_progress|completed|cancelled|no_show|rescheduled.',
    )
    .option('--from <instant>', 'Starting at or after this instant.')
    .option('--to <instant>', 'Starting before this instant.')
    .option('--limit <n>', 'Page size, 1 to 100. Default 20.')
    .option('--starting-after <id>', 'Cursor: the id of the last item of the previous page.')
    .option('--all', 'Follow the cursor to the end.')
    .option('--expand <field>', 'customer or allocations.resource. Repeatable.', collect, [])
    .action(action(io, outcome, (ctx, options) => bookingList(ctx, options)));

  for (const transition of TRANSITIONS) {
    for (const name of [transition.command, ...transition.aliases]) {
      bookings
        .command(`${name} <id>`, { hidden: name !== transition.command })
        .description(`Move the booking to its ${transition.action} state.`)
        .addHelpText(
          'after',
          '\nReturns: the booking. An action the current state forbids is 409 invalid_transition, exit 4.',
        )
        .action(
          action(io, outcome, (ctx, _options, args) =>
            bookingAction(ctx, transition.action, args[0] as string),
          ),
        );
    }
  }

  bookings
    .command('cancel <id>')
    .description('Cancel a booking and compute the refund its policy promises.')
    .addHelpText(
      'after',
      [
        '',
        'Asks for confirmation on a terminal; anywhere else it needs --yes.',
        'Returns: the booking, with refund_percent and refund_amount_expected. When the booking',
        'was paid, a refund payment is queued in the same transaction and sent to Stripe within',
        'ten seconds; amount_refunded moves only once Stripe confirms it.',
      ].join('\n'),
    )
    .option('--reason <text>', 'Recorded on the booking.')
    .option('--by <who>', 'customer (default), provider or system. provider refunds 100%.')
    .option('--refund-percent <n>', 'Override every tier of the policy, 0 to 100.')
    .option('--yes', 'Skip the confirmation.')
    .action(
      action(io, outcome, (ctx, options, args) => bookingCancel(ctx, args[0] as string, options)),
    );

  bookings
    .command('reschedule <id>')
    .description('Move a booking to another instant, atomically.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: --start. The service, duration, quantity and customer stay as they are.',
        'Returns: the NEW booking; the old one is at rescheduled_from_booking_id.',
        'If the new slot is taken, nothing changes and the answer is 409 slot_unavailable.',
      ].join('\n'),
    )
    .option('--start <instant>', 'The new instant. Required.')
    .option('--resource <id>', 'Force a resource for the new booking. Repeatable.', collect, [])
    .action(
      action(io, outcome, (ctx, options, args) =>
        bookingReschedule(ctx, args[0] as string, options),
      ),
    );

  const payments = program
    .command('payments')
    .description('Read the money of a booking: the deposit or the full price, and the refunds.')
    .addHelpText(
      'after',
      [
        '',
        'Sub-commands: get <id>, list.',
        'There is nothing to create here: a payment is made by `bookrail bookings create',
        '--payment`, and a refund by `bookrail bookings cancel`, which follows your policy.',
        ENV_NOTE,
      ].join('\n'),
    );

  payments
    .command('get <id>')
    .description('Read one payment, with its client secret when it is still open.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: a pay_... id. Returns: the payment, plus client_secret and provider_status read',
        'from Stripe when the payment is still pending. Bookrail stores no client secret, so',
        'this is the only way to get one back after the booking was created.',
      ].join('\n'),
    )
    .action(action(io, outcome, (ctx, _options, args) => paymentGet(ctx, args[0] as string)));

  payments
    .command('list')
    .description('List payments, filtered and paginated.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: nothing; every filter is optional and they are ANDed.',
        'Never calls Stripe, so client_secret is always empty here.',
      ].join('\n'),
    )
    .option('--booking <id>', 'Only the payments of this booking.')
    .option('--status <status>', 'pending|succeeded|failed|refunded|cancelled.')
    .option('--type <type>', 'deposit|full|balance|no_show_fee|refund.')
    .option('--limit <n>', 'Page size, 1 to 100. Default 20.')
    .option('--starting-after <id>', 'Cursor: the id of the last item of the previous page.')
    .option('--all', 'Follow the cursor to the end.')
    .action(action(io, outcome, (ctx, options) => paymentList(ctx, options)));

  // --- the Stripe connection ----------------------------------------------------------------

  const stripe = program
    .command('stripe')
    .description('Connect the project to your own Stripe account, and see or end the link.')
    .addHelpText(
      'after',
      [
        '',
        'Sub-commands: connect, status, disconnect.',
        'Your Stripe account stays yours: charges are made on it directly and Bookrail never',
        'sees or stores a Stripe key of yours. There is nothing to paste here. ' + ENV_NOTE,
      ].join('\n'),
    );

  stripe
    .command('connect')
    .description('Open the Stripe authorisation page and wait for it to be completed.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: a key, and a browser signed in to the Stripe account you want to connect.',
        'Returns: the stripe_connection once it exists. The link works for fifteen minutes.',
        'Use --no-open on a machine with no desktop, and --no-wait in a script.',
      ].join('\n'),
    )
    .option('--no-open', 'Print the link instead of opening a browser.')
    .option('--no-wait', 'Return as soon as the link exists, without waiting for it to be used.')
    .action(action(io, outcome, (ctx, options) => stripeConnect(ctx, options)));

  stripe
    .command('status')
    .description('Which Stripe account this project charges on, and whether it can charge.')
    .addHelpText(
      'after',
      [
        '',
        'Returns: status (connected | not_connected | disconnected), the acct_ id, the platform',
        'publishable key for Stripe.js, and charges_enabled. charges_enabled is null when the',
        'account is not connected and when Stripe did not answer in time: null is not false.',
      ].join('\n'),
    )
    .action(action(io, outcome, (ctx) => stripeStatus(ctx)));

  stripe
    .command('disconnect')
    .description("Revoke Bookrail's access to the connected account. Requires --yes.")
    .option('--yes', 'Confirm the disconnection.')
    .action(action(io, outcome, (ctx, options) => stripeDisconnect(ctx, options)));

  const webhooks = program
    .command('webhooks')
    .description('Register endpoints, inspect deliveries, and watch events arrive.')
    .addHelpText(
      'after',
      [
        '',
        'Sub-commands: list, get <id>, create, update <id>, delete <id>, test <id>,',
        'deliveries <id>, retry <id> <delivery-id>, listen.',
        'The signing secret is shown once, by create, and by nothing else ever. ' + ENV_NOTE,
      ].join('\n'),
    );

  webhooks
    .command('list')
    .description('List the endpoints of this project and environment.')
    .addHelpText(
      'after',
      '\nNeeds: a key. Returns: the endpoints, without their secrets, which no read ever shows.',
    )
    .option('--limit <n>', 'Page size, 1 to 100. Default 20.')
    .option('--starting-after <id>', 'Cursor.')
    .option('--all', 'Follow the cursor to the end.')
    .action(action(io, outcome, (ctx, options) => webhookList(ctx, options)));

  webhooks
    .command('get <id>')
    .description('Read one endpoint. The secret is never in the answer.')
    .action(action(io, outcome, (ctx, _options, args) => webhookGet(ctx, args[0] as string)));

  webhooks
    .command('create')
    .description('Register an endpoint and print its signing secret, once.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: --url. https everywhere; http is accepted on test only, ports 80, 443, 8080-8099.',
        'Returns: the endpoint AND the secret. The secret is never returned again, by any',
        'endpoint, not even by an idempotency replay. Store it before the command scrolls away.',
      ].join('\n'),
    )
    .option('--url <url>', 'Where deliveries go. Required.')
    .option('--events <types>', 'Comma separated types, or *. Default *. Repeatable.', collect, [])
    .option('--description <text>', 'Free text.')
    .option('--metadata <json>', 'Metadata object.')
    .action(action(io, outcome, (ctx, options) => webhookCreate(ctx, options)));

  webhooks
    .command('update <id>')
    .description('Change the URL, the subscriptions, or the status of an endpoint.')
    .addHelpText(
      'after',
      [
        '',
        '--status accepts active and disabled only: `failing` is an observation of the delivery',
        'worker, not a state a customer declares. Re-enabling does not redeliver what was missed.',
      ].join('\n'),
    )
    .option('--url <url>', 'New URL.')
    .option('--events <types>', 'Comma separated types, or *. Repeatable.', collect, [])
    .option('--status <status>', 'active or disabled.')
    .option('--description <text>', 'Free text.')
    .option('--metadata <json>', 'Metadata object.')
    .action(
      action(io, outcome, (ctx, options, args) => webhookUpdate(ctx, args[0] as string, options)),
    );

  webhooks
    .command('delete <id>')
    .description('Delete an endpoint and its whole delivery log. Requires --yes.')
    .option('--yes', 'Confirm the deletion.')
    .action(
      action(io, outcome, (ctx, options, args) => webhookDelete(ctx, args[0] as string, options)),
    );

  webhooks
    .command('test <id>')
    .description('Send a synthetic webhook.test delivery, now, and report what came back.')
    .addHelpText(
      'after',
      [
        '',
        'Returns: the webhook_delivery, with the HTTP status, the body and the duration.',
        'Branch on data.status (succeeded | failed): a failed test is an answer, not a CLI error,',
        'so the exit code stays 0. Never retried, and refused on a disabled endpoint.',
      ].join('\n'),
    )
    .action(action(io, outcome, (ctx, _options, args) => webhookTest(ctx, args[0] as string)));

  webhooks
    .command('deliveries <id>')
    .description('The delivery log of one endpoint, newest first.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: a wh_... id. Returns: one row per delivery with the outcome of its LAST attempt,',
        'the attempt counter, and next_attempt_at: the rung of the ladder the worker enforces.',
      ].join('\n'),
    )
    .option('--status <status>', 'pending, succeeded or failed.')
    .option('--event <id>', 'Only the deliveries of this event.')
    .option('--limit <n>', 'Page size, 1 to 100. Default 20.')
    .option('--starting-after <id>', 'Cursor.')
    .option('--all', 'Follow the cursor to the end.')
    .action(
      action(io, outcome, (ctx, options, args) =>
        webhookDeliveries(ctx, args[0] as string, options),
      ),
    );

  webhooks
    .command('retry <id> <delivery-id>')
    .description('Queue a delivery again, with a fresh retry ladder.')
    .addHelpText(
      'after',
      '\nThe attempt counter goes back to zero. Deliveries older than 30 days are refused.',
    )
    .action(
      action(io, outcome, (ctx, _options, args) =>
        webhookRetry(ctx, args[0] as string, args[1] as string),
      ),
    );

  webhooks
    .command('listen')
    .description('Receive deliveries on a local port, or follow the event log.')
    .addHelpText(
      'after',
      [
        '',
        'With --url: registers a TEMPORARY endpoint pointing at that public URL, listens on',
        '--port, verifies every Bookrail-Signature, and deletes the endpoint on the way out.',
        'Use ngrok or cloudflared to get the public URL; the CLI cannot open a tunnel itself.',
        'Without --url: polls GET /v1/events and prints the events, which are byte for byte',
        'the payload a delivery would have carried. Nothing is registered, nothing is signed.',
        'Bound it with --max or --duration; --json requires one of the two.',
      ].join('\n'),
    )
    .option('--url <url>', 'Public URL that reaches this machine. Without it, poll mode.')
    .option('--port <n>', 'Local port to listen on. Default 4100; 0 picks a free one.')
    .option('--forward <url>', 'Relay every delivery to this local URL.')
    .option(
      '--events <types>',
      'Types to subscribe to (or, in poll mode, to filter on).',
      collect,
      [],
    )
    .option('--keep', 'Do not delete the temporary endpoint when the command exits.')
    .option('--interval <seconds>', 'Poll mode only: seconds between polls. Default 2.')
    .option('--duration <seconds>', 'Stop after this many seconds.')
    .option('--max <n>', 'Stop after this many deliveries or events.')
    .action(action(io, outcome, (ctx, options) => webhooksListen(ctx, options)));

  const events = program
    .command('events')
    .description('Read the event log, and follow it.')
    .addHelpText(
      'after',
      [
        '',
        'Sub-commands: list, get <id>.',
        'The log is read-only and ordered by (txid, seq); the public cursor is an event id.',
        'A row becomes visible only once the transaction that wrote it has finished, which is',
        'what makes the cursor safe: nothing ever appears below a position already passed.',
        ENV_NOTE,
      ].join('\n'),
    );

  events
    .command('list')
    .description('List events, oldest first, and optionally keep following.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: nothing. Every filter is optional and they are ANDed.',
        'Returns: the events, oldest first, plus next_cursor when another page exists.',
        '--follow polls every --interval seconds (default 2) from the cursor, or from now when',
        'no --starting-after and no --from is given. With --json it needs --max or --duration.',
        'Without --json it streams one line per event until Ctrl-C.',
      ].join('\n'),
    )
    .option('--type <types>', 'Exact event type. Comma separated or repeatable.', collect, [])
    .option('--object-id <id>', 'Only events about this object, e.g. bk_... or hold_....')
    .option('--from <instant>', 'Occurred at or after this instant.')
    .option('--to <instant>', 'Occurred before this instant.')
    .option('--limit <n>', 'Page size, 1 to 100. Default 20.')
    .option('--starting-after <id>', 'Cursor: an event id.')
    .option('--all', 'Follow the cursor to the end.')
    .option('--follow', 'Keep polling for new events.')
    .option('--interval <seconds>', 'Seconds between polls. Default 2.')
    .option('--duration <seconds>', 'Stop following after this many seconds.')
    .option('--max <n>', 'Stop following after this many events.')
    .action(action(io, outcome, (ctx, options) => eventList(ctx, options)));

  events
    .command('get <id>')
    .description('Read one event by id.')
    .addHelpText(
      'after',
      '\nNeeds: an evt_... id. Returns: the event, which is byte for byte a delivery payload.',
    )
    .action(action(io, outcome, (ctx, _options, args) => eventGet(ctx, args[0] as string)));

  // --- diagnosis and documentation ----------------------------------------------------------

  program
    .command('doctor')
    .description('Check credentials, permissions, environment, reachability, version and config.')
    .addHelpText(
      'after',
      [
        '',
        'Needs: nothing. Every problem is a check, never an exception.',
        'Returns: one { name, status, message, fix } per check, and a summary.',
        'Exits 1 when at least one check failed, 0 otherwise.',
      ].join('\n'),
    )
    .option('--config <path>', 'Configuration file to validate.')
    .action(action(io, outcome, (ctx, options) => doctor(ctx, options)));

  program
    .command('schema [entity]')
    .description('Print the JSON Schema of the configuration, or of one of its collections.')
    .addHelpText('after', `\nNames: ${SCHEMA_NAMES.join(', ')}. Without one, the list is printed.`)
    .action(action(io, outcome, (ctx, _options, args) => schema(ctx, args[0])));

  program
    .command('examples [vertical]')
    .description('Print a complete, working model of a vertical and the calls that follow it.')
    .addHelpText('after', `\nVerticals: ${TEMPLATE_NAMES.join(', ')}.`)
    .option('--framework <name>', 'Show the calls in TypeScript instead of curl.')
    .action(action(io, outcome, (ctx, options, args) => examples(ctx, args[0], options)));

  program
    .command('docs [topic]')
    .description('Print a page of the documentation bundled with this CLI, offline.')
    .option('--markdown', 'Print raw markdown. This is also the default.')
    .action(action(io, outcome, (ctx, options, args) => docs(ctx, args[0], options)));

  // --- MCP -----------------------------------------------------------------------------------

  const mcp = program
    .command('mcp')
    .description('Configure the Bookrail MCP server in a coding agent.')
    .addHelpText(
      'after',
      [
        '',
        'The server itself is `npx @bookrail/mcp`; this command only writes the entry that',
        'starts it into the client you name. It never writes a key: the server reads the same',
        'credentials `bookrail login` stores.',
      ].join('\n'),
    );

  mcp
    .command('install')
    .description('Write or update the bookrail entry in an MCP client configuration.')
    .addHelpText(
      'after',
      [
        '',
        `Clients: ${MCP_CLIENT_NAMES.join(', ')}. Without --client, lists them with their files.`,
        'Needs: nothing. It never contacts the API and never prompts.',
        'Returns: the file, what it would do to it, and which other servers it preserved.',
        'Next: restart the client, then `bookrail login` if no key is stored yet.',
      ].join('\n'),
    )
    .option('--client <name>', `One of: ${MCP_CLIENT_NAMES.join(', ')}.`)
    .option('--dry-run', 'Print the file that would be written, and write nothing.')
    .action(action(io, outcome, (ctx, options) => mcpInstall(ctx, options)));

  // --- not in this build ---------------------------------------------------------------------

  // Commands that are planned but not in this build. They are declared so that an agent gets a
  // reason and a date rather than "unknown command", which is indistinguishable from a typo.
  const laterCommands: [string, string, string][] = [
    [
      'logs',
      'Request log, with --follow.',
      'a later release: the API stores no request log to read',
    ],
    ['requests', 'get REQUEST_ID.', 'a later release: the API stores no request log to read'],
    ['keys', 'list | create | revoke.', 'a later release: the API has no key management endpoint'],
    [
      'projects',
      'list | create | use.',
      'a later release: `bookrail whoami` shows the one the key belongs to',
    ],
    ['dev', 'Run the engine locally with a mini dashboard.', 'a later release'],
    ['migrate', 'Import from csv, json, Calendly, Acuity.', 'a later release'],
    ['upgrade', 'Update the CLI in place.', 'a later release'],
  ];
  for (const [name, summary, when] of laterCommands) {
    program
      .command(name, { hidden: false })
      .description(`(not in this build) ${summary}`)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(
        action(io, outcome, () => {
          throw notYetAvailable(name, when);
        }),
      );
  }

  // Every command carries the global flags itself.
  //
  // `commander` does not pass a parent's options down to a subcommand's parser, so without
  // this `bookrail init --template padel --json` would be "unknown option '--json'", which
  // is exactly the order a human and an agent both type. Declaring them on each command
  // instead of asking callers to write `bookrail --json init` keeps structured output reachable
  // everywhere rather than only in the position the parser happens to like.
  for (const command of descendants(program)) {
    addGlobalOptions(command);
    if (command.commands.length > 0) command.enablePositionalOptions();
  }

  return program;
}

const GLOBAL_OPTIONS: [string, string][] = [
  ['--json', 'Print the structured envelope instead of a human table.'],
  ['--live', 'Operate on the live environment. Without it everything is test.'],
  ['--non-interactive', 'Never prompt; fail with a fix instead.'],
  ['--api-url <url>', 'Base URL of the API.'],
  ['--timeout <seconds>', 'Per-request timeout in seconds.'],
];

function addGlobalOptions(command: Command): void {
  for (const [flags, description] of GLOBAL_OPTIONS) {
    const long = flags.split(' ')[0];
    if (command.options.some((option) => option.long === long)) continue;
    command.option(flags, description);
  }
}

function descendants(command: Command): Command[] {
  const out: Command[] = [];
  for (const child of command.commands) out.push(child, ...descendants(child));
  return out;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export { CommanderError };
