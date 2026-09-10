import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@bookrail/shared';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';

interface ListBody<T = Record<string, unknown>> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

interface ErrorBody {
  error: { type: string; code: string; message: string; param?: string };
}

describe('CRUD endpoints', () => {
  let h: Harness;
  let p: BootstrappedProject;
  let token: string;

  beforeAll(async () => {
    h = createHarness();
    p = await h.bootstrap('CRUD project');
    token = p.testKey;
  });

  afterAll(async () => {
    await h.close();
  });

  describe('locations', () => {
    it('creates, reads, updates and deletes', async () => {
      const created = await h.call<{ id: string; name: string; timezone: string; object: string }>(
        'POST',
        '/v1/locations',
        { token, body: { name: 'Padel Roma', timezone: 'Europe/Rome', metadata: { code: 'RM' } } },
      );
      expect(created.status).toBe(201);
      expect(created.body.object).toBe('location');
      expect(created.body.id).toMatch(/^loc_[0-9a-f]{32}$/);

      const read = await h.call<{ name: string; metadata: Record<string, unknown> }>(
        'GET',
        `/v1/locations/${created.body.id}`,
        { token },
      );
      expect(read.status).toBe(200);
      expect(read.body.name).toBe('Padel Roma');
      expect(read.body.metadata).toEqual({ code: 'RM' });

      const patched = await h.call<{ name: string; timezone: string }>(
        'PATCH',
        `/v1/locations/${created.body.id}`,
        { token, body: { name: 'Padel Roma Nord' } },
      );
      expect(patched.status).toBe(200);
      expect(patched.body.name).toBe('Padel Roma Nord');
      expect(patched.body.timezone).toBe('Europe/Rome');

      const deleted = await h.call<{ deleted: boolean }>(
        'DELETE',
        `/v1/locations/${created.body.id}`,
        { token },
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body.deleted).toBe(true);

      const gone = await h.call('GET', `/v1/locations/${created.body.id}`, { token });
      expect(gone.status).toBe(404);
    });

    it('paginates with a cursor', async () => {
      const fresh = await h.bootstrap('Pagination project');
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await h.call<{ id: string }>('POST', '/v1/locations', {
          token: fresh.testKey,
          body: { name: `Site ${i}`, timezone: 'UTC' },
        });
        ids.push(res.body.id);
      }

      const first = await h.call<ListBody<{ id: string }>>('GET', '/v1/locations?limit=2', {
        token: fresh.testKey,
      });
      expect(first.body.object).toBe('list');
      expect(first.body.data.map((d) => d.id)).toEqual(ids.slice(0, 2));
      expect(first.body.has_more).toBe(true);

      const secondPage = await h.call<ListBody<{ id: string }>>(
        'GET',
        `/v1/locations?limit=2&starting_after=${ids[1]}`,
        { token: fresh.testKey },
      );
      expect(secondPage.body.data.map((d) => d.id)).toEqual(ids.slice(2, 4));
      expect(secondPage.body.has_more).toBe(true);

      const lastPage = await h.call<ListBody<{ id: string }>>(
        'GET',
        `/v1/locations?limit=2&starting_after=${ids[3]}`,
        { token: fresh.testKey },
      );
      expect(lastPage.body.data.map((d) => d.id)).toEqual(ids.slice(4));
      expect(lastPage.body.has_more).toBe(false);
    });
  });

  /**
   * Regression: the twelve composite foreign keys used the bare `ON DELETE SET NULL`, which
   * nulls every referencing column, including project_id and environment, both NOT NULL. The
   * three DELETE endpoints below were unusable as soon as the object was referenced.
   */
  describe('deleting a referenced object', () => {
    it('deletes a location and nulls the reference on the resource', async () => {
      const location = await h.call<{ id: string }>('POST', '/v1/locations', {
        token,
        body: { name: 'To be removed', timezone: 'Europe/Rome' },
      });
      const resource = await h.call<{ id: string; location_id: string }>('POST', '/v1/resources', {
        token,
        body: { name: 'Attached court', location_id: location.body.id },
      });
      expect(resource.body.location_id).toBe(location.body.id);

      const deleted = await h.call<{ deleted: boolean }>(
        'DELETE',
        `/v1/locations/${location.body.id}`,
        { token },
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body.deleted).toBe(true);

      const after = await h.call<{ location_id: string | null; environment: string }>(
        'GET',
        `/v1/resources/${resource.body.id}`,
        { token },
      );
      expect(after.status).toBe(200);
      expect(after.body.location_id).toBeNull();
      // The scope columns must survive: only the reference is nulled.
      expect(after.body.environment).toBe('test');
    });

    it('deletes a schedule and nulls the reference on the resource', async () => {
      const schedule = await h.call<{ id: string }>('POST', '/v1/schedules', {
        token,
        body: { name: 'Doomed schedule' },
      });
      const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
        token,
        body: { name: 'Scheduled court', schedule_id: schedule.body.id },
      });

      const deleted = await h.call('DELETE', `/v1/schedules/${schedule.body.id}`, { token });
      expect(deleted.status).toBe(200);

      const after = await h.call<{ schedule_id: string | null; environment: string }>(
        'GET',
        `/v1/resources/${resource.body.id}`,
        { token },
      );
      expect(after.body.schedule_id).toBeNull();
      expect(after.body.environment).toBe('test');
    });

    it('deletes a policy and nulls the reference on the service', async () => {
      const policy = await h.call<{ id: string }>('POST', '/v1/policies', {
        token,
        body: { name: 'Doomed policy' },
      });
      const service = await h.call<{ id: string; policy_id: string }>('POST', '/v1/services', {
        token,
        body: { name: 'Attached service', duration: 30, policy_id: policy.body.id },
      });
      expect(service.body.policy_id).toBe(policy.body.id);

      const deleted = await h.call('DELETE', `/v1/policies/${policy.body.id}`, { token });
      expect(deleted.status).toBe(200);

      const after = await h.call<{ policy_id: string | null; environment: string }>(
        'GET',
        `/v1/services/${service.body.id}`,
        { token },
      );
      expect(after.body.policy_id).toBeNull();
      expect(after.body.environment).toBe('test');
    });
  });

  describe('policies', () => {
    it('round trips the commercial rules', async () => {
      const created = await h.call<{
        id: string;
        cancellation: unknown[];
        hold_duration_seconds: number;
      }>('POST', '/v1/policies', {
        token,
        body: {
          name: 'Standard',
          cancellation: [
            { before: '48h', refund_percent: 100 },
            { before: '24h', refund_percent: 50 },
          ],
          payment_timing: 'at_booking',
          hold_duration_seconds: 900,
        },
      });
      expect(created.status).toBe(201);
      expect(created.body.cancellation).toHaveLength(2);
      expect(created.body.hold_duration_seconds).toBe(900);

      const patched = await h.call<{ payment_timing: string }>(
        'PATCH',
        `/v1/policies/${created.body.id}`,
        { token, body: { payment_timing: 'none' } },
      );
      expect(patched.body.payment_timing).toBe('none');

      const read = await h.call<{ id: string; payment_timing: string }>(
        'GET',
        `/v1/policies/${created.body.id}`,
        { token },
      );
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ id: created.body.id, payment_timing: 'none' });

      const list = await h.call<ListBody>('GET', '/v1/policies', { token });
      expect(list.body.data.length).toBeGreaterThan(0);

      const deleted = await h.call('DELETE', `/v1/policies/${created.body.id}`, { token });
      expect(deleted.status).toBe(200);
    });

    it('rejects an out of range hold duration', async () => {
      const res = await h.call('POST', '/v1/policies', {
        token,
        body: { name: 'Bad', hold_duration_seconds: 5 },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('services', () => {
    /**
     * `slot_interval` and `align_to` used to be `optional`, so the serializer answered `null`
     * for a service without a grid while the request refused one: a value already stored could
     * not be removed, and a declarative tool could not push "this service has no grid"
     * They are `nullish` now, and this is what that means.
     */
    it('removes the slot grid when slot_interval and align_to are sent as null', async () => {
      const created = await h.call<{ id: string; slot_interval: number; align_to: string }>(
        'POST',
        '/v1/services',
        { token, body: { name: 'Gridded', duration: 60, slot_interval: 30, align_to: 'hour' } },
      );
      expect(created.status).toBe(201);
      expect(created.body.slot_interval).toBe(30);
      expect(created.body.align_to).toBe('hour');

      const cleared = await h.call<{ slot_interval: number | null; align_to: string | null }>(
        'PATCH',
        `/v1/services/${created.body.id}`,
        { token, body: { slot_interval: null, align_to: null } },
      );
      expect(cleared.status).toBe(200);
      expect(cleared.body.slot_interval).toBeNull();
      expect(cleared.body.align_to).toBeNull();

      const read = await h.call<{ slot_interval: number | null; align_to: string | null }>(
        'GET',
        `/v1/services/${created.body.id}`,
        { token },
      );
      expect(read.body.slot_interval).toBeNull();
      expect(read.body.align_to).toBeNull();

      await h.call('DELETE', `/v1/services/${created.body.id}`, { token });
    });

    it('accepts a creation that declares no grid explicitly', async () => {
      const created = await h.call<{ id: string; slot_interval: number | null }>(
        'POST',
        '/v1/services',
        { token, body: { name: 'Free', duration: 45, slot_interval: null, align_to: null } },
      );
      expect(created.status).toBe(201);
      expect(created.body.slot_interval).toBeNull();
      await h.call('DELETE', `/v1/services/${created.body.id}`, { token });
    });

    it('still refuses a slot_interval that is not a positive integer', async () => {
      const res = await h.call('POST', '/v1/services', {
        token,
        body: { name: 'Bad', duration: 60, slot_interval: 0 },
      });
      expect(res.status).toBe(400);
    });

    // --- Pricing rules ----------------------------------------------------------------------

    it('stores pricing rules and hands them back unchanged', async () => {
      const rules = [
        { when: { days: ['sat', 'sun'] }, price: 3500, label: 'Weekend' },
        { when: { time_from: '18:00', time_to: '22:00' }, price_add: 500 },
        { when: { duration_min: 90 }, price_multiplier: 1.4 },
      ];
      const created = await h.call<{ id: string; pricing_rules: unknown[] }>(
        'POST',
        '/v1/services',
        {
          token,
          body: {
            name: 'Priced',
            duration: 60,
            price: { amount: 3000, currency: 'EUR' },
            pricing_rules: rules,
          },
        },
      );
      expect(created.status).toBe(201);
      expect(created.body.pricing_rules).toEqual(rules);

      const read = await h.call<{ pricing_rules: unknown[] }>(
        'GET',
        `/v1/services/${created.body.id}`,
        { token },
      );
      expect(read.body.pricing_rules).toEqual(rules);

      const cleared = await h.call<{ pricing_rules: unknown[] }>(
        'PATCH',
        `/v1/services/${created.body.id}`,
        { token, body: { pricing_rules: [] } },
      );
      expect(cleared.status).toBe(200);
      expect(cleared.body.pricing_rules).toEqual([]);
      await h.call('DELETE', `/v1/services/${created.body.id}`, { token });
    });

    /**
     * The `param` of a malformed rule names it by index, `pricing_rules[3].when.time_from`,
     * not `pricing_rules.3.when.time_from`: nothing a caller holds (a JSON pointer, a
     * JavaScript expression, a `jq` filter) reads the dotted form.
     */
    it('refuses a malformed rule with a param that names its index', async () => {
      const res = await h.call<ErrorBody>('POST', '/v1/services', {
        token,
        body: {
          name: 'Bad rules',
          duration: 60,
          price: { amount: 3000, currency: 'EUR' },
          pricing_rules: [
            { when: { days: ['sat'] }, price: 3500 },
            { when: { days: ['sun'] }, price: 3500 },
            { when: { days: ['mon'] }, price: 3500 },
            { when: { time_from: '25:00', time_to: '02:00' }, price: 3500 },
          ],
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('parameter_invalid');
      expect(res.body.error.param).toBe('pricing_rules[3].when.time_from');
    });

    it.each([
      ['an unknown condition', { when: { customer_tag: 'member' }, price: 100 }],
      ['no effect at all', { when: { days: ['sat'] } }],
      ['two effects', { when: { days: ['sat'] }, price: 100, price_add: 100 }],
      ['an empty when', { when: {}, price: 100 }],
      ['a bare uuid as resource_id', { when: { resource_id: uuidv7() }, price: 100 }],
      ['a five decimal multiplier', { when: { days: ['sat'] }, price_multiplier: 1.23456 }],
    ])('refuses %s', async (_title, rule) => {
      const res = await h.call<ErrorBody>('POST', '/v1/services', {
        token,
        body: {
          name: 'Bad rule',
          duration: 60,
          price: { amount: 3000, currency: 'EUR' },
          pricing_rules: [rule],
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.param?.startsWith('pricing_rules[0]')).toBe(true);
    });

    it('refuses rules on a service that has no price, on create and on patch', async () => {
      const created = await h.call<ErrorBody>('POST', '/v1/services', {
        token,
        body: {
          name: 'No price',
          duration: 60,
          pricing_rules: [{ when: { days: ['sat'] }, price: 3500 }],
        },
      });
      expect(created.status).toBe(400);
      expect(created.body.error.param).toBe('pricing_rules');
      expect(created.body.error.message).toContain('without a price');

      const priced = await h.call<{ id: string }>('POST', '/v1/services', {
        token,
        body: {
          name: 'Priced then stripped',
          duration: 60,
          price: { amount: 3000, currency: 'EUR' },
          pricing_rules: [{ when: { days: ['sat'] }, price: 3500 }],
        },
      });
      expect(priced.status).toBe(201);

      const stripped = await h.call<ErrorBody>('PATCH', `/v1/services/${priced.body.id}`, {
        token,
        body: { price: null },
      });
      expect(stripped.status).toBe(400);
      expect(stripped.body.error.param).toBe('pricing_rules');

      // The refused PATCH left nothing behind: the price is still there.
      const read = await h.call<{ price: { amount: number } | null }>(
        'GET',
        `/v1/services/${priced.body.id}`,
        { token },
      );
      expect(read.body.price).toEqual({ amount: 3000, currency: 'EUR' });
      await h.call('DELETE', `/v1/services/${priced.body.id}`, { token });
    });
  });

  describe('customers', () => {
    it('upserts on external_id', async () => {
      const first = await h.call<{ id: string; name: string }>('POST', '/v1/customers', {
        token,
        body: { external_id: 'user-42', email: 'ada@example.com', name: 'Ada' },
      });
      expect(first.status).toBe(201);

      const second = await h.call<{ id: string; name: string; email: string }>(
        'POST',
        '/v1/customers',
        { token, body: { external_id: 'user-42', email: 'ada@example.com', name: 'Ada Lovelace' } },
      );
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.name).toBe('Ada Lovelace');

      const byExternal = await h.call<ListBody<{ id: string }>>(
        'GET',
        '/v1/customers?external_id=user-42',
        { token },
      );
      expect(byExternal.body.data).toHaveLength(1);
      expect(byExternal.body.data[0]?.id).toBe(first.body.id);
    });

    it('updates a customer with PATCH', async () => {
      const created = await h.call<{ id: string }>('POST', '/v1/customers', {
        token,
        body: { external_id: 'patch-me', email: 'grace@example.com', name: 'Grace' },
      });
      expect(created.status).toBe(201);

      const patched = await h.call<{ id: string; name: string; locale: string | null }>(
        'PATCH',
        `/v1/customers/${created.body.id}`,
        { token, body: { name: 'Grace Hopper', locale: 'en-US' } },
      );
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        id: created.body.id,
        name: 'Grace Hopper',
        locale: 'en-US',
      });
    });

    it('merges on upsert instead of wiping the fields the body omits', async () => {
      const first = await h.call<{ id: string }>('POST', '/v1/customers', {
        token,
        body: {
          external_id: 'merge-1',
          email: 'ada@example.com',
          phone: '+390123456',
          name: 'Ada',
          locale: 'it-IT',
        },
      });
      expect(first.status).toBe(201);

      const second = await h.call<{
        id: string;
        name: string;
        email: string | null;
        phone: string | null;
        locale: string | null;
      }>('POST', '/v1/customers', {
        token,
        body: { external_id: 'merge-1', name: 'Ada Lovelace' },
      });
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.name).toBe('Ada Lovelace');
      expect(second.body.email).toBe('ada@example.com');
      expect(second.body.phone).toBe('+390123456');
      expect(second.body.locale).toBe('it-IT');
    });

    it('still clears a field when the body sends an explicit null', async () => {
      await h.call('POST', '/v1/customers', {
        token,
        body: { external_id: 'merge-2', email: 'grace@example.com', phone: '+390000000' },
      });
      const cleared = await h.call<{ email: string | null; phone: string | null }>(
        'POST',
        '/v1/customers',
        { token, body: { external_id: 'merge-2', phone: null } },
      );
      expect(cleared.status).toBe(200);
      expect(cleared.body.phone).toBeNull();
      expect(cleared.body.email).toBe('grace@example.com');
    });

    it('creates distinct anonymous customers without external_id', async () => {
      const a = await h.call<{ id: string }>('POST', '/v1/customers', {
        token,
        body: { email: 'a@example.com' },
      });
      const b = await h.call<{ id: string }>('POST', '/v1/customers', {
        token,
        body: { email: 'a@example.com' },
      });
      expect(a.body.id).not.toBe(b.body.id);
    });

    it('validates the email', async () => {
      const res = await h.call<{ error: { param: string } }>('POST', '/v1/customers', {
        token,
        body: { email: 'not-an-email' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe('email');
    });

    it('hard deletes', async () => {
      const created = await h.call<{ id: string }>('POST', '/v1/customers', {
        token,
        body: { name: 'Temporary' },
      });
      const deleted = await h.call('DELETE', `/v1/customers/${created.body.id}`, { token });
      expect(deleted.status).toBe(200);
      const gone = await h.call('GET', `/v1/customers/${created.body.id}`, { token });
      expect(gone.status).toBe(404);
    });
  });

  describe('schedules', () => {
    it('creates a schedule with rules and manages exceptions', async () => {
      const created = await h.call<{ id: string; rules: { id: string; start_time: string }[] }>(
        'POST',
        '/v1/schedules',
        {
          token,
          body: {
            name: 'Weekdays',
            timezone: 'Europe/Rome',
            rules: [
              { days_of_week: [1, 2, 3, 4, 5], start_time: '09:00', end_time: '13:00' },
              { days_of_week: [1, 2, 3, 4, 5], start_time: '14:00', end_time: '19:00' },
            ],
          },
        },
      );
      expect(created.status).toBe(201);
      expect(created.body.rules).toHaveLength(2);
      expect(created.body.rules[0]?.start_time).toBe('09:00');

      const exception = await h.call<{ id: string; type: string }>(
        'POST',
        `/v1/schedules/${created.body.id}/exceptions`,
        { token, body: { date: '2026-08-15', type: 'closed', reason: 'Ferragosto' } },
      );
      expect(exception.status).toBe(201);
      expect(exception.body.id).toMatch(/^she_/);

      const withException = await h.call<{ exceptions: unknown[] }>(
        'GET',
        `/v1/schedules/${created.body.id}`,
        { token },
      );
      expect(withException.body.exceptions).toHaveLength(1);

      const removed = await h.call(
        'DELETE',
        `/v1/schedules/${created.body.id}/exceptions/${exception.body.id}`,
        { token },
      );
      expect(removed.status).toBe(200);

      const after = await h.call<{ exceptions: unknown[] }>(
        'GET',
        `/v1/schedules/${created.body.id}`,
        { token },
      );
      expect(after.body.exceptions).toHaveLength(0);

      const replaced = await h.call<{ rules: unknown[] }>(
        'PATCH',
        `/v1/schedules/${created.body.id}`,
        {
          token,
          body: { rules: [{ days_of_week: [6], start_time: '10:00', end_time: '18:00' }] },
        },
      );
      expect(replaced.body.rules).toHaveLength(1);

      const deleted = await h.call('DELETE', `/v1/schedules/${created.body.id}`, { token });
      expect(deleted.status).toBe(200);
    });

    it('requires start_time and end_time on an open exception', async () => {
      const schedule = await h.call<{ id: string }>('POST', '/v1/schedules', {
        token,
        body: { name: 'Exceptions' },
      });
      const res = await h.call('POST', `/v1/schedules/${schedule.body.id}/exceptions`, {
        token,
        body: { date: '2026-12-20', type: 'open' },
      });
      expect(res.status).toBe(400);
    });

    it('rejects a closed exception with only one of the two times', async () => {
      const schedule = await h.call<{ id: string }>('POST', '/v1/schedules', {
        token,
        body: { name: 'Half specified' },
      });
      for (const body of [
        { date: '2026-12-20', type: 'closed', start_time: '12:00' },
        { date: '2026-12-20', type: 'closed', end_time: '14:00' },
      ]) {
        const res = await h.call<{ error: { code: string; param?: string } }>(
          'POST',
          `/v1/schedules/${schedule.body.id}/exceptions`,
          { token, body },
        );
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('parameter_invalid');
      }

      // Neither time still means "the whole day" and is accepted.
      const wholeDay = await h.call('POST', `/v1/schedules/${schedule.body.id}/exceptions`, {
        token,
        body: { date: '2026-12-20', type: 'closed' },
      });
      expect(wholeDay.status).toBe(201);
    });

    /**
     * Migration 0008 dropped the two `CHECK (end_time > start_time)` of 0003. A band whose
     * end is not strictly after its start crosses midnight and finishes on the following local
     * day, and the engine has always materialized it that way; the database used to
     * refuse to store it and this test asserted the refusal.
     */
    it('accepts a rule that crosses midnight, and one that spans the whole day', async () => {
      const night = await h.call<{ rules: { start_time: string; end_time: string }[] }>(
        'POST',
        '/v1/schedules',
        {
          token,
          body: {
            name: 'Night bar',
            rules: [{ days_of_week: [1], start_time: '22:00', end_time: '02:00' }],
          },
        },
      );
      expect(night.status).toBe(201);
      expect(night.body.rules[0]).toMatchObject({ start_time: '22:00', end_time: '02:00' });

      const wholeDay = await h.call('POST', '/v1/schedules', {
        token,
        body: {
          name: 'Always open',
          rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '00:00', end_time: '00:00' }],
        },
      });
      expect(wholeDay.status).toBe(201);

      const overnightClosure = await h.call<{ id: string }>('POST', '/v1/schedules', {
        token,
        body: { name: 'With an overnight closure' },
      });
      const exception = await h.call(
        'POST',
        `/v1/schedules/${overnightClosure.body.id}/exceptions`,
        {
          token,
          body: { date: '2026-08-15', type: 'closed', start_time: '23:00', end_time: '02:00' },
        },
      );
      expect(exception.status).toBe(201);
    });

    it('lists schedules with their rules and exceptions', async () => {
      const list = await h.call<ListBody<{ object: string; rules: unknown[] }>>(
        'GET',
        '/v1/schedules',
        { token },
      );
      expect(list.status).toBe(200);
      expect(list.body.object).toBe('list');
      expect(list.body.data.length).toBeGreaterThan(0);
      expect(list.body.data.every((row) => row.object === 'schedule')).toBe(true);
    });

    it('404s when adding an exception to a schedule of another project', async () => {
      const other = await h.bootstrap('Other schedules');
      const theirs = await h.call<{ id: string }>('POST', '/v1/schedules', {
        token: other.testKey,
        body: { name: 'Theirs' },
      });
      const res = await h.call('POST', `/v1/schedules/${theirs.body.id}/exceptions`, {
        token,
        body: { date: '2026-08-15', type: 'closed' },
      });
      expect(res.status).toBe(404);
    });
  });

  /**
   * The three collection reads the other suites reach for one by one but never list.
   *
   * They are here because a list is not the singular read repeated: it carries the `list`
   * envelope, the cursor and, for services and resource groups, the same `expand[]` the
   * singular read accepts, and for a while nothing exercised them at all (the coverage
   * check of `test/global-setup.ts` is what said so).
   */
  describe('collection reads', () => {
    it('lists services, with and without their requirements expanded', async () => {
      const created = await h.call<{ id: string }>('POST', '/v1/services', {
        token,
        body: { name: 'Listed service', duration: 60 },
      });
      expect(created.status).toBe(201);

      const plain = await h.call<ListBody<{ object: string; requirements?: unknown }>>(
        'GET',
        '/v1/services',
        { token },
      );
      expect(plain.status).toBe(200);
      expect(plain.body.data.length).toBeGreaterThan(0);
      expect(plain.body.data.every((row) => row.object === 'service')).toBe(true);
      expect(plain.body.data.every((row) => row.requirements === undefined)).toBe(true);

      const expanded = await h.call<ListBody<{ requirements?: unknown[] }>>(
        'GET',
        '/v1/services?expand[]=requirements',
        { token },
      );
      expect(expanded.status).toBe(200);
      expect(expanded.body.data.every((row) => Array.isArray(row.requirements))).toBe(true);
    });

    it('lists resource groups, with and without their resources expanded', async () => {
      const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
        token,
        body: { name: 'Grouped resource' },
      });
      const group = await h.call<{ id: string }>('POST', '/v1/resource_groups', {
        token,
        body: { name: 'Listed group', resource_ids: [resource.body.id] },
      });
      expect(group.status).toBe(201);

      const plain = await h.call<ListBody<{ object: string; resources?: unknown }>>(
        'GET',
        '/v1/resource_groups',
        { token },
      );
      expect(plain.status).toBe(200);
      expect(plain.body.data.length).toBeGreaterThan(0);
      expect(plain.body.data.every((row) => row.object === 'resource_group')).toBe(true);
      expect(plain.body.data.every((row) => row.resources === undefined)).toBe(true);

      const expanded = await h.call<ListBody<{ id: string; resources?: unknown[] }>>(
        'GET',
        '/v1/resource_groups?expand[]=resources',
        { token },
      );
      expect(expanded.status).toBe(200);
      const listed = expanded.body.data.find((row) => row.id === group.body.id);
      expect(listed?.resources).toHaveLength(1);
    });
  });
});
