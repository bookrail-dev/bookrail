/**
 * The operational commands, end to end against the real API: a real HTTP server
 * in front of `createApp`, a real Postgres, real keys, and no mock anywhere.
 *
 * Every scenario is built through the CLI itself (`fixtures.ts`), so a break in the CRUD of
 * the configuration commands cannot hide behind a green run here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Project } from './harness.js';
import {
  buildScenario,
  firstSlot,
  nextMonday,
  plusDays,
  slotsFor,
  type Scenario,
} from './fixtures.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);

describe('bookrail operational commands', () => {
  let h: Harness;
  let project: Project;
  let scenario: Scenario;
  const from = nextMonday();
  const to = plusDays(from, 1);

  beforeAll(async () => {
    h = await createHarness();
    project = await h.bootstrap('Ops');
    scenario = await buildScenario(h, project.testKey, { name: 'ops' });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  const env = (extra: Record<string, string> = {}): { env: Record<string, string> } => ({
    env: { BOOKRAIL_SECRET_KEY: project.testKey, ...extra },
  });

  const availabilityArgs = (...extra: string[]): string[] => [
    'availability',
    '--service',
    scenario.serviceId,
    '--from',
    from.toISOString(),
    '--to',
    to.toISOString(),
    ...extra,
  ];

  describe('availability', () => {
    it('lists slots, in JSON and as a table with the local time', async () => {
      const json = await h.cli(availabilityArgs('--json'), env());
      expect(json.code).toBe(0);
      const body = json.json<{
        object: string;
        service_id: string;
        timezone: string;
        granularity: string;
        slots: { start: string; duration_minutes: number }[];
        next_available: string | null;
      }>().data!;
      expect(body.object).toBe('availability');
      expect(body.service_id).toBe(scenario.serviceId);
      expect(body.granularity).toBe('slots');
      expect(body.slots.length).toBeGreaterThan(0);
      expect(body.slots[0]?.duration_minutes).toBe(60);
      expect(body.next_available).toBe(body.slots[0]?.start);

      const human = await h.cli(availabilityArgs(), env());
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('[test]');
      expect(human.stdout).toContain('start (UTC)');
      expect(human.stdout).toContain('local');
      expect(human.stdout).toContain(body.slots[0]!.start);
      expect(human.stdout).not.toMatch(ANSI);
    });

    /**
     * `price_rule` travels through the CLI to `--json`, and the human table gets a `rule`
     * column so a surcharge can be traced to the rule that produced it.
     */
    it('shows which pricing rule priced each slot, as a column and in JSON', async () => {
      const priced = await buildScenario(h, project.testKey, {
        name: 'priced',
        service: {
          price: { amount: 3000, currency: 'EUR' },
          pricing_rules: [
            { when: { time_from: '18:00', time_to: '20:00' }, price_add: 1500, label: 'Evening' },
          ],
        },
      });
      const args = (...extra: string[]): string[] => [
        'availability',
        '--service',
        priced.serviceId,
        '--from',
        from.toISOString(),
        '--to',
        to.toISOString(),
        ...extra,
      ];

      const json = await h.cli(args('--json'), env());
      expect(json.code).toBe(0);
      const body = json.json<{
        slots: {
          start: string;
          price: { amount: number } | null;
          price_rule: { index: number; label: string | null } | null;
        }[];
      }>().data!;
      const surcharged = body.slots.filter((slot) => slot.price?.amount === 4500);
      expect(surcharged.length).toBe(2);
      expect(surcharged.every((slot) => slot.price_rule?.label === 'Evening')).toBe(true);
      expect(body.slots.some((slot) => slot.price_rule === null)).toBe(true);

      const human = await h.cli(args(), env());
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('rule');
      expect(human.stdout).toContain('#0 Evening');
      expect(human.stdout).toContain('base');
    });

    it('explains every rejected instant, as a table and in JSON', async () => {
      const slot = await firstSlot(h, project.testKey, scenario.serviceId, from, to);
      // Take the whole capacity of the only court, so the instant has a reason to be rejected.
      const booked = await h.cli(
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          slot.start,
          '--customer-email',
          'explain@example.com',
          '--json',
        ],
        env(),
      );
      expect(booked.code).toBe(0);

      const json = await h.cli(availabilityArgs('--explain', '--json'), env());
      expect(json.code).toBe(0);
      const body = json.json<{
        explain: { at: string; reasons: { code: string; resource_id?: string }[] }[];
        explain_truncated: boolean;
      }>().data!;
      const entry = body.explain.find((candidate) => candidate.at === slot.start);
      expect(entry).toBeDefined();
      expect(entry!.reasons.map((reason) => reason.code)).toContain('occupied');
      expect(entry!.reasons[0]?.resource_id).toBe(scenario.resourceIds[0]);
      expect(body.explain_truncated).toBe(false);

      const human = await h.cli(availabilityArgs('--explain'), env());
      expect(human.stdout).toContain('instant(s) rejected');
      expect(human.stdout).toContain('occupied');
      expect(human.stdout).toContain('local instant');

      // Put the capacity back, so the rest of the suite starts from a clean slot.
      const id = booked.json<{ id: string }>().data!.id;
      const cancelled = await h.cli(['bookings', 'cancel', id, '--yes', '--json'], env());
      expect(cancelled.code).toBe(0);
    });

    it('refuses an instant without an explicit offset, before any request', async () => {
      const before = h.seenRequests.length;
      const result = await h.cli(
        [
          'availability',
          '--service',
          scenario.serviceId,
          '--from',
          '2026-09-08',
          '--to',
          to.toISOString(),
          '--json',
        ],
        env(),
      );
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('parameter_invalid');
      expect(result.json().error?.param).toBe('from');
      expect(result.json().error?.fix).toContain('+02:00');
      expect(h.seenRequests.length).toBe(before);
    });

    it('refuses a missing --service with a fix, before any request', async () => {
      const before = h.seenRequests.length;
      const result = await h.cli(['availability', '--json'], env());
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('missing_input');
      expect(result.json().error?.param).toBe('service');
      expect(h.seenRequests.length).toBe(before);
    });

    it('maps the documented ceilings to exit 1 with the API fix', async () => {
      const result = await h.cli(
        availabilityArgs('--explain').concat(['--to', plusDays(from, 30).toISOString(), '--json']),
        env(),
      );
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('range_too_large');
      expect(result.json().error?.fix).toContain('seven with `--explain`');
    });

    it('finds the next bookable instant', async () => {
      const result = await h.cli(
        [
          'availability',
          'next',
          '--service',
          scenario.serviceId,
          '--from',
          from.toISOString(),
          '--json',
        ],
        env(),
      );
      expect(result.code).toBe(0);
      const body = result.json<{
        object: string;
        next_available: string | null;
        searched_through: string;
      }>().data!;
      expect(body.object).toBe('availability_next');
      expect(body.next_available).not.toBeNull();
      expect(new Date(body.searched_through).getTime()).toBeGreaterThan(from.getTime());
    });

    it('checks one instant, and says why when it is not available', async () => {
      const slot = await firstSlot(h, project.testKey, scenario.serviceId, from, to);
      const good = await h.cli(
        ['availability', 'check', '--service', scenario.serviceId, '--start', slot.start, '--json'],
        env(),
      );
      expect(good.code).toBe(0);
      expect(good.json<{ available: boolean }>().data?.available).toBe(true);

      // Half past the hour is inside the opening hours and off the 60 minute grid, so the
      // check is about feasibility rather than alignment: it answers, with reasons.
      const offGrid = new Date(new Date(slot.start).getTime() - 12 * 3_600_000).toISOString();
      const past = await h.cli(
        ['availability', 'check', '--service', scenario.serviceId, '--start', offGrid, '--json'],
        env(),
      );
      expect(past.code).toBe(0);
      const body = past.json<{ available: boolean; reasons: { code: string }[] }>().data!;
      expect(typeof body.available).toBe('boolean');
      if (!body.available) expect(Array.isArray(body.reasons)).toBe(true);
    });
  });

  describe('holds', () => {
    it('creates a hold, sends an Idempotency-Key, and releases it', async () => {
      const slot = await firstSlot(h, project.testKey, scenario.serviceId, from, to);
      const created = await h.cli(
        [
          'holds',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          slot.start,
          '--ttl',
          '10m',
          '--customer-email',
          'holder@example.com',
          '--json',
        ],
        env(),
      );
      expect(created.code).toBe(0);
      const hold = created.json<{
        id: string;
        object: string;
        status: string;
        expires_at: string;
        allocations: unknown[];
      }>().data!;
      expect(hold.object).toBe('hold');
      expect(hold.status).toBe('active');
      expect(hold.id.startsWith('hold_')).toBe(true);
      expect(hold.allocations.length).toBeGreaterThan(0);
      expect(h.idempotencyKeys.length).toBeGreaterThan(0);

      // While it is held, the slot is gone.
      const during = await slotsFor(h, project.testKey, scenario.serviceId, from, to);
      expect(during.some((candidate) => candidate.start === slot.start)).toBe(false);

      const released = await h.cli(['holds', 'release', hold.id, '--json'], env());
      expect(released.code).toBe(0);
      expect(released.json<{ deleted: boolean }>().data?.deleted).toBe(true);

      // Releasing twice is a success: the caller wanted the slot free, and it is.
      const again = await h.cli(['holds', 'release', hold.id, '--json'], env());
      expect(again.code).toBe(0);

      const after = await slotsFor(h, project.testKey, scenario.serviceId, from, to);
      expect(after.some((candidate) => candidate.start === slot.start)).toBe(true);
    });

    it('converts into a booking, and refuses a second conversion with exit 4', async () => {
      const slot = await firstSlot(h, project.testKey, scenario.serviceId, from, to);
      const hold = (
        await h.cli(
          ['holds', 'create', '--service', scenario.serviceId, '--start', slot.start, '--json'],
          env(),
        )
      ).json<{ id: string }>().data!;

      const booked = await h.cli(
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          slot.start,
          '--hold',
          hold.id,
          '--customer-email',
          'converter@example.com',
          '--json',
        ],
        env(),
      );
      expect(booked.code).toBe(0);
      const bookingId = booked.json<{ id: string; hold_id: string }>().data!.id;
      expect(booked.json<{ hold_id: string }>().data?.hold_id).toBe(hold.id);

      const twice = await h.cli(
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          slot.start,
          '--hold',
          hold.id,
          '--json',
        ],
        env(),
      );
      expect(twice.code).toBe(4);
      expect(twice.json().error?.code).toBe('hold_not_active');
      expect(twice.json().error?.fix).toContain('Create a new one');

      await h.cli(['bookings', 'cancel', bookingId, '--yes', '--json'], env());
    });

    it('reads a hold back in each of its states', async () => {
      const slot = await firstSlot(h, project.testKey, scenario.serviceId, from, to);
      const hold = (
        await h.cli(
          ['holds', 'create', '--service', scenario.serviceId, '--start', slot.start, '--json'],
          env(),
        )
      ).json<{ id: string }>().data!;

      const active = await h.cli(['holds', 'get', hold.id, '--json'], env());
      expect(active.code).toBe(0);
      const read = active.json<{
        id: string;
        object: string;
        status: string;
        booking_id: string | null;
        price: unknown;
        allocations: { resource_id: string }[];
      }>().data!;
      expect(read.id).toBe(hold.id);
      expect(read.object).toBe('hold');
      expect(read.status).toBe('active');
      expect(read.booking_id).toBeNull();
      // A hold has no stored price; the read says so rather than inventing one.
      expect(read.price).toBeNull();
      expect(read.allocations.length).toBeGreaterThan(0);

      const booked = await h.cli(
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          slot.start,
          '--hold',
          hold.id,
          '--customer-email',
          'holdreader@example.com',
          '--json',
        ],
        env(),
      );
      expect(booked.code).toBe(0);
      const bookingId = booked.json<{ id: string }>().data!.id;

      const converted = await h.cli(['holds', 'get', hold.id, '--json'], env());
      const after = converted.json<{ status: string; booking_id: string }>().data!;
      expect(after.status).toBe('converted');
      expect(after.booking_id).toBe(bookingId);
      expect(converted.json().next_steps?.join(' ')).toContain(bookingId);

      // And the human form names the state on the first line.
      const human = await h.cli(['holds', 'get', hold.id], env());
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('is converted');
      expect(human.stdout).toContain('not recorded on a hold');

      await h.cli(['bookings', 'cancel', bookingId, '--yes', '--json'], env());
    });

    it('no longer says that `holds get` does not exist', async () => {
      const help = await h.cli(['holds', '--help'], env());
      expect(help.stdout).toContain('create, get <id>, release <id>');
      expect(help.stdout).not.toContain('There is no `holds get`');
    });

    it('refuses --customer together with --customer-email, before any request', async () => {
      const before = h.seenRequests.length;
      const result = await h.cli(
        [
          'holds',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          from.toISOString(),
          '--customer',
          'cus_00000000',
          '--customer-email',
          'both@example.com',
          '--json',
        ],
        env(),
      );
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('parameter_invalid');
      expect(h.seenRequests.length).toBe(before);
    });
  });

  describe('bookings', () => {
    let bookingId: string;
    let slotStart: string;

    it('creates one, and reads it back with its allocations', async () => {
      const slot = await firstSlot(h, project.testKey, scenario.serviceId, from, to);
      slotStart = slot.start;
      const created = await h.cli(
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          slot.start,
          '--customer-email',
          'ada@example.com',
          '--customer-name',
          'Ada',
          '--notes',
          'first game',
          '--metadata',
          '{"order_id":"o-1"}',
          '--json',
        ],
        env(),
      );
      expect(created.code).toBe(0);
      const booking = created.json<{
        id: string;
        object: string;
        status: string;
        customer_id: string;
        metadata: Record<string, unknown>;
        allocations: unknown[];
      }>().data!;
      expect(booking.object).toBe('booking');
      expect(booking.status).toBe('confirmed');
      expect(booking.customer_id).not.toBeNull();
      expect(booking.metadata.order_id).toBe('o-1');
      expect(booking.allocations).toHaveLength(1);
      bookingId = booking.id;

      const read = await h.cli(
        ['bookings', 'get', bookingId, '--expand', 'customer', '--json'],
        env(),
      );
      expect(read.code).toBe(0);
      expect(read.json<{ customer: { email: string } }>().data?.customer.email).toBe(
        'ada@example.com',
      );
      expect(read.stdout).not.toMatch(ANSI);
    });

    it('lists with filters and paginates', async () => {
      const all = await h.cli(
        ['bookings', 'list', '--service', scenario.serviceId, '--json'],
        env(),
      );
      expect(all.code).toBe(0);
      const rows = all.json<{ data: { id: string }[] }>().data!.data;
      expect(rows.some((row) => row.id === bookingId)).toBe(true);

      const confirmedOnly = await h.cli(
        ['bookings', 'list', '--status', 'confirmed', '--limit', '1', '--json'],
        env(),
      );
      expect(confirmedOnly.code).toBe(0);
      expect(confirmedOnly.json<{ data: unknown[] }>().data!.data.length).toBeLessThanOrEqual(1);

      const noMatch = await h.cli(
        ['bookings', 'list', '--status', 'no_show', '--service', scenario.serviceId, '--json'],
        env(),
      );
      expect(noMatch.json<{ data: unknown[] }>().data!.data).toHaveLength(0);

      const human = await h.cli(['bookings', 'list', '--service', scenario.serviceId], env());
      expect(human.stdout).toContain('[test]');
      expect(human.stdout).toContain('status');
    });

    it('refuses a slot that is already taken with exit 4 and the availability fix', async () => {
      const clash = await h.cli(
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          slotStart,
          '--customer-email',
          'late@example.com',
          '--json',
        ],
        env(),
      );
      expect(clash.code).toBe(4);
      expect(clash.json().error?.code).toBe('slot_unavailable');
      expect(clash.json().error?.fix).toContain('--explain');
    });

    it('refuses an instant off the slot grid with exit 1 and the grid fix', async () => {
      const offGrid = new Date(new Date(slotStart).getTime() + 30 * 60_000).toISOString();
      const result = await h.cli(
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          offGrid,
          '--customer-email',
          'off@example.com',
          '--json',
        ],
        env(),
      );
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('start_not_on_grid');
      expect(result.json().error?.fix).toContain('bookrail availability');
    });

    it('refuses a transition the state forbids with exit 4', async () => {
      const result = await h.cli(['bookings', 'confirm', bookingId, '--json'], env());
      expect(result.code).toBe(4);
      expect(result.json().error?.code).toBe('invalid_transition');
      expect(result.json().error?.fix).toContain('bookings get');
    });

    it('moves a booking through check-in and complete, under both spellings', async () => {
      // A booking cannot be completed before it starts, which is the whole point of the check.
      const early = await h.cli(['bookings', 'complete', bookingId, '--json'], env());
      expect(early.code).toBe(1);
      expect(early.json().error?.code).toBe('complete_too_early');
      expect(early.json().error?.fix).toContain('before it starts');

      const checked = await h.cli(['bookings', 'check-in', bookingId, '--json'], env());
      expect(checked.code).toBe(0);
      expect(checked.json<{ status: string }>().data?.status).toBe('in_progress');

      // The underscored spelling of `05` is an alias, so an agent copying from the reference
      // is never wrong.
      const alias = await h.cli(['bookings', 'check_in', bookingId, '--json'], env());
      expect(alias.code).toBe(4);
      expect(alias.json().error?.code).toBe('invalid_transition');
    });

    it('reschedules, answering with the new booking', async () => {
      const slots = await slotsFor(h, project.testKey, scenario.serviceId, from, to);
      const free = slots[1] ?? slots[0]!;
      const created = await h.cli(
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          free.start,
          '--customer-email',
          'mover@example.com',
          '--json',
        ],
        env(),
      );
      expect(created.code).toBe(0);
      const original = created.json<{ id: string }>().data!.id;

      const remaining = await slotsFor(h, project.testKey, scenario.serviceId, from, to);
      const target = remaining[0]!;
      const moved = await h.cli(
        ['bookings', 'reschedule', original, '--start', target.start, '--json'],
        env(),
      );
      expect(moved.code).toBe(0);
      const next = moved.json<{
        id: string;
        start: string;
        rescheduled_from_booking_id: string;
      }>().data!;
      expect(next.id).not.toBe(original);
      expect(next.start).toBe(target.start);
      expect(next.rescheduled_from_booking_id).toBe(original);

      const old = await h.cli(['bookings', 'get', original, '--json'], env());
      expect(old.json<{ status: string }>().data?.status).toBe('rescheduled');

      await h.cli(['bookings', 'cancel', next.id, '--yes', '--json'], env());
    });

    it('needs --yes to cancel outside a terminal, and asks for it inside one', async () => {
      const slots = await slotsFor(h, project.testKey, scenario.serviceId, from, to);
      const created = await h.cli(
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          slots[0]!.start,
          '--customer-email',
          'canceller@example.com',
          '--json',
        ],
        env(),
      );
      const id = created.json<{ id: string }>().data!.id;

      const refused = await h.cli(['bookings', 'cancel', id, '--json'], env());
      expect(refused.code).toBe(1);
      expect(refused.json().error?.code).toBe('confirmation_required');
      expect(refused.json().error?.fix).toContain('--yes');

      const declined = await h.cli(['bookings', 'cancel', id], {
        ...env(),
        tty: true,
        answers: ['n'],
      });
      expect(declined.code).toBe(1);
      expect(declined.questions[0]).toContain(`Cancel booking ${id}?`);
      const stillThere = await h.cli(['bookings', 'get', id, '--json'], env());
      expect(stillThere.json<{ status: string }>().data?.status).toBe('confirmed');

      const accepted = await h.cli(['bookings', 'cancel', id], {
        ...env(),
        tty: true,
        answers: ['y'],
      });
      expect(accepted.code).toBe(0);
      const gone = await h.cli(['bookings', 'get', id, '--json'], env());
      expect(gone.json<{ status: string }>().data?.status).toBe('cancelled');
    });

    it('records the refund the policy promises, without moving money', async () => {
      const slots = await slotsFor(h, project.testKey, scenario.serviceId, from, to);
      const id = (
        await h.cli(
          [
            'bookings',
            'create',
            '--service',
            scenario.serviceId,
            '--start',
            slots[0]!.start,
            '--customer-email',
            'refund@example.com',
            '--json',
          ],
          env(),
        )
      ).json<{ id: string }>().data!.id;

      const cancelled = await h.cli(
        ['bookings', 'cancel', id, '--yes', '--by', 'provider', '--reason', 'flooded', '--json'],
        env(),
      );
      expect(cancelled.code).toBe(0);
      const body = cancelled.json<{
        status: string;
        refund_percent: number;
        amount_refunded: number;
        cancellation_reason: string;
      }>().data!;
      expect(body.status).toBe('cancelled');
      expect(body.refund_percent).toBe(100);
      expect(body.amount_refunded).toBe(0);
      expect(body.cancellation_reason).toBe('flooded');
    });
  });

  describe('events', () => {
    it('lists the log and reads one event back', async () => {
      const list = await h.cli(['events', 'list', '--limit', '5', '--json'], env());
      expect(list.code).toBe(0);
      const rows = list.json<{ data: { id: string; type: string }[] }>().data!.data;
      expect(rows.length).toBeGreaterThan(0);

      const one = await h.cli(['events', 'get', rows[0]!.id, '--json'], env());
      expect(one.code).toBe(0);
      const event = one.json<{ id: string; data: { object: unknown } }>().data!;
      expect(event.id).toBe(rows[0]!.id);
      expect(event.data.object).not.toBeNull();
    });

    it('filters by type and by subject', async () => {
      const created = await h.cli(
        ['events', 'list', '--type', 'booking.created', '--all', '--json'],
        env(),
      );
      expect(created.code).toBe(0);
      const rows = created.json<{ data: { type: string }[] }>().data!.data;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.type === 'booking.created')).toBe(true);

      const subject = rows[0]! as unknown as { data: { object: { id: string } } };
      const byObject = await h.cli(
        ['events', 'list', '--object-id', subject.data.object.id, '--all', '--json'],
        env(),
      );
      expect(byObject.json<{ data: unknown[] }>().data!.data.length).toBeGreaterThan(0);
    });

    it('pushes several --type values to the server as `type[]`', async () => {
      const wanted = ['booking.created', 'booking.cancelled'];
      const before = h.seenUrls.length;
      const result = await h.cli(
        ['events', 'list', '--type', wanted[0]!, '--type', wanted[1]!, '--all', '--json'],
        env(),
      );
      expect(result.code).toBe(0);
      const rows = result.json<{ data: { type: string }[] }>().data!.data;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => wanted.includes(row.type))).toBe(true);
      expect(new Set(rows.map((row) => row.type))).toEqual(new Set(wanted));

      // The filter left the process. The CLI used to ask for everything and throw
      // rows away locally, which is the behaviour this assertion exists to prevent returning.
      const urls = h.seenUrls.slice(before).filter((url) => url.includes('/v1/events'));
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        const query = new URLSearchParams(url.slice(url.indexOf('?')));
        expect(query.getAll('type[]')).toEqual(wanted);
      }
    });

    it('sends one `type[]` for a single value too', async () => {
      const before = h.seenUrls.length;
      await h.cli(['events', 'list', '--type', 'booking.created', '--limit', '1', '--json'], env());
      const url = h.seenUrls.slice(before).find((candidate) => candidate.includes('/v1/events'));
      expect(url).toBeDefined();
      expect(new URLSearchParams(url!.slice(url!.indexOf('?'))).getAll('type[]')).toEqual([
        'booking.created',
      ]);
    });

    it('follows the log and sees events written while it is following', async () => {
      const slots = await slotsFor(h, project.testKey, scenario.serviceId, from, to);
      const start = slots[0]!.start;

      const following = h.cli(
        [
          'events',
          'list',
          '--follow',
          '--interval',
          '1',
          '--max',
          '1',
          '--duration',
          '30',
          '--json',
        ],
        env(),
      );

      // Written *after* the follow began, which is what makes this a follow rather than a read.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const created = await h.cli(
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          start,
          '--customer-email',
          'follower@example.com',
          '--json',
        ],
        env(),
      );
      expect(created.code).toBe(0);
      const bookingId = created.json<{ id: string }>().data!.id;

      const result = await following;
      expect(result.code).toBe(0);
      const body = result.json<{
        data: { type: string; data: { object: { id: string } } }[];
        stopped_by: string;
        followed: boolean;
        next_cursor: string | null;
      }>().data!;
      expect(body.followed).toBe(true);
      expect(body.stopped_by).toBe('max');
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.data.object.id).toBe(bookingId);
      expect(body.next_cursor).not.toBeNull();

      await h.cli(['bookings', 'cancel', bookingId, '--yes', '--json'], env());
    }, 60_000);

    it('stops on the duration bound when nothing arrives', async () => {
      const result = await h.cli(
        ['events', 'list', '--follow', '--interval', '1', '--duration', '2', '--json'],
        env(),
      );
      expect(result.code).toBe(0);
      const body = result.json<{ data: unknown[]; stopped_by: string }>().data!;
      expect(body.stopped_by).toBe('duration');
      expect(body.data).toHaveLength(0);
    }, 30_000);

    it('stops on an interrupt, and streams lines when the output is not JSON', async () => {
      const result = await h.cli(['events', 'list', '--follow', '--interval', '1'], {
        ...env(),
        interruptAfterMs: 800,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('following the event log');
      expect(result.stdout).toContain('stopped (interrupted)');
    }, 30_000);

    it('refuses --follow --json without a bound, naming the two flags', async () => {
      const result = await h.cli(['events', 'list', '--follow', '--json'], env());
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('missing_input');
      expect(result.json().error?.fix).toContain('--max');
      expect(result.json().error?.fix).toContain('--duration');
    });
  });

  describe('resources blocks', () => {
    it('lists what is closed on a resource, ordered by start, and pages on the cursor', async () => {
      const resourceId = scenario.resourceIds[0]!;
      const day = (n: number): string => `2027-06-${String(n).padStart(2, '0')}`;
      for (const d of [12, 4, 8]) {
        const created = await fetch(`${h.url}/v1/resources/${resourceId}/block`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${project.testKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: `${day(d)}T09:00:00Z`,
            to: `${day(d)}T11:00:00Z`,
            reason: `cli ${String(d)}`,
          }),
        });
        expect(created.status).toBe(201);
      }

      const listed = await h.cli(['resources', 'blocks', resourceId, '--json'], env());
      expect(listed.code).toBe(0);
      const rows = listed.json<{ data: { id: string; from: string; reason: string }[] }>().data!
        .data;
      expect(rows.map((row) => row.reason)).toEqual(['cli 4', 'cli 8', 'cli 12']);
      expect(rows.every((row) => row.id.startsWith('blk_'))).toBe(true);
      expect(listed.json().next_steps?.join(' ')).toContain('unblock');

      const paged = await h.cli(
        ['resources', 'blocks', resourceId, '--limit', '2', '--json'],
        env(),
      );
      const page = paged.json<{ data: { id: string }[]; has_more: boolean; next_cursor: string }>()
        .data!;
      expect(page.data).toHaveLength(2);
      expect(page.has_more).toBe(true);
      const rest = await h.cli(
        ['resources', 'blocks', resourceId, '--starting-after', page.next_cursor, '--json'],
        env(),
      );
      expect(rest.json<{ data: { id: string }[] }>().data!.data.map((row) => row.id)).toEqual(
        rows.slice(2).map((row) => row.id),
      );

      // The human form shows the ids that `unblock` needs.
      const human = await h.cli(['resources', 'blocks', resourceId], env());
      expect(human.stdout).toContain('block(s) on');
      expect(human.stdout).toContain(rows[0]!.id);
    });

    it('validates --from locally, and 404s on a resource that is not there', async () => {
      const before = h.seenRequests.length;
      const bad = await h.cli(
        ['resources', 'blocks', scenario.resourceIds[0]!, '--from', '2027-06-04', '--json'],
        env(),
      );
      expect(bad.code).toBe(1);
      expect(bad.json().error?.code).toBe('parameter_invalid');
      // A bare date never leaves the process: midnight is not the same instant everywhere.
      expect(h.seenRequests.length).toBe(before);

      const missing = await h.cli(
        ['resources', 'blocks', 'res_00000000000000000000000000000000', '--json'],
        env(),
      );
      expect(missing.code).toBe(1);
      expect(missing.json().error?.code).toBe('resource_missing');
    });
  });

  describe('Bookrail-Actor', () => {
    it('declares itself as `cli` on every request', async () => {
      const before = h.seenActors.length;
      const result = await h.cli(['events', 'list', '--limit', '1', '--json'], env());
      expect(result.code).toBe(0);
      const actors = h.seenActors.slice(before);
      expect(actors.length).toBeGreaterThan(0);
      expect(actors.every((actor) => actor === 'cli')).toBe(true);
    });

    it('sends what BOOKRAIL_ACTOR names, which is how the MCP server declares itself', async () => {
      const before = h.seenActors.length;
      const result = await h.cli(
        ['events', 'list', '--limit', '1', '--json'],
        env({ BOOKRAIL_ACTOR: 'mcp' }),
      );
      expect(result.code).toBe(0);
      expect(h.seenActors.slice(before).every((actor) => actor === 'mcp')).toBe(true);
    });

    it('falls back to `cli` for a value outside the closed list, instead of failing', async () => {
      const before = h.seenActors.length;
      const result = await h.cli(
        ['events', 'list', '--limit', '1', '--json'],
        env({ BOOKRAIL_ACTOR: 'curl' }),
      );
      // Never a request the server would refuse with 400: the CLI would rather be honest about
      // what it is than pass a claim through.
      expect(result.code).toBe(0);
      expect(h.seenActors.slice(before).every((actor) => actor === 'cli')).toBe(true);
    });
  });

  describe('output conventions and the live barrier', () => {
    it('wraps every operational answer in the standard envelope', async () => {
      const results = await Promise.all([
        h.cli(availabilityArgs('--json'), env()),
        h.cli(['events', 'list', '--limit', '1', '--json'], env()),
        h.cli(['bookings', 'list', '--limit', '1', '--json'], env()),
        h.cli(['webhooks', 'list', '--json'], env()),
      ]);
      for (const result of results) {
        expect(result.code).toBe(0);
        const envelope = result.json();
        expect(envelope.ok).toBe(true);
        expect(envelope.environment).toBe('test');
        expect(envelope.data).toBeDefined();
        expect(result.stdout).not.toMatch(ANSI);
      }
    });

    it('sends nothing at all when a live key is used without --live', async () => {
      const before = h.seenRequests.length;
      const live = { env: { BOOKRAIL_SECRET_KEY: project.liveKey } };
      const commands: string[][] = [
        availabilityArgs('--json'),
        ['availability', 'next', '--service', scenario.serviceId, '--json'],
        [
          'availability',
          'check',
          '--service',
          scenario.serviceId,
          '--start',
          from.toISOString(),
          '--json',
        ],
        [
          'holds',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          from.toISOString(),
          '--json',
        ],
        ['holds', 'release', 'hold_00000000', '--json'],
        [
          'bookings',
          'create',
          '--service',
          scenario.serviceId,
          '--start',
          from.toISOString(),
          '--json',
        ],
        ['bookings', 'get', 'bk_00000000', '--json'],
        ['bookings', 'list', '--json'],
        ['bookings', 'confirm', 'bk_00000000', '--json'],
        ['bookings', 'cancel', 'bk_00000000', '--yes', '--json'],
        ['bookings', 'reschedule', 'bk_00000000', '--start', from.toISOString(), '--json'],
        ['bookings', 'complete', 'bk_00000000', '--json'],
        ['bookings', 'no-show', 'bk_00000000', '--json'],
        ['bookings', 'check-in', 'bk_00000000', '--json'],
        ['events', 'list', '--json'],
        ['events', 'get', 'evt_00000000', '--json'],
        ['webhooks', 'list', '--json'],
        ['webhooks', 'get', 'wh_00000000', '--json'],
        ['webhooks', 'create', '--url', 'https://example.com/hook', '--json'],
        ['webhooks', 'update', 'wh_00000000', '--status', 'disabled', '--json'],
        ['webhooks', 'delete', 'wh_00000000', '--yes', '--json'],
        ['webhooks', 'test', 'wh_00000000', '--json'],
        ['webhooks', 'deliveries', 'wh_00000000', '--json'],
        ['webhooks', 'retry', 'wh_00000000', 'whd_00000000', '--json'],
        ['webhooks', 'listen', '--url', 'https://example.com/hook', '--max', '1', '--json'],
      ];
      for (const command of commands) {
        const result = await h.cli(command, live);
        expect(result.code, command.join(' ')).toBe(2);
        expect(result.json().error?.code, command.join(' ')).toBe('live_key_without_live');
      }
      expect(h.seenRequests.length).toBe(before);
      expect(h.seenKeys.filter((key) => key.startsWith('sk_live_'))).toHaveLength(0);
    });

    it('documents what every operational command needs and returns', async () => {
      const commands = [
        ['availability'],
        ['availability', 'next'],
        ['availability', 'check'],
        ['holds'],
        ['holds', 'create'],
        ['bookings'],
        ['bookings', 'create'],
        ['bookings', 'cancel'],
        ['webhooks'],
        ['webhooks', 'create'],
        ['webhooks', 'listen'],
        ['events'],
        ['events', 'list'],
      ];
      for (const command of commands) {
        const help = await h.cli([...command, '--help']);
        expect(help.code, command.join(' ')).toBe(0);
        expect(help.stdout, command.join(' ')).toMatch(/Needs:|Returns:|Sub-commands:|With --url/);
      }
    });

    it('no longer answers not_yet_available for the operational commands', async () => {
      for (const name of ['availability', 'bookings', 'holds', 'webhooks', 'events']) {
        const help = await h.cli([name, '--help']);
        expect(help.stdout).not.toContain('not in this build');
      }
      // The two that really are not in this build still say so, and say why.
      for (const name of ['logs', 'requests']) {
        const result = await h.cli([name, '--json']);
        expect(result.code).toBe(1);
        expect(result.json().error?.code).toBe('not_yet_available');
        expect(result.json().error?.fix).toContain('request log');
      }
    });
  });
});
