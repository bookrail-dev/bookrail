/* eslint-disable no-console */
/**
 * The four database commands of the workspace: `pnpm db:migrate`, `pnpm db:reset`,
 * `pnpm db:status`, `pnpm db:adopt`.
 *
 * Three of them read or write exactly what their name says. `status` **only reads**: it no
 * longer creates the ledger and no longer renames one left under a former name of the
 * product, which is what it used to do through `ensureMigrationsTable` and what made two
 * commands that present themselves as read-only write to the catalogue. It reports the state
 * of the ledger instead.
 *
 * `adopt` is where the rename went. It is explicit, it takes `--dry-run`, it is idempotent,
 * and it is called by nothing: not by a release, not by the gate, not by `db:migrate`. A
 * database whose ledger is still under a former name is refused by `db:migrate` with a message
 * that names this command, because starting a fresh empty ledger there would replay 0001
 * against a database that already has a schema.
 */
import { resolveDatabaseUrls, redactUrl } from './config.js';
import { adoptLedger, migrate, migrationReport, resetSchema } from './migrate.js';

/** One line describing the ledger, for `status` and for `adopt --dry-run`. */
function describeLedger(ledger: Awaited<ReturnType<typeof migrationReport>>['ledger']): string {
  switch (ledger.kind) {
    case 'current':
      return `ledger: public.${ledger.table}`;
    case 'legacy':
      return `ledger: public.${ledger.table}, left under a former name of the product. Nothing here renames it: run \`pnpm db:adopt\`.`;
    case 'foreign':
      return `ledger: public.${ledger.table} matches a ledger by name but not by columns. Left alone.`;
    case 'missing':
      return 'ledger: none. This database has never been migrated.';
    case 'ambiguous':
      return `ledger: several candidates (${ledger.tables.join(', ')}) and none is the current name. Rename the right one by hand.`;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'migrate';
  const dryRun = process.argv.includes('--dry-run');
  const urls = resolveDatabaseUrls();

  switch (command) {
    case 'migrate': {
      console.log(`bookrail db: migrating ${redactUrl(urls.admin)} (app role: ${urls.appRole})`);
      const result = await migrate({
        adminUrl: urls.admin,
        appRole: urls.appRole,
        jobsRole: urls.jobsRole,
        onApplied: (name) => console.log(`  applied ${name}`),
      });
      console.log(
        `bookrail db: ${result.applied.length} applied, ${result.alreadyApplied.length} already up to date`,
      );
      break;
    }
    case 'reset': {
      console.log(`bookrail db: resetting ${redactUrl(urls.admin)}`);
      const result = await resetSchema({
        adminUrl: urls.admin,
        appRole: urls.appRole,
        jobsRole: urls.jobsRole,
        onApplied: (name) => console.log(`  applied ${name}`),
      });
      console.log(`bookrail db: schema recreated, ${result.applied.length} migrations applied`);
      break;
    }
    case 'status': {
      const report = await migrationReport({
        adminUrl: urls.admin,
        appRole: urls.appRole,
        jobsRole: urls.jobsRole,
      });
      console.log(`  ${describeLedger(report.ledger)}`);
      for (const row of report.statuses) {
        const state = row.drifted ? 'DRIFTED' : row.applied ? 'applied' : 'pending';
        console.log(`  ${state.padEnd(8)} ${row.name}`);
      }
      break;
    }
    case 'adopt': {
      const result = await adoptLedger({ adminUrl: urls.admin, dryRun });
      const prefix = result.dryRun ? 'would ' : '';
      switch (result.action) {
        case 'renamed':
          console.log(`bookrail db: ${prefix}rename public.${result.from} to ${result.to}`);
          break;
        case 'already-current':
          console.log(`bookrail db: nothing to do, the ledger is already ${result.to}`);
          break;
        case 'no-ledger':
          console.log('bookrail db: nothing to do, this database has no migration ledger');
          break;
      }
      break;
    }
    default:
      console.error(`Unknown command: ${command}. Use migrate | reset | status | adopt.`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // The message, not the stack. These are messages a person reads in the middle of a release
  // (the refusal to migrate a database whose ledger is still under a former name is the one
  // that matters), and four lines of stack in front of them is noise.
  // BOOKRAIL_DB_DEBUG=1 brings the stack back for a bug.
  if (process.env.BOOKRAIL_DB_DEBUG === '1') {
    console.error(error instanceof Error ? error.stack : error);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
