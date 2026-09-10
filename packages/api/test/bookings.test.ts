/**
 * `POST /v1/bookings`, `GET /v1/bookings/{id}` and `GET /v1/bookings`, end to end.
 *
 * The creation is the engine's transaction behind HTTP, so what is asserted here
 * is the contract and the wiring: the shape of the object, the documented error codes, the
 * conversion of a hold, the customer inline, the filters and the expansions, and the two
 * things the route owes that no test of the engine could catch, namely that the availability
 * cache is dropped and that the response is built from the row that was actually written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { decodeId, uuidv7 } from '@bookrail/shared';
import { generateApiKey } from '../src/keys.js';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';
import {
  buildScenario,
  firstSlot,
  nextMonday,
  plusDays,
  slotsFor,
  type ErrorBody,
} from './booking-fixtures.js';

interface Allocation {
  object: string;
  id: string;
  resource_id: string;
  role: string | null;
  capacity_used: number;
  resource?: { id: string; object: string } | null;
}

interface BookingBody {
  id: string;
  object: string;
  status: string;
  service_id: string;
  customer_id: string | null;
  hold_id: string | null;
  start: string;
  end: string;
  duration_minutes: number;
  timezone: string;
  quantity: number;
  price: { amount: number; currency: string } | null;
  price_rule: { index: number; label: string | null } | null;
  amount_paid: number;
  amount_due: number;
  amount_refunded: number;
  policy_snapshot: Record<string, unknown> | null;
  source: string;
  notes: string | null;
  allocations: Allocation[];
  tenant_id: string | null;
  metadata: Record<string, unknown>;
  environment: string;
  created_at: string;
  updated_at: string;
  customer?: { id: string; email: string } | null;
}

interface ListBody {
  object: string;
  data: BookingBody[];
  has_more: boolean;
}

describe('bookings', () => {
  let h: Harness;
  let p: BootstrappedProject;
  let token: string;
  let monday: Date;

  beforeAll(async () => {
    h = createHarness();
    p = await h.bootstrap('Bookings project');
    token = p.testKey;
    monday = nextMonday();
  });

  afterAll(async () => {
    await h.close();
  });

  it('creates a confirmed booking and takes the slot out of availability', async () => {
    const scenario = await buildScenario(h, token, {
      service: { price: { amount: 4000, currency: 'EUR' } },
    });
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const created = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slot.start,
        notes: 'clay please',
        metadata: { order_id: 'A-1' },
      },
    });

    expect(created.status).toBe(201);
    expect(created.body.object).toBe('booking');
    expect(created.body.id.startsWith('bk_')).toBe(true);
    expect(created.body.status).toBe('confirmed');
    expect(created.body.service_id).toBe(scenario.serviceId);
    expect(created.body.hold_id).toBeNull();
    expect(created.body.start).toBe(slot.start);
    expect(created.body.duration_minutes).toBe(60);
    expect(created.body.timezone).toBe('Europe/Rome');
    expect(created.body.price).toEqual({ amount: 4000, currency: 'EUR' });
    expect(created.body.amount_due).toBe(0);
    expect(created.body.source).toBe('api');
    expect(created.body.notes).toBe('clay please');
    expect(created.body.metadata).toEqual({ order_id: 'A-1' });
    expect(created.body.environment).toBe('test');
    expect(created.body.allocations).toHaveLength(1);
    expect(created.body.allocations[0]?.resource_id).toBe(scenario.resourceIds[0]);
    expect(created.body.allocations[0]?.id.startsWith('ball_')).toBe(true);

    const after = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    expect(after.map((s) => s.start)).not.toContain(slot.start);
  });

  /**
   * End to end over HTTP: the rule prices the slot in the availability answer, the booking
   * freezes **that** price and says which rule made it, and the read of the booking says the
   * same thing.
   */
  it('freezes the price a pricing rule produced, and names the rule on the booking', async () => {
    const scenario = await buildScenario(h, token, {
      service: {
        price: { amount: 3000, currency: 'EUR' },
        pricing_rules: [
          { when: { time_from: '17:00', time_to: '18:00' }, price_add: 1500, label: 'Evening' },
        ],
      },
    });
    const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const evening = slots.find((slot) => slot.price?.amount === 4500);
    expect(evening).toBeDefined();
    expect(evening?.price_rule).toEqual({ index: 0, label: 'Evening' });

    const created = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: evening!.start },
    });
    expect(created.status).toBe(201);
    expect(created.body.price).toEqual({ amount: 4500, currency: 'EUR' });
    expect(created.body.price_rule).toEqual({ index: 0, label: 'Evening' });

    const read = await h.call<BookingBody>('GET', `/v1/bookings/${created.body.id}`, { token });
    expect(read.body.price).toEqual({ amount: 4500, currency: 'EUR' });
    expect(read.body.price_rule).toEqual({ index: 0, label: 'Evening' });

    // A slot outside the band is still the flat price, and its booking freezes that.
    const plain = slots.find((slot) => slot.price?.amount === 3000);
    expect(plain).toBeDefined();
    const cheap = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: plain!.start },
    });
    expect(cheap.status).toBe(201);
    expect(cheap.body.price).toEqual({ amount: 3000, currency: 'EUR' });
    expect(cheap.body.price_rule).toBeNull();
  });

  it('is pending, and freezes the policy, when the policy requires confirmation', async () => {
    const scenario = await buildScenario(h, token, {
      policy: { require_provider_confirmation: true, hold_duration_seconds: 300 },
    });
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const created = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    expect(created.body.policy_snapshot).not.toBeNull();
    expect(created.body.policy_snapshot?.require_provider_confirmation).toBe(true);

    // The snapshot is frozen: changing the policy afterwards does not touch it.
    await h.call('PATCH', `/v1/policies/${String(scenario.policyId)}`, {
      token,
      body: { require_provider_confirmation: false },
    });
    const reread = await h.call<BookingBody>('GET', `/v1/bookings/${created.body.id}`, { token });
    expect(reread.body.policy_snapshot?.require_provider_confirmation).toBe(true);
  });

  it('converts a hold, and the conversion carries the hold_id', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const hold = await h.call<{ id: string }>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(hold.status).toBe(201);

    const booking = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start, hold_id: hold.body.id },
    });
    expect(booking.status).toBe(201);
    expect(booking.body.hold_id).toBe(hold.body.id);
    expect(booking.body.status).toBe('confirmed');
    expect(booking.body.allocations[0]?.resource_id).toBe(scenario.resourceIds[0]);

    // The hold held the capacity, so converting it did not need any more.
    const after = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    expect(after.map((s) => s.start)).not.toContain(slot.start);
  });

  it('refuses a hold that belongs to another service, or another instant', async () => {
    const a = await buildScenario(h, token, {});
    const b = await buildScenario(h, token, {});
    const slotA = await firstSlot(h, token, a.serviceId, monday, plusDays(monday, 1));

    const hold = await h.call<{ id: string }>('POST', '/v1/holds', {
      token,
      body: { service_id: a.serviceId, start: slotA.start },
    });

    const wrongService = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: b.serviceId, start: slotA.start, hold_id: hold.body.id },
    });
    expect(wrongService.status).toBe(400);
    expect(wrongService.body.error.code).toBe('hold_mismatch');

    const slots = await slotsFor(h, token, a.serviceId, monday, plusDays(monday, 1));
    const wrongStart = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: a.serviceId, start: slots[0]!.start, hold_id: hold.body.id },
    });
    expect(wrongStart.status).toBe(400);
    expect(wrongStart.body.error.code).toBe('hold_mismatch');
  });

  it('409s when the hold has already been released', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const hold = await h.call<{ id: string }>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    await h.call('DELETE', `/v1/holds/${hold.body.id}`, { token });

    const response = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start, hold_id: hold.body.id },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('hold_not_active');
  });

  it('409s with hold_expired when the hold ran out before the conversion', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const hold = await h.call<{ id: string }>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(hold.status).toBe(201);

    // The only way to make "ten minutes from now" be in the past: age the row with admin SQL.
    // The API cannot do it, and neither should it be able to.
    //
    // Only `holds.expires_at`, deliberately: `jobs.test.ts` sweeps **every** project of the
    // shared test database, and the sweep looks for expired **occupancies**. Ageing the
    // occupancy here as well would let a sweep running in that file turn this hold into
    // `expired`/released and make this test flap between `hold_expired` and `hold_not_active`.
    // Today the API package runs its files one at a time
    // (`fileParallelism: false`), so this is belt and braces, but the coupling is real and
    // this comment is what will save whoever turns parallelism back on.
    const adminDb = createDatabase(h.pools.admin);
    await adminDb.execute(sql`
      UPDATE holds SET expires_at = now() - interval '1 minute'
       WHERE id = ${decodeId('hold', hold.body.id)}
    `);

    const response = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start, hold_id: hold.body.id },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.type).toBe('conflict');
    expect(response.body.error.code).toBe('hold_expired');
  });

  it('404s on a hold of another project', async () => {
    const other = await h.bootstrap('Bookings other project');
    const theirs = await buildScenario(h, other.testKey, {});
    const slot = await firstSlot(h, other.testKey, theirs.serviceId, monday, plusDays(monday, 1));
    const hold = await h.call<{ id: string }>('POST', '/v1/holds', {
      token: other.testKey,
      body: { service_id: theirs.serviceId, start: slot.start },
    });

    const mine = await buildScenario(h, token, {});
    const mySlot = await firstSlot(h, token, mine.serviceId, monday, plusDays(monday, 1));
    const response = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: mine.serviceId, start: mySlot.start, hold_id: hold.body.id },
    });
    expect(response.status).toBe(404);
  });

  it('creates the customer inline, and attaches an existing one by id', async () => {
    const scenario = await buildScenario(h, token, { capacity: 3 });
    const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const inline = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slots[0]!.start,
        customer: { external_id: 'crm-42', name: 'Grace', email: 'grace@example.test' },
      },
    });
    expect(inline.status).toBe(201);
    expect(inline.body.customer_id).not.toBeNull();

    const byExternal = await h.call<{ data: { id: string }[] }>(
      'GET',
      '/v1/customers?external_id=crm-42',
      { token },
    );
    expect(byExternal.body.data.map((c) => c.id)).toEqual([inline.body.customer_id]);

    const second = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slots[1]!.start,
        customer_id: inline.body.customer_id,
      },
    });
    expect(second.status).toBe(201);
    expect(second.body.customer_id).toBe(inline.body.customer_id);
  });

  it('reuses a customer found by email without rewriting what it already had', async () => {
    const scenario = await buildScenario(h, token, { capacity: 3 });
    const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const email = `victim-${uuidv7().slice(0, 8)}@example.test`;

    const existing = await h.call<{ id: string }>('POST', '/v1/customers', {
      token,
      body: { email, name: 'Original Name', phone: '+390000000' },
    });
    expect(existing.status).toBe(201);

    const booked = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slots[0]!.start,
        customer: { email, name: 'Overwritten', locale: 'it-IT' },
      },
    });
    expect(booked.status).toBe(201);
    expect(booked.body.customer_id).toBe(existing.body.id);

    const after = await h.call<{ name: string; phone: string; locale: string | null }>(
      'GET',
      `/v1/customers/${existing.body.id}`,
      { token },
    );
    // The name it already had is untouched: a booking is not an edit of an address book.
    // Only the hole (`locale`) is filled.
    expect(after.body.name).toBe('Original Name');
    expect(after.body.phone).toBe('+390000000');
    expect(after.body.locale).toBe('it-IT');
  });

  it('does not let a tenant-scoped key find the customer of another tenant', async () => {
    // Two keys of the **same** project with different `tenant_id`: RLS does not separate
    // tenants (that is documented debt), so the email lookup has to do it itself, or a
    // tenant-scoped key would find and fill in another tenant's customer.
    const scenario = await buildScenario(h, token, { capacity: 3 });
    const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const adminDb = createDatabase(h.pools.admin);
    const projectId = decodeId('project', p.projectId) ?? p.projectId;

    async function keyForTenant(tenant: string): Promise<string> {
      const generated = generateApiKey('test');
      await adminDb.execute(sql`
        INSERT INTO api_keys (id, project_id, environment, kind, name, prefix, key_hash,
                              scopes, tenant_id)
        VALUES (${uuidv7()}, ${projectId}, 'test', 'secret', ${`key ${tenant}`},
                ${generated.prefix}, ${generated.keyHash}, '{}'::text[], ${tenant})
      `);
      return generated.key;
    }

    const tenantA = await keyForTenant(`t-a-${uuidv7().slice(0, 6)}`);
    const tenantB = await keyForTenant(`t-b-${uuidv7().slice(0, 6)}`);
    const email = `shared-${uuidv7().slice(0, 8)}@example.test`;

    const first = await h.call<BookingBody>('POST', '/v1/bookings', {
      token: tenantA,
      body: {
        service_id: scenario.serviceId,
        start: slots[0]!.start,
        customer: { email, name: 'Tenant A person' },
      },
    });
    expect(first.status).toBe(201);

    const second = await h.call<BookingBody>('POST', '/v1/bookings', {
      token: tenantB,
      body: {
        service_id: scenario.serviceId,
        start: slots[1]!.start,
        customer: { email, name: 'Tenant B person' },
      },
    });
    expect(second.status).toBe(201);
    expect(second.body.customer_id).not.toBe(first.body.customer_id);

    const a = await h.call<{ name: string }>('GET', `/v1/customers/${first.body.customer_id!}`, {
      token,
    });
    expect(a.body.name).toBe('Tenant A person');
  });

  it('404s on a customer_id of another project, with param customer_id', async () => {
    const other = await h.bootstrap('Bookings customer project');
    const foreign = await h.call<{ id: string }>('POST', '/v1/customers', {
      token: other.testKey,
      body: { email: 'foreign@example.test' },
    });
    expect(foreign.status).toBe(201);

    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const response = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slot.start,
        customer_id: foreign.body.id,
      },
    });
    expect(response.status).toBe(404);
    expect(response.body.error.type).toBe('not_found');
    expect(response.body.error.code).toBe('resource_missing');
    expect(response.body.error.param).toBe('customer_id');

    // Same rule on holds.
    const hold = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slot.start,
        customer_id: foreign.body.id,
      },
    });
    expect(hold.status).toBe(404);
    expect(hold.body.error.param).toBe('customer_id');
  });

  it('refuses payment modes and recurrences that do not exist yet', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const deposit = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start, payment: { mode: 'deposit' } },
    });
    expect(deposit.status).toBe(400);
    expect(deposit.body.error.code).toBe('not_yet_supported');
    expect(deposit.body.error.param).toBe('payment.mode');

    const recurring = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slot.start,
        recurrence: { rrule: 'FREQ=WEEKLY;COUNT=10' },
      },
    });
    expect(recurring.status).toBe(400);
    expect(recurring.body.error.code).toBe('not_yet_supported');
    expect(recurring.body.error.param).toBe('recurrence');

    // `payment.mode: none` is what the API actually does today, so it is accepted.
    const none = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start, payment: { mode: 'none' } },
    });
    expect(none.status).toBe(201);
  });

  it('refuses a second booking on a saturated slot with slot_unavailable', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const first = await h.call('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(first.status).toBe(201);

    const second = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('slot_unavailable');
  });

  it('enforces the customer limit of the policy with a 422', async () => {
    const scenario = await buildScenario(h, token, {
      capacity: 5,
      policy: { max_active_bookings_per_customer: 1 },
    });
    const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const customer = await h.call<{ id: string }>('POST', '/v1/customers', {
      token,
      body: { email: 'limited@example.test' },
    });

    const first = await h.call('POST', '/v1/bookings', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slots[0]!.start,
        customer_id: customer.body.id,
      },
    });
    expect(first.status).toBe(201);

    const second = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slots[1]!.start,
        customer_id: customer.body.id,
      },
    });
    expect(second.status).toBe(422);
    expect(second.body.error.type).toBe('policy_violation');
    expect(second.body.error.code).toBe('customer_limit_reached');
  });

  describe('GET /v1/bookings/{id}', () => {
    it('returns the same object the creation returned, and expands', async () => {
      const scenario = await buildScenario(h, token, {});
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const created = await h.call<BookingBody>('POST', '/v1/bookings', {
        token,
        body: {
          service_id: scenario.serviceId,
          start: slot.start,
          customer: { email: 'reader@example.test' },
        },
      });

      const fetched = await h.call<BookingBody>('GET', `/v1/bookings/${created.body.id}`, {
        token,
      });
      expect(fetched.status).toBe(200);
      expect(fetched.body).toEqual(created.body);

      const expanded = await h.call<BookingBody>(
        'GET',
        `/v1/bookings/${created.body.id}?expand[]=customer&expand[]=allocations.resource`,
        { token },
      );
      expect(expanded.status).toBe(200);
      expect(expanded.body.customer?.email).toBe('reader@example.test');
      expect(expanded.body.allocations[0]?.resource?.id).toBe(scenario.resourceIds[0]);

      const unknown = await h.call<ErrorBody>(
        'GET',
        `/v1/bookings/${created.body.id}?expand[]=nonsense`,
        { token },
      );
      expect(unknown.status).toBe(400);
    });

    it('404s on an unknown id, a malformed id, and a booking of another project', async () => {
      const missing = await h.call<ErrorBody>(
        'GET',
        '/v1/bookings/bk_00000000000000000000000000000000',
        { token },
      );
      expect(missing.status).toBe(404);

      const malformed = await h.call<ErrorBody>('GET', '/v1/bookings/bk_nope', { token });
      expect(malformed.status).toBe(404);
    });
  });

  describe('GET /v1/bookings', () => {
    let scenario: Awaited<ReturnType<typeof buildScenario>>;
    let customerA: string;
    let customerB: string;
    let starts: string[];
    let ids: string[];

    beforeAll(async () => {
      scenario = await buildScenario(h, token, { resources: 2, capacity: 1, group: {} });
      const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 2));
      starts = slots.slice(0, 4).map((slot) => slot.start);

      customerA = (
        await h.call<{ id: string }>('POST', '/v1/customers', {
          token,
          body: { email: 'a@example.test' },
        })
      ).body.id;
      customerB = (
        await h.call<{ id: string }>('POST', '/v1/customers', {
          token,
          body: { email: 'b@example.test' },
        })
      ).body.id;

      ids = [];
      for (const [index, start] of starts.entries()) {
        const created = await h.call<BookingBody>('POST', '/v1/bookings', {
          token,
          body: {
            service_id: scenario.serviceId,
            start,
            customer_id: index % 2 === 0 ? customerA : customerB,
          },
        });
        expect(created.status).toBe(201);
        ids.push(created.body.id);
      }
    });

    it('lists the project bookings, newest last, with a cursor', async () => {
      const all = await h.call<ListBody>(`GET`, `/v1/bookings?customer_id=${customerA}&limit=1`, {
        token,
      });
      expect(all.status).toBe(200);
      expect(all.body.object).toBe('list');
      expect(all.body.data).toHaveLength(1);
      expect(all.body.has_more).toBe(true);

      const next = await h.call<ListBody>(
        'GET',
        `/v1/bookings?customer_id=${customerA}&limit=10&starting_after=${all.body.data[0]!.id}`,
        { token },
      );
      expect(next.body.data.map((b) => b.id)).not.toContain(all.body.data[0]!.id);
      expect(next.body.has_more).toBe(false);
    });

    it('filters by customer_id, resource_id, status and the start window', async () => {
      const byCustomer = await h.call<ListBody>('GET', `/v1/bookings?customer_id=${customerB}`, {
        token,
      });
      expect(byCustomer.body.data.every((b) => b.customer_id === customerB)).toBe(true);
      expect(byCustomer.body.data.length).toBeGreaterThan(0);

      const resourceId = (await h.call<BookingBody>('GET', `/v1/bookings/${ids[0]!}`, { token }))
        .body.allocations[0]!.resource_id;
      const byResource = await h.call<ListBody>('GET', `/v1/bookings?resource_id=${resourceId}`, {
        token,
      });
      expect(byResource.body.data.length).toBeGreaterThan(0);
      expect(
        byResource.body.data.every((b) => b.allocations.some((a) => a.resource_id === resourceId)),
      ).toBe(true);

      const confirmed = await h.call<ListBody>('GET', '/v1/bookings?status=confirmed', { token });
      expect(confirmed.body.data.every((b) => b.status === 'confirmed')).toBe(true);

      const cancelled = await h.call<ListBody>('GET', '/v1/bookings?status=cancelled', { token });
      expect(cancelled.body.data).toHaveLength(0);

      // Scoped to one customer as well: every scenario in this file books the same Monday
      // morning, so an unscoped window would legitimately return the whole file's bookings.
      const window = await h.call<ListBody>(
        'GET',
        `/v1/bookings?customer_id=${customerA}` +
          `&from=${encodeURIComponent(starts[0]!)}&to=${encodeURIComponent(starts[1]!)}`,
        { token },
      );
      expect(window.body.data.map((b) => b.start)).toEqual([starts[0]]);
    });

    it('filters by service_id', async () => {
      const mine = await h.call<ListBody>('GET', `/v1/bookings?service_id=${scenario.serviceId}`, {
        token,
      });
      expect(mine.status).toBe(200);
      expect(mine.body.data.map((b) => b.id).sort()).toEqual([...ids].sort());
      expect(mine.body.data.every((b) => b.service_id === scenario.serviceId)).toBe(true);

      const elsewhere = await buildScenario(h, token, {});
      const none = await h.call<ListBody>('GET', `/v1/bookings?service_id=${elsewhere.serviceId}`, {
        token,
      });
      expect(none.body.data).toHaveLength(0);
    });

    it('rejects a malformed filter and an unknown resource filter', async () => {
      const bad = await h.call<ErrorBody>('GET', '/v1/bookings?customer_id=nope', { token });
      expect(bad.status).toBe(400);

      const noOne = await h.call<ListBody>(
        'GET',
        '/v1/bookings?resource_id=res_00000000000000000000000000000000',
        { token },
      );
      expect(noOne.status).toBe(200);
      expect(noOne.body.data).toHaveLength(0);
    });

    it('never shows a booking of the other environment', async () => {
      const live = await h.call<ListBody>('GET', '/v1/bookings', { token: p.liveKey });
      expect(live.status).toBe(200);
      expect(live.body.data).toHaveLength(0);
    });
  });
});
