/**
 * Creating an account, a project and one secret key per environment.
 *
 * It is the one operation of this system that cannot go through the application role: nothing
 * exists yet to scope it to, and `accounts`, `projects` and `api_keys` are not writable by a
 * role that is subject to Row Level Security. It therefore runs on the connection that bypasses
 * RLS, which is the reason this file exists at all.
 *
 * That connection used to be held open, permanently, inside the process exposed to
 * the internet, together with the shared secret that unlocks it. The worker had already lost
 * its privileged connection while the API had kept one, so the asymmetry ran the wrong
 * way. The work is the same in both places
 * and lives here; what changed is who calls it. In production it is `bookrail-bootstrap`, a
 * command run over SSH by a human, which opens the owner connection, creates, prints and dies.
 * `POST /internal/bootstrap` still exists for development and for the test harness, where
 * BOOKRAIL_BOOTSTRAP_TOKEN is set and one process is the whole deployment.
 */
import { accounts, apiKeys, projects, type Database } from '@bookrail/db';
import { CURRENT_API_VERSION, encodeId, uuidv7 } from '@bookrail/shared';
import { firstRow } from './http.js';
import { generateApiKey } from './keys.js';

export interface BootstrapInput {
  account_name: string;
  project_name: string;
  default_timezone?: string | undefined;
  default_currency?: string | undefined;
  tenant_id?: string | null | undefined;
  scopes?: string[] | undefined;
}

export interface BootstrapResult {
  object: 'bootstrap';
  account: { id: string; object: 'account'; name: string; api_version: string };
  project: {
    id: string;
    object: 'project';
    name: string;
    default_timezone: string;
    default_currency: string;
  };
  api_keys: {
    id: string;
    object: 'api_key';
    environment: string;
    kind: string;
    prefix: string;
    scopes: string[];
    tenant_id: string | null;
  }[];
  /** Shown once and never again: only the SHA-256 hash is stored. */
  secrets: { test: string; live: string };
}

/** Runs the whole thing in one transaction on a connection that bypasses RLS. */
export async function createBootstrap(
  adminDb: Database,
  body: BootstrapInput,
): Promise<BootstrapResult> {
  const testKey = generateApiKey('test');
  const liveKey = generateApiKey('live');

  const result = await adminDb.transaction(async (tx) => {
    const account = firstRow(
      await tx
        .insert(accounts)
        .values({ id: uuidv7(), name: body.account_name, apiVersion: CURRENT_API_VERSION })
        .returning(),
    );
    const project = firstRow(
      await tx
        .insert(projects)
        .values({
          id: uuidv7(),
          accountId: account.id,
          name: body.project_name,
          defaultTimezone: body.default_timezone ?? 'UTC',
          defaultCurrency: body.default_currency ?? 'EUR',
        })
        .returning(),
    );
    const keyRows = await tx
      .insert(apiKeys)
      .values(
        [testKey, liveKey].map((key) => ({
          id: uuidv7(),
          projectId: project.id,
          environment: key.environment,
          kind: key.kind,
          name: `${key.environment} secret key`,
          prefix: key.prefix,
          keyHash: key.keyHash,
          scopes: body.scopes ?? [],
          tenantId: body.tenant_id ?? null,
        })),
      )
      .returning();
    return { account, project, keyRows };
  });

  return {
    object: 'bootstrap',
    account: {
      id: encodeId('account', result.account.id),
      object: 'account',
      name: result.account.name,
      api_version: result.account.apiVersion,
    },
    project: {
      id: encodeId('project', result.project.id),
      object: 'project',
      name: result.project.name,
      default_timezone: result.project.defaultTimezone,
      default_currency: result.project.defaultCurrency,
    },
    api_keys: result.keyRows.map((row) => ({
      id: encodeId('api_key', row.id),
      object: 'api_key',
      environment: row.environment,
      kind: row.kind,
      prefix: row.prefix,
      scopes: row.scopes,
      tenant_id: row.tenantId,
    })),
    secrets: { test: testKey.key, live: liveKey.key },
  };
}
