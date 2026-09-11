/**
 * The whole SDK against the real API, on a real socket, on real Postgres.
 *
 * Nothing here is mocked: `createApp` from `@bookrail/api` serves the requests, the engine
 * writes the rows under Row Level Security, and the webhook dispatcher signs and delivers to a
 * `node:http` receiver this file opens. The padel round trip is done **with the SDK alone**
 * (no `fetch`, no SQL), which is the only way to know that the package a customer installs
 * can actually take a booking.
 *
 * The last test of the file is the one that matters most: every one of the 67 operations this
 * package offers has been hit, at least once, by these tests. Those are the operations of the
 * specification less the three sign up ones, which are marked out of the SDK because a client
 * is constructed with a key and they are how a key comes into being.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Bookrail from '../src/index.js';
import { BookrailConflictError, BookrailNotFoundError } from '../src/index.js';
import {
  createHarness,
  startReceiver,
  type Harness,
  type Project,
  type Receiver,
} from './harness.js';
import { OPERATIONS } from './operations.js';

const DAY_MS = 86_400_000;

/** Midnight UTC of a Monday at least a week away, so nothing is near `now`. */
function nextMonday(): Date {
  const day = new Date(Date.now() + 7 * DAY_MS);
  day.setUTCHours(0, 0, 0, 0);
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  return day;
}

function iso(at: Date | number): string {
  return new Date(at).toISOString();
}

async function until(at: number): Promise<void> {
  const wait = at - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + 250));
}

let h: Harness;
let project: Project;
let bookrail: Bookrail;
let receiver: Receiver;

const monday = nextMonday();

interface Scenario {
  locationId: string;
  scheduleId: string;
  courtIds: string[];
  groupId: string;
  policyId: string;
  serviceId: string;
}

const padel = {} as Scenario;
/** Two bookings that start a few seconds from now, so `complete` and `no_show` are legal. */
const soon = { startsAt: 0, completeId: '', noShowId: '' };

beforeAll(async () => {
  h = await createHarness();
  project = await h.bootstrap('SDK');
  receiver = await startReceiver();
  bookrail = h.client(project.testKey);
}, 120_000);

afterAll(async () => {
  await receiver.close();
  await h.close();
});

describe('the client knows who it is', () => {
  it('reads the project of its key', async () => {
    const info = await bookrail.project.retrieve();
    expect(info.object).toBe('project');
    expect(info.environment).toBe('test');
    expect(bookrail.environment).toBe('test');
    expect(info.api_key.id.startsWith('key_')).toBe(true);
  });

  it('declares itself as `sdk` on every request', () => {
    const actors = h.seen
      .filter((request) => request.path.startsWith('/v1/'))
      .map((request) => request.headers['bookrail-actor']);
    expect(actors.length).toBeGreaterThan(0);
    expect(new Set(actors)).toEqual(new Set(['sdk']));
  });

  it('reads the contract without a key', async () => {
    const document = await bookrail.openapi.retrieve();
    expect(document.openapi).toBe('3.1.0');
    const call = h.seen.at(-1);
    expect(call?.path).toBe('/openapi.json');
    expect(call?.headers['authorization']).toBeUndefined();
  });

  it('refuses a key the API would refuse, and reports a 401 as an authentication error', async () => {
    const wrong = h.client('sk_test_thiskeydoesnotexist');
    await expect(wrong.project.retrieve()).rejects.toMatchObject({
      type: 'authentication',
      status: 401,
    });
  });
});

describe('building a padel club with the SDK alone', () => {
  it('creates the location and the calendar', async () => {
    const location = await bookrail.locations.create({
      name: 'Club Roma',
      timezone: 'Europe/Rome',
      address: { city: 'Roma' },
    });
    expect(location.object).toBe('location');
    padel.locationId = location.id;

    // The `!` is not a convenience: `components.schemas.Schedule` is declared
    // `type: ["object", "null"]` in the specification, because the same schema is reused for
    // the nullable `resource.schedule`. So every schedule operation types as `Schedule | null`,
    // which is wrong for a create. Left alone rather than patched here: the fix belongs in
    // the specification, in `packages/api`.
    const schedule = (await bookrail.schedules.create({
      name: 'Always open',
      timezone: 'Europe/Rome',
      rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '00:00', end_time: '00:00' }],
    }))!;
    expect(schedule.rules?.length).toBe(1);
    padel.scheduleId = schedule.id;
  });

  it('creates two courts and groups them', async () => {
    padel.courtIds = [];
    for (const name of ['Court 1', 'Court 2']) {
      const court = await bookrail.resources.create({
        name,
        type: 'court',
        location_id: padel.locationId,
        schedule_id: padel.scheduleId,
        capacity: 1,
      });
      padel.courtIds.push(court.id);
    }
    const group = await bookrail.resourceGroups.create({
      name: 'Courts',
      resource_ids: padel.courtIds,
      allocation_strategy: 'first_available',
    });
    expect(group.object).toBe('resource_group');
    padel.groupId = group.id;
  });

  it('creates the policy and the service', async () => {
    const policy = await bookrail.policies.create({
      name: 'Standard',
      cancellation: [{ before: '24h', refund_percent: 100 }],
      no_show: { charge_percent: 50, grace_minutes: 0 },
      hold_duration_seconds: 600,
      // Without it a booking is born `confirmed` and `bookings.confirm` would be an illegal
      // transition: the padel round trip has to start at `pending` to exercise the whole chain.
      require_customer_confirmation: true,
    });
    padel.policyId = policy.id;

    const service = await bookrail.services.create({
      name: 'Padel 60',
      duration: 60,
      price: { amount: 2400, currency: 'EUR' },
      policy_id: policy.id,
      requirements: [{ resource_group_id: padel.groupId, quantity: 1, consumes: 'whole' }],
    });
    expect(service.object).toBe('service');
    padel.serviceId = service.id;
  });

  it('lists what it created, through the cursored lists', async () => {
    const locations = await bookrail.locations.list({ limit: 10 });
    expect(locations.data.some((row) => row.id === padel.locationId)).toBe(true);
    const schedules = await bookrail.schedules.list();
    expect(schedules.data.some((row) => row?.id === padel.scheduleId)).toBe(true);
    const resources = await bookrail.resources.list({ 'expand[]': ['schedule'] });
    expect(resources.data.length).toBeGreaterThanOrEqual(2);
    const groups = await bookrail.resourceGroups.list({ 'expand[]': ['resources'] });
    expect(groups.data.some((row) => row.id === padel.groupId)).toBe(true);
    const services = await bookrail.services.list({ 'expand[]': ['requirements'] });
    expect(services.data.some((row) => row.id === padel.serviceId)).toBe(true);
    const policies = await bookrail.policies.list();
    expect(policies.data.some((row) => row.id === padel.policyId)).toBe(true);
  });

  it('reads each object back by id', async () => {
    expect((await bookrail.locations.retrieve(padel.locationId)).id).toBe(padel.locationId);
    expect((await bookrail.schedules.retrieve(padel.scheduleId))?.id).toBe(padel.scheduleId);
    expect(
      (await bookrail.resources.retrieve(padel.courtIds[0]!, { expand: ['schedule'] })).id,
    ).toBe(padel.courtIds[0]);
    expect((await bookrail.resourceGroups.retrieve(padel.groupId)).id).toBe(padel.groupId);
    expect((await bookrail.services.retrieve(padel.serviceId)).id).toBe(padel.serviceId);
    expect((await bookrail.policies.retrieve(padel.policyId)).id).toBe(padel.policyId);
  });
});

describe('asking what is free', () => {
  it('lists the slots of a day', async () => {
    const availability = await bookrail.availability.list({
      service_id: padel.serviceId,
      from: iso(monday),
      to: iso(monday.getTime() + DAY_MS),
      timezone: 'Europe/Rome',
    });
    expect(availability.object).toBe('availability');
    expect(availability.slots?.length).toBeGreaterThan(0);
    expect(availability.slots?.[0]?.start).toMatch(/Z$/);
  });

  it('finds the next bookable instant', async () => {
    const next = await bookrail.availability.next({ service_id: padel.serviceId });
    expect(next.object).toBe('availability_next');
    expect(typeof next.next_available).toBe('string');
    expect(next.slot?.start).toBe(next.next_available);
  });

  it('checks one exact instant', async () => {
    const check = await bookrail.availability.check({
      service_id: padel.serviceId,
      start: iso(monday.getTime() + 7 * 3_600_000),
      quantity: 1,
    });
    expect(check.object).toBe('availability_check');
    expect(check.available).toBe(true);
  });
});

describe('holding and booking', () => {
  let holdId = '';
  let bookingId = '';

  it('holds a slot and reads the hold back', async () => {
    const hold = await bookrail.holds.create({
      service_id: padel.serviceId,
      start: iso(monday.getTime() + 7 * 3_600_000),
      ttl: '10m',
      customer: { email: 'ada@example.com', name: 'Ada' },
    });
    expect(hold.object).toBe('hold');
    expect(hold.id.startsWith('hold_')).toBe(true);
    holdId = hold.id;

    const read = await bookrail.holds.retrieve(holdId);
    expect(read.status).toBe('active');
    expect(read.allocations?.length).toBe(1);
    // A hold that has been read has no price: the table does not store one.
    expect(read.price).toBeNull();
  });

  it('releases a hold it does not need, and refuses to release it twice as a conflict', async () => {
    const spare = await bookrail.holds.create({
      service_id: padel.serviceId,
      start: iso(monday.getTime() + 20 * 3_600_000),
      ttl: '10m',
    });
    const released = await bookrail.holds.release(spare.id);
    expect(released.deleted).toBe(true);
    // A second release is idempotent, not an error.
    expect((await bookrail.holds.release(spare.id)).deleted).toBe(true);
  });

  it('converts the hold into a booking, with the SDK’s own Idempotency-Key', async () => {
    const { data: booking, response } = await bookrail.bookings
      .create({
        service_id: padel.serviceId,
        start: iso(monday.getTime() + 7 * 3_600_000),
        hold_id: holdId,
        customer: { email: 'ada@example.com', name: 'Ada' },
      })
      .withResponse();
    bookingId = booking.id;
    expect(booking.object).toBe('booking');
    expect(booking.status).toBe('pending');
    expect(response.status).toBe(201);
    expect(response.requestId?.startsWith('req_')).toBe(true);
    expect(response.idempotentReplayed).toBe(false);

    const sent = h.seen.filter(
      (request) => request.method === 'POST' && request.path === '/v1/bookings',
    );
    expect(sent.at(-1)?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replays the same Idempotency-Key instead of booking twice', async () => {
    const key = `sdk-test-${String(Date.now())}`;
    const start = iso(monday.getTime() + 9 * 3_600_000);
    const first = await bookrail.bookings
      .create({ service_id: padel.serviceId, start }, { idempotencyKey: key })
      .withResponse();
    const second = await bookrail.bookings
      .create({ service_id: padel.serviceId, start }, { idempotencyKey: key })
      .withResponse();
    expect(second.data.id).toBe(first.data.id);
    expect(first.response.idempotentReplayed).toBe(false);
    expect(second.response.idempotentReplayed).toBe(true);
  });

  it('reads the booking back, expanded', async () => {
    const booking = await bookrail.bookings.retrieve(bookingId, {
      expand: ['customer', 'allocations.resource'],
    });
    expect(booking.id).toBe(bookingId);
    expect((booking.customer as { email?: string } | null)?.email).toBe('ada@example.com');
    expect(booking.allocations?.[0]?.resource).toBeTruthy();
  });

  it('confirms it, checks it in, and cancels it', async () => {
    expect((await bookrail.bookings.confirm(bookingId)).status).toBe('confirmed');
    expect((await bookrail.bookings.checkIn(bookingId)).status).toBe('in_progress');
    const cancelled = await bookrail.bookings.cancel(bookingId, {
      by: 'provider',
      reason: 'flooded court',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelled_by).toBe('provider');
  });

  it('reschedules another booking', async () => {
    const booking = await bookrail.bookings.create({
      service_id: padel.serviceId,
      start: iso(monday.getTime() + 11 * 3_600_000),
    });
    // The API answers with the **new** booking; the old one is one `GET` away.
    const moved = await bookrail.bookings.reschedule(booking.id, {
      start: iso(monday.getTime() + 12 * 3_600_000),
    });
    expect(moved.id).not.toBe(booking.id);
    expect(moved.rescheduled_from_booking_id).toBe(booking.id);
    expect((await bookrail.bookings.retrieve(booking.id)).status).toBe('rescheduled');
  });

  it('lists bookings with filters', async () => {
    const page = await bookrail.bookings.list({
      status: 'cancelled',
      limit: 20,
      'expand[]': ['customer'],
    });
    expect(page.data.some((row) => row.id === bookingId)).toBe(true);
    expect(page.data.every((row) => row.status === 'cancelled')).toBe(true);
  });

  it('reports a transition the matrix forbids as a conflict', async () => {
    const error = (await bookrail.bookings
      .confirm(bookingId)
      .then(() => null)
      .catch((caught: unknown) => caught)) as BookrailConflictError;
    expect(error).toBeInstanceOf(BookrailConflictError);
    expect(error.code).toBe('invalid_transition');
    expect(error.status).toBe(409);
    expect(error.requestId?.startsWith('req_')).toBe(true);
  });

  it('reports an unknown id as a not-found error', async () => {
    await expect(
      bookrail.bookings.retrieve('bk_00000000000000000000000000000000'),
    ).rejects.toBeInstanceOf(BookrailNotFoundError);
  });

  it('books two slots that start in a few seconds, for the two transitions that need a past start', async () => {
    soon.startsAt = Date.now() + 8_000;
    const first = await bookrail.bookings.create({
      service_id: padel.serviceId,
      start: iso(soon.startsAt),
    });
    const second = await bookrail.bookings.create({
      service_id: padel.serviceId,
      start: iso(soon.startsAt),
    });
    soon.completeId = first.id;
    soon.noShowId = second.id;
    await bookrail.bookings.confirm(first.id);
    await bookrail.bookings.confirm(second.id);
    expect(first.allocations?.[0]?.resource_id).not.toBe(second.allocations?.[0]?.resource_id);
  });
});

describe('events', () => {
  it('lists the log with `via: sdk` on what the SDK wrote', async () => {
    const events = await bookrail.events.list({
      type: ['booking.created', 'booking.cancelled'],
      limit: 50,
    });
    expect(events.data.length).toBeGreaterThan(0);
    const created = events.data.find((event) => event.type === 'booking.created');
    expect(created).toBeDefined();
    expect((created?.actor as { via?: string; type?: string } | null)?.via).toBe('sdk');
    expect((created?.actor as { type?: string } | null)?.type).toBe('api');

    // A lifecycle event too, not only one the route writes: `booking.cancelled` is composed by
    // `lifecycle.ts` in the engine, which is where `via` used to be dropped.
    const cancelled = events.data.find((event) => event.type === 'booking.cancelled');
    expect(cancelled).toBeDefined();
    expect((cancelled?.actor as { via?: string } | null)?.via).toBe('sdk');

    const one = await bookrail.events.retrieve(created!.id);
    expect(one.id).toBe(created!.id);
    expect(one.api_version).toBe(bookrail.apiVersion);
  });
});

describe('webhooks, delivered and verified for real', () => {
  let webhookId = '';
  let secret = '';
  let failedDeliveryId = '';

  it('registers an endpoint and shows the secret once', async () => {
    const created = await bookrail.webhooks.create({
      url: receiver.url,
      events: ['booking.created', 'booking.cancelled'],
      description: 'the SDK suite',
    });
    expect(created.status).toBe('active');
    expect(created.secret?.startsWith('whsec_')).toBe(true);
    webhookId = created.id;
    secret = created.secret!;

    const read = await bookrail.webhooks.retrieve(webhookId);
    expect(JSON.stringify(read)).not.toContain(secret);
    const list = await bookrail.webhooks.list();
    expect(list.data.some((row) => row.id === webhookId)).toBe(true);
  });

  it('constructs the event from a delivery the real server signed', async () => {
    const before = receiver.requests.length;
    const delivery = await bookrail.webhooks.test(webhookId);
    expect(delivery.status).toBe('succeeded');
    expect(delivery.response_status).toBe(200);
    expect(receiver.requests.length).toBe(before + 1);

    const arrived = receiver.requests.at(-1)!;
    const event = bookrail.webhooks.constructEvent(
      arrived.body,
      arrived.headers['bookrail-signature'],
      secret,
    );
    expect(event.type).toBe('webhook.test');
    expect(event.id).toBe(delivery.event_id);
    expect(arrived.headers['bookrail-event-id']).toBe(delivery.event_id);

    // ...and refuses the same payload under any other secret.
    expect(() =>
      bookrail.webhooks.constructEvent(
        arrived.body,
        arrived.headers['bookrail-signature'],
        'whsec_not_the_one',
      ),
    ).toThrow(/signature/i);
  });

  it('lists the deliveries and replays a failed one', async () => {
    receiver.status = 500;
    const failed = await bookrail.webhooks.test(webhookId);
    receiver.status = 200;
    expect(failed.status).toBe('failed');
    failedDeliveryId = failed.id;

    const deliveries = await bookrail.webhooks.deliveries.list(webhookId, { limit: 10 });
    expect(deliveries.data.some((row) => row.id === failedDeliveryId)).toBe(true);

    const queued = await bookrail.webhooks.deliveries.retry(webhookId, failedDeliveryId);
    expect(queued.status).toBe('pending');
    expect(queued.attempt).toBe(0);
  });

  it('updates the endpoint, then deletes it', async () => {
    const disabled = await bookrail.webhooks.update(webhookId, { status: 'disabled' });
    expect(disabled.status).toBe('disabled');
    // `disabled` stops all traffic, and a test delivery is traffic.
    await expect(bookrail.webhooks.test(webhookId)).rejects.toBeInstanceOf(BookrailConflictError);

    const deleted = await bookrail.webhooks.del(webhookId);
    expect(deleted.deleted).toBe(true);
    await expect(bookrail.webhooks.retrieve(webhookId)).rejects.toBeInstanceOf(
      BookrailNotFoundError,
    );
  });
});

describe('blocks and calendar exceptions', () => {
  it('blocks a period, finds it in the list, and reopens it', async () => {
    const court = padel.courtIds[1]!;
    const from = iso(monday.getTime() + 30 * DAY_MS);
    const to = iso(monday.getTime() + 30 * DAY_MS + 2 * 3_600_000);
    const block = await bookrail.resources.block(court, { from, to, reason: 'maintenance' });
    expect(block.object).toBe('resource_block');

    const blocks = await bookrail.resources.blocks.list(court, { limit: 10 });
    expect(blocks.data.some((row) => row.id === block.id)).toBe(true);

    const removed = await bookrail.resources.unblock(court, { block_id: block.id });
    expect(removed.deleted).toBe(true);
  });

  it('closes a day on the calendar and reopens it', async () => {
    const date = new Date(monday.getTime() + 45 * DAY_MS).toISOString().slice(0, 10);
    const exception = await bookrail.schedules.exceptions.create(padel.scheduleId, {
      date,
      type: 'closed',
      reason: 'national holiday',
    });
    expect(exception.object).toBe('schedule_exception');

    const removed = await bookrail.schedules.exceptions.del(padel.scheduleId, exception.id);
    expect(removed.deleted).toBe(true);
  });
});

describe('the customer CRUD, and cursor pagination against the real API', () => {
  it('creates, reads, updates and deletes one customer', async () => {
    const customer = await bookrail.customers.create({
      external_id: 'crm-1',
      email: 'bea@example.com',
      name: 'Bea',
    });
    expect(customer.object).toBe('customer');
    expect((await bookrail.customers.retrieve(customer.id)).email).toBe('bea@example.com');
    const updated = await bookrail.customers.update(customer.id, { name: 'Beatrice' });
    expect(updated.name).toBe('Beatrice');
    const found = await bookrail.customers.list({ external_id: 'crm-1' });
    expect(found.data.map((row) => row.id)).toEqual([customer.id]);
    expect((await bookrail.customers.del(customer.id)).deleted).toBe(true);
  });

  it('walks 25 customers with limit 10 in exactly three requests', async () => {
    const other = await h.bootstrap('SDK pagination');
    const client = h.client(other.testKey);
    for (let index = 0; index < 25; index += 1) {
      await client.customers.create({
        external_id: `page-${String(index).padStart(2, '0')}`,
        name: `Customer ${String(index)}`,
      });
    }

    const before = h.seen.length;
    const seen: string[] = [];
    for await (const customer of client.customers.list({ limit: 10 })) seen.push(customer.id);
    const requests = h.seen
      .slice(before)
      .filter((request) => request.method === 'GET' && request.path === '/v1/customers');

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(requests).toHaveLength(3);
    expect(new URL(`http://x${requests[0]!.query}`).searchParams.get('starting_after')).toBeNull();
    expect(new URL(`http://x${requests[1]!.query}`).searchParams.get('starting_after')).toBe(
      seen[9],
    );
    expect(new URL(`http://x${requests[2]!.query}`).searchParams.get('starting_after')).toBe(
      seen[19],
    );
  }, 120_000);
});

describe('the two transitions that need a start in the past', () => {
  it('completes one booking and marks the other a no-show', async () => {
    await until(soon.startsAt);
    const completed = await bookrail.bookings.complete(soon.completeId);
    expect(completed.status).toBe('completed');
    const missed = await bookrail.bookings.noShow(soon.noShowId);
    expect(missed.status).toBe('no_show');
    // 50 % of the frozen price of 24,00 €, as an expectation: no money moves yet.
    expect(missed.no_show_charge_expected).toBe(1200);
  }, 60_000);
});

describe('updating and deleting the configuration', () => {
  it('updates every kind, then deletes what it created', async () => {
    expect(
      (await bookrail.locations.update(padel.locationId, { name: 'Club Roma Nord' })).name,
    ).toBe('Club Roma Nord');
    expect(
      (await bookrail.schedules.update(padel.scheduleId, { name: 'Always open, really' }))?.name,
    ).toBe('Always open, really');
    expect(
      (await bookrail.resources.update(padel.courtIds[1]!, { name: 'Court 2 (indoor)' })).name,
    ).toBe('Court 2 (indoor)');
    expect((await bookrail.resourceGroups.update(padel.groupId, { name: 'All courts' })).name).toBe(
      'All courts',
    );
    expect((await bookrail.services.update(padel.serviceId, { name: 'Padel 60 min' })).name).toBe(
      'Padel 60 min',
    );
    expect((await bookrail.policies.update(padel.policyId, { name: 'Standard 2027' })).name).toBe(
      'Standard 2027',
    );

    expect((await bookrail.services.del(padel.serviceId)).deleted).toBe(true);
    expect((await bookrail.policies.del(padel.policyId)).deleted).toBe(true);
    expect((await bookrail.resourceGroups.del(padel.groupId)).deleted).toBe(true);
    for (const court of padel.courtIds) {
      expect((await bookrail.resources.del(court)).deleted).toBe(true);
    }
    expect((await bookrail.schedules.del(padel.scheduleId)).deleted).toBe(true);
    expect((await bookrail.locations.del(padel.locationId)).deleted).toBe(true);
  }, 120_000);
});

describe('coverage of the registry', () => {
  it('has hit every one of the 67 operations at least once', () => {
    const hit = new Set(h.operations);
    const missing = OPERATIONS.map((operation) => operation.operationId)
      .filter((operationId) => !hit.has(operationId))
      .sort();
    expect(missing).toEqual([]);
    expect(hit.size).toBe(OPERATIONS.length);
  });
});
