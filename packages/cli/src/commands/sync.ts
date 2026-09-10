import { stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { loadConfig } from '../config/load.js';
import { KIND_LABEL } from '../config/normalize.js';
import type { Context } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { renderTable, type CommandResult } from '../output.js';
import { renderConfigFile } from '../render.js';
import { applyPlan, planRows, summarizePlan } from '../sync/apply.js';
import {
  adoptionsFromPull,
  applyAdoptions,
  parseAdoption,
  validateAdoptions,
  withAdoptions,
  type AdoptionOutcome,
} from '../sync/adopt.js';
import { buildPlan, fetchRemoteState, planHasDeletions, planIsEmpty } from '../sync/plan.js';
import { pullConfig } from '../sync/pull.js';
import { clientFor } from './helpers.js';

export interface SyncOptions {
  config?: string;
  dryRun?: boolean;
  yes?: boolean;
  adopt?: string[];
}

function planHuman(ctx: Context, plan: ReturnType<typeof buildPlan>, title: string): string {
  const rows = planRows(plan);
  const lines = [`${ctx.presenter.badge()} ${title}: ${summarizePlan(plan)}`];
  if (rows.length > 0) {
    lines.push('', renderTable(['action', 'kind', 'id', 'name', 'changes'], rows));
  }
  if (plan.unmanaged.length > 0) {
    lines.push(
      '',
      `${plan.unmanaged.length} object(s) in this project carry no metadata.config_id and are left untouched:`,
      ...plan.unmanaged
        .slice(0, 10)
        .map((object) => `  ${KIND_LABEL[object.kind]} ${object.id} ${object.name}`),
    );
    if (plan.unmanaged.length > 10) lines.push(`  ... and ${plan.unmanaged.length - 10} more`);
  }
  return lines.join('\n');
}

/**
 * Reconciles `bookrail.config.ts` with the project.
 *
 * Three guarantees, in order of how much they matter:
 *
 * 1. Nothing runs against live unless `--live` was typed, and that is enforced one level down,
 *    when the key is resolved (`context.ts`).
 * 2. A deletion needs `--yes`. A plan that contains one and has no `--yes` is refused *before*
 *    the creations are applied, so a half-push cannot leave the project in a state the config
 *    does not describe.
 * 3. The push is idempotent: it matches by `metadata.config_id`, so running it twice is the
 *    same as running it once, and running it again after a failure converges.
 */
export async function push(ctx: Context, options: SyncOptions): Promise<CommandResult> {
  const loaded = await loadConfig(ctx.io, options.config);
  const client = await clientFor(ctx);
  const fetched = await fetchRemoteState(client);

  // Adoption is validated as a whole and then *projected* into the state, not written yet: the
  // plan has to be the plan of the adopted world (an adopted object is an `update`, never a
  // `create`), while the refusal below still has to come before anything is written.
  const adoptions = (options.adopt ?? []).map(parseAdoption);
  if (adoptions.length > 0) validateAdoptions(adoptions, fetched, loaded.config);
  const remote = withAdoptions(fetched, adoptions);
  const plan = buildPlan(loaded.config, remote, ctx.environment);

  if (options.dryRun === true) {
    return {
      data: {
        config: loaded.path,
        applied: false,
        dry_run: true,
        plan: plan.items,
        counts: plan.counts,
        unmanaged: plan.unmanaged,
        would_adopt: adoptions,
      },
      human: [
        ...(adoptions.length === 0
          ? []
          : [
              `would adopt ${adoptions.length} object(s): ${adoptions.map((a) => `${a.remote_id} as ${a.kind}:${a.config_id}`).join(', ')}`,
              '',
            ]),
        planHuman(ctx, plan, 'plan (dry run, nothing applied)'),
      ].join('\n'),
      nextSteps: planIsEmpty(plan)
        ? ['Nothing to do: the project already matches the config.']
        : [
            planHasDeletions(plan)
              ? 'Run `bookrail push --yes` to apply it, including the deletions.'
              : 'Run `bookrail push` to apply it.',
          ],
    };
  }

  if (planHasDeletions(plan) && options.yes !== true) {
    const names = plan.items
      .filter((item) => item.action === 'delete')
      .map((item) => `${KIND_LABEL[item.kind]} "${item.config_id}"`)
      .join(', ');
    throw new CliError(
      'confirmation_required',
      `This push would delete ${plan.counts.delete} object(s): ${names}.`,
      {
        fix: 'Run `bookrail push --yes` to accept the deletions, or `bookrail push --dry-run` to review the whole plan first.',
        exitCode: EXIT.user,
      },
    );
  }

  // Now, and only now, is anything written: the deletions were accepted above.
  const adopted: AdoptionOutcome[] =
    adoptions.length === 0 ? [] : await applyAdoptions(client, adoptions, fetched);
  const result = await applyPlan(client, loaded.config, plan, remote);

  return {
    data: {
      config: loaded.path,
      applied: true,
      dry_run: false,
      plan: plan.items,
      counts: plan.counts,
      applied_objects: result.applied,
      exceptions: result.exceptions,
      unmanaged: plan.unmanaged,
      adopted,
    },
    human: [
      ...(adopted.length === 0
        ? []
        : [
            `adopted ${String(adopted.filter((a) => a.status === 'adopted').length)} object(s): ${adopted.map((a) => `${a.remote_id} -> ${a.config_id}`).join(', ')}`,
            '',
          ]),
      planHuman(ctx, plan, 'applied'),
    ].join('\n'),
    nextSteps: [
      'Run `bookrail diff --json` to confirm the project now matches the config.',
      'Run `bookrail services list --json` to read back the ids the API assigned.',
    ],
  };
}

export async function diff(ctx: Context, options: SyncOptions): Promise<CommandResult> {
  const loaded = await loadConfig(ctx.io, options.config);
  const client = await clientFor(ctx);
  const remote = await fetchRemoteState(client);
  const plan = buildPlan(loaded.config, remote, ctx.environment);
  const clean = planIsEmpty(plan);

  return {
    data: {
      config: loaded.path,
      has_changes: !clean,
      plan: plan.items,
      counts: plan.counts,
      unmanaged: plan.unmanaged,
    },
    human: planHuman(ctx, plan, clean ? 'no differences' : 'differences'),
    // Exit code stays 0: a difference is an answer, not a failure, and the non-zero codes are
    // reserved for things that went wrong. `has_changes` is the field to branch on.
    nextSteps: clean
      ? []
      : ['Run `bookrail push --dry-run` to see the plan, then `bookrail push`.'],
  };
}

export interface PullOptions {
  out?: string;
  stdout?: boolean;
  force?: boolean;
  adopt?: boolean;
}

/**
 * The project, written back out as a configuration file.
 *
 * **`--adopt` is the one thing here that writes.** Without it, `pull` is read-only and the
 * objects that carry no `metadata.config_id` are listed in `adopted` with the logical id this
 * command *would* give them: pushing that file would create a second copy of each, and the
 * header of the generated file says so. With it, each of those objects is stamped with exactly
 * that id before the file is written, so the file that comes out is one a `push` will
 * reconcile rather than duplicate. Nothing is ever matched by name: the id comes from the
 * object's name, but the mapping is written onto the object the CLI is looking at, in the same
 * breath, and only for objects that carry no id yet.
 */
export async function pull(ctx: Context, options: PullOptions): Promise<CommandResult> {
  const client = await clientFor(ctx);
  let remote = await fetchRemoteState(client);
  let pulled = pullConfig(remote);
  let stamped: AdoptionOutcome[] = [];

  if (options.adopt === true && pulled.adopted.length > 0) {
    const adoptions = adoptionsFromPull(remote, pulled.adopted);
    validateAdoptions(adoptions, remote, null);
    stamped = await applyAdoptions(client, adoptions, remote);
    remote = withAdoptions(remote, adoptions);
    pulled = pullConfig(remote);
  }

  const contents = renderConfigFile(pulled.config, {
    header: [
      `Pulled from the ${ctx.environment} environment of ${client.baseUrl}.`,
      ...(stamped.length > 0
        ? [
            `${String(stamped.length)} object(s) were stamped with metadata.config_id by --adopt:`,
            'every object in this file is managed, and `bookrail push` will reconcile them.',
          ]
        : [
            'Objects that were pushed from a config keep their logical id; the others got one from',
            'their name and are NOT managed yet. See `adopted` in `bookrail pull --json`, or',
            're-run with `--adopt` to stamp them.',
          ]),
    ],
  });

  if (options.stdout === true) {
    return {
      data: { written: null, adopted: pulled.adopted, stamped, config: pulled.config },
      human: contents,
    };
  }

  const target = options.out ?? 'bookrail.config.ts';
  const path = isAbsolute(target) ? target : resolvePath(ctx.io.cwd, target);
  if (options.force !== true && (await exists(path))) {
    throw new CliError('file_exists', `${path} already exists.`, {
      fix: 'Pass `--force` to overwrite it, `--out <path>` to write elsewhere, or `--stdout` to print it.',
    });
  }
  await writeFile(path, contents, 'utf8');

  return {
    data: {
      written: path,
      adopted: pulled.adopted,
      stamped,
      counts: countsOf(pulled.config),
    },
    human:
      stamped.length === 0
        ? `${ctx.presenter.badge()} wrote ${path}`
        : `${ctx.presenter.badge()} wrote ${path}, after stamping ${String(stamped.length)} object(s) with metadata.config_id`,
    nextSteps: [
      'Run `bookrail diff` to check that the file matches the project.',
      ...(pulled.adopted.length > 0
        ? [
            `${pulled.adopted.length} object(s) have no metadata.config_id: pushing this file would create copies of them. Re-run with \`bookrail pull --adopt --force\` to stamp them, or delete them from the file.`,
          ]
        : []),
    ],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function countsOf(config: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return counts;
}
