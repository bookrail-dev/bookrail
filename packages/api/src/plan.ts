/**
 * What the HTTP layer says about the plan: the usage object of `GET /v1/project`, the
 * `Bookrail-Plan-Usage` header, and the warning emails.
 *
 * Counting and refusing are not here. They are in `@bookrail/engine` (`plan/usage.ts`), inside
 * the transactions that write the bookings and the payments, which is the only place a count
 * can be both exact and final. This module only reads and tells.
 */
import {
  PLANS,
  encodeId,
  planMonthOf,
  type PlanId,
  type PlanTable,
  type Logger,
} from '@bookrail/shared';
import { accountUsage, type AccountUsage, type PlanUsageWarning } from '@bookrail/engine';
import type { Transaction } from '@bookrail/db';
import type { AppDeps } from './context.js';
import { planWarningMessage } from './mail/messages.js';

/**
 * `Bookrail-Plan-Usage: <confirmed>/<included>` on every authenticated response of the live
 * environment, like the `RateLimit-*` counters: the number a client needs to pace itself before
 * the free plan starts answering `402`.
 */
export const PLAN_USAGE_HEADER = 'Bookrail-Plan-Usage';

/** The plan table a deployment runs with. */
export function plansOf(deps: Pick<AppDeps, 'plans'>): PlanTable {
  return deps.plans ?? PLANS;
}

/** The `usage` object of `GET /v1/project`. */
export interface UsagePayload {
  month: string;
  bookings_confirmed: number;
  bookings_included: number | null;
  payment_volume: number;
  payment_volume_included: number | null;
  currency: string | null;
  blocks_at_limit: boolean;
}

/**
 * This month's usage of the account of the request, as `GET /v1/project` returns it.
 *
 * The numbers are always the live ones, whatever the environment of the key that asks: the
 * threshold belongs to the account, and a key of the test environment is exactly how somebody
 * exploring finds out where the account stands.
 */
export async function usagePayload(
  tx: Transaction,
  plans: PlanTable,
  accountId: string,
  plan: PlanId,
  now: number,
): Promise<UsagePayload> {
  const usage: AccountUsage = await accountUsage(tx, accountId, planMonthOf(now));
  const limits = plans[plan];
  return {
    month: usage.month,
    bookings_confirmed: usage.bookingsConfirmed,
    bookings_included: limits.bookingsIncluded,
    payment_volume: usage.paymentVolume,
    payment_volume_included: limits.paymentVolumeIncluded,
    currency: usage.currency,
    blocks_at_limit: limits.blocksAtLimit,
  };
}

/**
 * The value of the header, or `null` for a plan whose included bookings are negotiated: there
 * is no denominator to print, and a header that said `12/null` would be read as a bug.
 */
export function planUsageHeader(confirmed: number, included: number | null): string | null {
  return included === null ? null : `${String(confirmed)}/${String(included)}`;
}

/**
 * Sends the email of each warning an engine call has just claimed, after its commit.
 *
 * Not awaited by the routes: an SMTP server that takes ten seconds to answer must not keep a
 * booking response waiting, and a failure is a `warn` line, never an error of the request. The
 * `plan.usage_warning` event was written in the same transaction as the booking and stays
 * whatever happens here, so a warning that was not mailed is still a warning that exists.
 *
 * Nothing is sent for an account without an owner address (one created by hand), nor by a
 * deployment without a mailer.
 */
export function sendPlanWarnings(
  deps: Pick<AppDeps, 'mailer' | 'logger'>,
  warnings: readonly PlanUsageWarning[],
): void {
  for (const warning of warnings) {
    void sendOne(deps.mailer, deps.logger, warning);
  }
}

async function sendOne(
  mailer: AppDeps['mailer'],
  logger: Logger,
  warning: PlanUsageWarning,
): Promise<void> {
  const fields = {
    account_id: encodeId('account', warning.accountId),
    project_id: encodeId('project', warning.projectId),
    month: warning.month,
    threshold: warning.threshold,
  };
  if (warning.ownerEmail === null || mailer === undefined) {
    logger.info('plan_usage_warning_not_mailed', {
      ...fields,
      reason: warning.ownerEmail === null ? 'no_owner_email' : 'no_mailer',
    });
    return;
  }
  try {
    await mailer.send(planWarningMessage({ to: warning.ownerEmail, warning }));
    logger.info('plan_usage_warning_mailed', fields);
  } catch (error) {
    logger.warn('plan_usage_warning_mail_failed', {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
