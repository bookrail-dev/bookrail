/**
 * The six booking transition endpoints, over HTTP.
 *
 * The engine's suite (`packages/engine/test/lifecycle.test.ts`) owns the state machine and the
 * arithmetic; what is tested here is what only HTTP can get wrong: the status codes, the
 * prefixed identifiers, the bodies, the interaction with `Idempotency-Key`, and the
 * availability cache being dropped for the days a cancellation frees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_TRANSITION_ACTIONS } from '@bookrail/engine';
import { createHarness, type Harness } from './harness.js';
import { settleEventLog } from './event-horizon.js';
import {
  buildScenario,
  firstSlot,
  nextMonday,
  plusDays,
  slotsFor,
  ageBooking,
  type ErrorBody,
} from './booking-fixtures.js';

interface BookingBody {
  id: string;
  object: string;
  status: string;
  start: string;
  end: string;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  refund_percent: number | null;
  refund_amount_expected: number | null;
  no_show_charge_expected: number | null;
  reschedule_fee_expected: number | null;
  reschedule_count: number;
  rescheduled_from_booking_id: string | null;
  rescheduled_to_booking_id: string | null;
  checked_in_at: string | null;
  cancelled_at: string | null;
  next_transition: string | null;
  next_transition_at: string | null;
}

describe('booking transitions over HTTP', () => {
  let h: Harness;
  let token: string;

  beforeAll(async () => {
    h = createHarness();
    token = (await h.bootstrap('Transitions')).testKey;
  });

  afterAll(async () => {
    await h.close();
  });

  const from = nextMonday();
  const to = plusDays(from, 1);

  /** A scenario, plus one booking on its first free slot. */
  async function booked(
    options: Parameters<typeof buildScenario>[2] = {},
  ): Promise<{ scenario: Awaited<ReturnType<typeof buildScenario>>; booking: BookingBody }> {
    const scenario = await buildScenario(h, token, options);
    const slot = await firstSlot(h, token, scenario.serviceId, from, to);
    const created = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(created.status).toBe(201);
    return { scenario, booking: created.body };
  }

  it('confirms, checks in and completes, answering with the booking each time', async () => {
    const { booking } = await booked({ policy: { require_provider_confirmation: true } });
    expect(booking.status).toBe('pending');

    const confirmed = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/confirm`, {
      token,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      id: booking.id,
      object: 'booking',
      status: 'confirmed',
    });

    const checkedIn = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/check_in`, {
      token,
    });
    expect(checkedIn.status).toBe(200);
    expect(checkedIn.body.status).toBe('in_progress');
    expect(checkedIn.body.checked_in_at).not.toBeNull();

    // The clock has to have caught up with the booking: `completed` keeps its occupancy, so
    // completing one that has not started would take its slot off the market for ever.
    await ageBooking(h, booking.id);
    const completed = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/complete`, {
      token,
    });
    expect(completed.body.status).toBe('completed');
  });

  it('accepts a call with no body at all', async () => {
    const { booking } = await booked();
    await ageBooking(h, booking.id);
    // No `content-type`, no body: what an HTTP client sends when there is nothing to send.
    const response = await h.app.request(`/v1/bookings/${booking.id}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it('answers 409 invalid_transition, naming the status and what is allowed', async () => {
    const { booking } = await booked();
    await h.call('POST', `/v1/bookings/${booking.id}/cancel`, { token });
    const again = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/check_in`, { token });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ type: 'conflict', code: 'invalid_transition' });
    expect(again.body.error.message).toContain('cancelled');
  });

  it('answers 404 for a booking of another project and for a malformed id', async () => {
    const other = await h.bootstrap('Transitions other');
    const { booking } = await booked();
    const foreign = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/cancel`, {
      token: other.testKey,
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('resource_missing');

    const malformed = await h.call<ErrorBody>('POST', '/v1/bookings/svc_deadbeef/cancel', {
      token,
    });
    expect(malformed.status).toBe(404);
  });

  it('cancels with a reason, a `by`, and an override, and frees the slot', async () => {
    const { scenario, booking } = await booked({
      policy: { cancellation: [{ before: '0h', refund_percent: 0 }] },
    });
    const before = await slotsFor(h, token, scenario.serviceId, from, to);
    const taken = before.find((slot) => slot.start === booking.start);
    expect(taken).toBeUndefined();

    const cancelled = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/cancel`, {
      token,
      body: { reason: 'flooded', by: 'provider', override_refund_percent: 75 },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      cancelled_by: 'provider',
      cancellation_reason: 'flooded',
      refund_percent: 75,
      refund_amount_expected: 0,
    });
    expect(cancelled.body.cancelled_at).not.toBeNull();

    // The availability cache was dropped on the days the cancellation freed: the slot is back
    // straight away, not after the entry's TTL.
    const after = await slotsFor(h, token, scenario.serviceId, from, to);
    expect(after.some((slot) => slot.start === booking.start)).toBe(true);
  });

  it('refuses a no-show before the grace period with 422', async () => {
    const { booking } = await booked({
      policy: { no_show: { grace_minutes: 30, charge_percent: 50 } },
    });
    const early = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/no_show`, { token });
    expect(early.status).toBe(422);
    expect(early.body.error).toMatchObject({
      type: 'policy_violation',
      code: 'no_show_too_early',
    });
  });

  it('marks a no-show once the grace period has passed', async () => {
    const { booking } = await booked({
      policy: { no_show: { grace_minutes: 30, charge_percent: 50 } },
    });
    // Two hours in the past, so `starts_at + 30 minutes` is behind us.
    await ageBooking(h, booking.id);
    const marked = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/no_show`, {
      token,
    });
    expect(marked.status).toBe(200);
    expect(marked.body.status).toBe('no_show');
    expect(marked.body.no_show_charge_expected).not.toBeNull();
  });

  it('reschedules, answering with the new booking and linking the two', async () => {
    const { scenario, booking } = await booked({
      policy: { reschedule: [{ before: '0h', fee: 300 }], max_reschedules: 2 },
    });
    const slots = await slotsFor(h, token, scenario.serviceId, from, to);
    const target = slots.find((slot) => slot.start !== booking.start);
    expect(target).toBeDefined();

    const moved = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/reschedule`, {
      token,
      body: { start: target!.start },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.id).not.toBe(booking.id);
    expect(moved.body).toMatchObject({
      status: 'confirmed',
      start: target!.start,
      reschedule_count: 1,
      reschedule_fee_expected: 300,
      rescheduled_from_booking_id: booking.id,
    });

    const old = await h.call<BookingBody>('GET', `/v1/bookings/${booking.id}`, { token });
    expect(old.body).toMatchObject({
      status: 'rescheduled',
      rescheduled_to_booking_id: moved.body.id,
    });
  });

  it('refuses a reschedule onto a slot somebody else has taken, and leaves the old one alone', async () => {
    const { scenario, booking } = await booked();
    const slots = await slotsFor(h, token, scenario.serviceId, from, to);
    const target = slots.find((slot) => slot.start !== booking.start)!;
    const rival = await h.call('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: target.start },
    });
    expect(rival.status).toBe(201);

    const clash = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/reschedule`, {
      token,
      body: { start: target.start },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('slot_unavailable');

    const untouched = await h.call<BookingBody>('GET', `/v1/bookings/${booking.id}`, { token });
    expect(untouched.body.status).toBe('confirmed');
    expect(untouched.body.rescheduled_to_booking_id).toBeNull();
  });

  it('refuses a reschedule past max_reschedules with 422', async () => {
    const { scenario, booking } = await booked({
      resources: 3,
      policy: { max_reschedules: 0 },
    });
    const slots = await slotsFor(h, token, scenario.serviceId, from, to);
    const target = slots.find((slot) => slot.start !== booking.start)!;
    const refused = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/reschedule`, {
      token,
      body: { start: target.start },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('max_reschedules_reached');
  });

  it('validates the reschedule body', async () => {
    const { booking } = await booked();
    const missing = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/reschedule`, {
      token,
      body: {},
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.param).toBe('start');

    const unknown = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/cancel`, {
      token,
      body: { why: 'because' },
    });
    expect(unknown.status).toBe(400);
  });

  it('replays a cancellation carrying the same Idempotency-Key instead of answering 409', async () => {
    const { booking } = await booked();
    const key = `cancel-${booking.id}`;
    const first = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/cancel`, {
      token,
      body: { reason: 'once' },
      headers: { 'idempotency-key': key },
    });
    expect(first.status).toBe(200);

    const replay = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/cancel`, {
      token,
      body: { reason: 'once' },
      headers: { 'idempotency-key': key },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual(first.body);

    // Without the key, the second attempt is the 409 the state machine owes.
    const bare = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/cancel`, { token });
    expect(bare.status).toBe(409);
  });

  it('exposes the automatic clock the policy set', async () => {
    const { booking } = await booked({ policy: { auto_complete: true } });
    const read = await h.call<BookingBody>('GET', `/v1/bookings/${booking.id}`, { token });
    expect(read.body.next_transition).toBe('complete');
    expect(read.body.next_transition_at).toBe(booking.end);
  });

  // --- B1: the event and the row must say the same thing ------------------------------------

  /**
   * `data.object` of `booking.created` against `GET /v1/bookings/{id}`, field by field.
   *
   * This is the assertion that was missing and that would have caught B1: the reschedule wrote
   * the link, the counter and the fee **after** the event, so the one event announcing the new
   * booking was permanently wrong about all three, including money, and `events` is
   * append-only, so nothing could ever correct it.
   */
  async function assertEventMatchesRow(bookingId: string): Promise<void> {
    // The list answers from below the horizon, and the horizon is a property of the whole
    // Postgres cluster, so the event this test just caused is not guaranteed to be listable
    // the instant the request that wrote it returned. Wait for the condition, then assert.
    await settleEventLog(h);
    const list = await h.call<{
      data: { type: string; data: { object: Record<string, unknown> } }[];
    }>('GET', `/v1/events?object_id=${bookingId}&type=booking.created`, { token });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const object = list.body.data[0]!.data.object;

    const row = await h.call<Record<string, unknown>>('GET', `/v1/bookings/${bookingId}`, {
      token,
    });
    expect(row.status).toBe(200);

    // Every key the event carries has to hold what the row holds. The row has more (the
    // frozen `policy_snapshot`, `created_at`, `updated_at`, the allocation ids), and that is
    // the event being a snapshot of the object rather than of the table.
    //
    // `expires_at` is the one key that is in the event and not in the response: a booking does
    // not expire, and the key is kept at `null` only because `booking.created` has always
    // carried it and dropping it would turn a `null` into an `undefined` for a consumer.
    // `allocations` is compared below on the fields both sides
    // share, since the event does not carry allocation ids.
    const skip = new Set(['allocations', 'expires_at']);
    for (const [key, value] of Object.entries(object)) {
      if (skip.has(key)) continue;
      expect({ key, value }).toEqual({ key, value: row.body[key] });
    }
    // The allocations, compared on the fields both sides carry.
    const eventAllocations = object.allocations as Record<string, unknown>[];
    const rowAllocations = row.body.allocations as Record<string, unknown>[];
    expect(eventAllocations.map((a) => [a.resource_id, a.role, a.capacity_used])).toEqual(
      rowAllocations.map((a) => [a.resource_id, a.role, a.capacity_used]),
    );
  }

  it('writes a booking.created whose object matches the booking, field by field', async () => {
    const { booking } = await booked({ policy: { auto_complete: true } });
    await assertEventMatchesRow(booking.id);
  });

  it('does the same for a booking born from a reschedule, fee and link included', async () => {
    const { scenario, booking } = await booked({
      resources: 2,
      policy: { reschedule: [{ before: '0h', fee: 700 }], max_reschedules: 3 },
    });
    const slots = await slotsFor(h, token, scenario.serviceId, from, to);
    const target = slots.find((slot) => slot.start !== booking.start)!;
    const moved = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/reschedule`, {
      token,
      body: { start: target.start },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.reschedule_fee_expected).toBe(700);

    await assertEventMatchesRow(moved.body.id);

    // And spelled out, because these three are the ones that were wrong: the event has to
    // carry the link back, the counter and the fee, or a consumer mirroring bookings from the
    // event stream is permanently out by a fee in cents.
    const list = await h.call<{
      data: { data: { object: Record<string, unknown> } }[];
    }>('GET', `/v1/events?object_id=${moved.body.id}&type=booking.created`, { token });
    expect(list.body.data[0]!.data.object).toMatchObject({
      rescheduled_from_booking_id: booking.id,
      reschedule_count: 1,
      reschedule_fee_expected: 700,
    });
  });

  it('cancels a booking that has already started', async () => {
    // A service that has begun and has to be broken off is a cancellation, not a completion.
    // Without this the only way out of `in_progress` would be `complete`, which charges in
    // full.
    const { booking } = await booked({
      policy: { cancellation: [{ before: '0h', refund_percent: 0 }] },
    });
    const checkedIn = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/check_in`, {
      token,
    });
    expect(checkedIn.body.status).toBe('in_progress');

    const cancelled = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/cancel`, {
      token,
      body: { reason: 'the boiler broke', by: 'provider' },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      cancelled_by: 'provider',
      refund_percent: 100,
    });
  });

  it('refuses to complete a booking that has not started, with 422', async () => {
    const { scenario, booking } = await booked();
    const early = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/complete`, { token });
    expect(early.status).toBe(422);
    expect(early.body.error).toMatchObject({
      type: 'policy_violation',
      code: 'complete_too_early',
    });

    // And the slot is still the booking's, not lost: the refusal changed nothing.
    const still = await h.call<BookingBody>('GET', `/v1/bookings/${booking.id}`, { token });
    expect(still.body.status).toBe('confirmed');
    const slots = await slotsFor(h, token, scenario.serviceId, from, to);
    expect(slots.some((slot) => slot.start === booking.start)).toBe(false);
  });

  it('says what it cannot do in English', async () => {
    const { booking } = await booked();
    await h.call('POST', `/v1/bookings/${booking.id}/cancel`, { token });
    const again = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/cancel`, { token });
    expect(again.body.error.message).toBe(
      'A booking in status "cancelled" cannot be cancelled. This is a terminal state: no action leaves it.',
    );

    const { booking: second } = await booked();
    await h.call('POST', `/v1/bookings/${second.id}/check_in`, { token });
    const confirm = await h.call<ErrorBody>('POST', `/v1/bookings/${second.id}/confirm`, { token });
    expect(confirm.body.error.message).toBe(
      'A booking in status "in_progress" cannot be confirmed. Allowed from here: cancel, complete, no_show.',
    );
  });

  it('mounts exactly the actions the engine says are public', async () => {
    // The constant is the source the routes are generated from, and this is what makes it a
    // source rather than a comment.
    const { booking } = await booked();
    const mounted: string[] = [];
    for (const action of [...HTTP_TRANSITION_ACTIONS, 'start', 'archive'] as const) {
      const response = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/${action}`, {
        token,
        body: action === 'reschedule' ? { start: booking.start } : {},
      });
      // Anything that is not routed answers `404 unknown_endpoint`; anything routed answers
      // something else, whatever the state machine then decides.
      const routed = !(response.status === 404 && response.body.error?.code === 'unknown_endpoint');
      if (routed) mounted.push(action);
    }
    expect(mounted.sort()).toEqual([...HTTP_TRANSITION_ACTIONS].sort());
  });

  it('does not expose `start`, which belongs to the scheduler and not to the caller', async () => {
    const { booking } = await booked();
    const response = await h.call<ErrorBody>('POST', `/v1/bookings/${booking.id}/start`, { token });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('unknown_endpoint');
  });
});
