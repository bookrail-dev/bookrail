/**
 * Reading a frozen `policy_snapshot`.
 *
 * A booking keeps the policy it was made under, and no later edit of the live policy reaches
 * back to it, so every consequence a transition computes (the refund, the reschedule fee, the
 * no-show charge, the automatic clock) is read from a **jsonb copy of a row that may be years
 * old**, not from the live `policies` table. That has two consequences this module absorbs:
 *
 *  * **a key may simply not be there.** A snapshot written before migration 0011 has no
 *    `auto_start`; one written by a customer who never configured a no-show rule has no
 *    `no_show`. Every reader here treats a missing key as the inert value (`false`, `0`, "no
 *    limit"), which is exactly the behaviour those bookings had when they were created;
 *  * **a value may be malformed.** Refusing to cancel a booking because one tier of a policy
 *    from two years ago has a typo would be the wrong failure, so a malformed tier is dropped
 *    rather than thrown on. What is dropped is a tier that promises nothing.
 *
 * It lives apart from `lifecycle.ts` because the **creation** needs it too: a booking is born
 * with its automatic clock already set, and `create.ts` cannot import the lifecycle without a
 * cycle.
 */

const MINUTE_MS = 60_000;

export type BookingStatus =
  | 'held'
  | 'pending'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'rescheduled';

/**
 * The transitions the background scheduler can fire by itself, with no request behind them.
 *
 * `start` is not `check_in`: a booking that starts because `auto_start` says so has **not**
 * been checked in, and `checked_in_at` has to keep meaning "somebody turned up" or
 * `no_show.auto_mark` would never fire again on a policy that asks for both.
 *
 * `expire_payment` is the fourth, and the only one that does not come from the policy at all: it comes from `bookings.payment_expires_at`, which the creation sets when the
 * booking is waiting for a Stripe payment. A `pending` booking holds its capacity exactly like
 * a confirmed one, so a customer who closes the browser would otherwise hold the slot for ever.
 */
export type AutomaticTransition = 'start' | 'complete' | 'no_show' | 'expire_payment';

export type PolicySnapshot = Record<string, unknown> | null;

export interface PolicyTier {
  /** `before`, in milliseconds: `"48h"` is 172 800 000. */
  readonly beforeMs: number;
  readonly refundPercent: number | null;
  readonly fee: number | null;
}

/**
 * The one grammar of a duration in this API: digits and a unit, from seconds to days.
 *
 * Exported as a source string because `packages/api/src/schemas` builds its own anchored regex
 * from it: two hand-written regexes for one grammar is how `"90s"` came to be accepted by the
 * engine and refused by the schema.
 */
export const DURATION_PATTERN = '(\\d+)([smhd])';

const DURATION_RE = new RegExp(`^${DURATION_PATTERN}$`);
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * `"48h"` → 172 800 000. `null` for anything that is not a duration this API writes.
 *
 * **One grammar, in one place.** {@link DURATION_PATTERN} is the same source the Zod schema of
 * `POST /v1/policies` compiles its regex from, so a duration the API accepts is exactly a
 * duration this function understands. They had drifted (`"90s"` was accepted here and refused
 * there), and a bare number was read as **milliseconds**, so `{"before": 24}` meant 24 ms and
 * silently produced a refund of zero. Numbers are no longer
 * accepted at all: a duration in this API is a string with a unit.
 */
export function parseDurationMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = DURATION_RE.exec(value.trim());
  if (match === null) return null;
  const unit = DURATION_UNIT_MS[match[2]!];
  return unit === undefined ? null : Number(match[1]) * unit;
}

/** The tiers of one policy list, from the most distant from the start to the closest. */
export function policyTiers(
  snapshot: PolicySnapshot,
  key: 'cancellation' | 'reschedule',
): PolicyTier[] {
  const raw = snapshot?.[key];
  if (!Array.isArray(raw)) return [];
  const tiers: PolicyTier[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const beforeMs = parseDurationMs(row.before);
    if (beforeMs === null || beforeMs < 0) continue;
    // A value out of range is dropped like an unreadable `before`, and for the same reason: a
    // malformed tier must never stop a cancellation, and a `refund_percent` of 150 used to reach
    // the `numeric(5,2) CHECK (<= 100)` of migration 0011 and turn the cancellation into a 400
    // naming an internal constraint, leaving the booking uncancellable except through an override.
    tiers.push({
      beforeMs,
      refundPercent: percentOrNull(row.refund_percent),
      fee: typeof row.fee === 'number' && Number.isFinite(row.fee) && row.fee >= 0 ? row.fee : null,
    });
  }
  return tiers.sort((a, b) => b.beforeMs - a.beforeMs);
}

/**
 * The tier that applies when `remainingMs` are left before the start.
 *
 * A tier `{before: "24h"}` applies while **at least** 24 hours remain: it is still the
 * applicable tier at exactly 24h00m00s and no longer applicable at 23h59m59s. That boundary
 * is the one a customer argues about, so it is pinned here and tested at the millisecond.
 *
 * The list is ordered from the most distant, so the first match is also the most generous
 * one that is still true. `null` when the booking is closer to its start than the last tier
 * allows, when the start is already past, or when the policy has no tiers at all.
 */
export function tierFor(tiers: readonly PolicyTier[], remainingMs: number): PolicyTier | null {
  for (const tier of tiers) {
    if (remainingMs >= tier.beforeMs) return tier;
  }
  return null;
}

/** `policy_snapshot.no_show.grace_minutes`, or 0. */
export function graceMinutes(snapshot: PolicySnapshot): number {
  const value = noShowRule(snapshot)?.grace_minutes;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** `policy_snapshot.no_show.charge_percent`, or 0. Out of [0, 100] is not a rule, it is noise. */
export function noShowChargePercent(snapshot: PolicySnapshot): number {
  return percentOrNull(noShowRule(snapshot)?.charge_percent) ?? 0;
}

/** A percentage, or `null`: finite and inside [0, 100], which is what the columns allow. */
function percentOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

/** `policy_snapshot.max_reschedules`, or `null` for "no limit". */
export function maxReschedules(snapshot: PolicySnapshot): number | null {
  const value = snapshot?.max_reschedules;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function noShowRule(snapshot: PolicySnapshot): Record<string, unknown> | null {
  const value = snapshot?.no_show;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * The next transition the scheduler should fire for this booking, or `null`.
 *
 * Recomputed after **every** write to a booking (the creation included) from the status the
 * booking has just reached, so the column is never a leftover from a state it is no longer
 * in. When several are due the earliest wins; on a tie `start` precedes `no_show` precedes
 * `complete`, which is the order they happen in on a booking nobody attends.
 *
 * A booking whose instant is already past keeps it, and the scheduler picks it up on its next
 * tick: that is precisely what should happen to a booking confirmed after its own start.
 */
export function nextTransitionFor(
  booking: {
    readonly status: BookingStatus;
    readonly startsAt: number;
    readonly endsAt: number;
    readonly checkedInAt: number | null;
    /**
     * `bookings.payment_expires_at`: the deadline of a booking waiting for its payment.
     *
     * The only input of this function that does not come from the policy. A `pending` booking
     * with one has exactly one automatic transition, `expire_payment`, and none of the three
     * below can apply to it: `start`, `no_show` and `complete` all presuppose a booking that
     * is going to happen.
     */
    readonly paymentExpiresAt?: number | null;
  },
  snapshot: PolicySnapshot,
): { action: AutomaticTransition; at: number } | null {
  if (booking.status === 'pending') {
    const deadline = booking.paymentExpiresAt ?? null;
    return deadline === null ? null : { action: 'expire_payment', at: deadline };
  }
  const running = booking.status === 'confirmed' || booking.status === 'in_progress';
  if (!running) return null;

  const candidates: { action: AutomaticTransition; at: number; rank: number }[] = [];
  if (booking.status === 'confirmed' && snapshot?.auto_start === true) {
    candidates.push({ action: 'start', at: booking.startsAt, rank: 0 });
  }
  if (noShowRule(snapshot)?.auto_mark === true && booking.checkedInAt === null) {
    candidates.push({
      action: 'no_show',
      at: booking.startsAt + graceMinutes(snapshot) * MINUTE_MS,
      rank: 1,
    });
  }
  if (snapshot?.auto_complete === true) {
    candidates.push({ action: 'complete', at: booking.endsAt, rank: 2 });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.at - b.at || a.rank - b.rank);
  const first = candidates[0]!;
  return { action: first.action, at: first.at };
}

/**
 * Does the **frozen** policy ask for somebody to confirm before a booking is confirmed?
 *
 * The same disjunction `loadPolicy` computes from the live row, read from the snapshot instead,
 * because the caller that needs it is the Stripe webhook receiver: a payment succeeds long
 * after the booking was made, and the question it has to answer is what the customer agreed to
 * then, not what the policy says now. A missing key is `false`, like every other reader here.
 */
export function requiresConfirmation(snapshot: PolicySnapshot): boolean {
  return (
    snapshot?.require_customer_confirmation === true ||
    snapshot?.require_provider_confirmation === true
  );
}
