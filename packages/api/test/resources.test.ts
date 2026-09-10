import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';

interface ListBody<T = Record<string, unknown>> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

describe('resources, groups, services', () => {
  let h: Harness;
  let p: BootstrappedProject;
  let token: string;
  let locationId: string;
  let scheduleId: string;

  beforeAll(async () => {
    h = createHarness();
    p = await h.bootstrap('Resource project');
    token = p.testKey;

    const location = await h.call<{ id: string }>('POST', '/v1/locations', {
      token,
      body: { name: 'Club', timezone: 'Europe/Rome' },
    });
    locationId = location.body.id;

    const schedule = await h.call<{ id: string }>('POST', '/v1/schedules', {
      token,
      body: {
        name: 'Opening hours',
        rules: [{ days_of_week: [1, 2, 3, 4, 5], start_time: '08:00', end_time: '22:00' }],
      },
    });
    scheduleId = schedule.body.id;
  });

  afterAll(async () => {
    await h.close();
  });

  it('creates a resource attached to a location and a schedule', async () => {
    const created = await h.call<{
      id: string;
      capacity: number;
      location_id: string;
      schedule_id: string;
      attributes: Record<string, unknown>;
    }>('POST', '/v1/resources', {
      token,
      body: {
        name: 'Court 1',
        type: 'room',
        location_id: locationId,
        schedule_id: scheduleId,
        capacity: 1,
        attributes: { surface: 'clay' },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^res_/);
    expect(created.body.location_id).toBe(locationId);
    expect(created.body.schedule_id).toBe(scheduleId);
    expect(created.body.attributes).toEqual({ surface: 'clay' });
  });

  it('expands the schedule when asked', async () => {
    const created = await h.call<{ id: string }>('POST', '/v1/resources', {
      token,
      body: { name: 'Court 2', schedule_id: scheduleId },
    });

    const plain = await h.call<Record<string, unknown>>('GET', `/v1/resources/${created.body.id}`, {
      token,
    });
    expect(plain.body.schedule).toBeUndefined();

    const expanded = await h.call<{ schedule: { id: string; rules: unknown[] } }>(
      'GET',
      `/v1/resources/${created.body.id}?expand[]=schedule`,
      { token },
    );
    expect(expanded.body.schedule.id).toBe(scheduleId);
    expect(expanded.body.schedule.rules).toHaveLength(1);
  });

  it('rejects a reference to an object of another project', async () => {
    const other = await h.bootstrap('Other resources');
    const theirLocation = await h.call<{ id: string }>('POST', '/v1/locations', {
      token: other.testKey,
      body: { name: 'Theirs', timezone: 'UTC' },
    });
    const res = await h.call('POST', '/v1/resources', {
      token,
      body: { name: 'Stolen', location_id: theirLocation.body.id },
    });
    expect(res.status).toBe(400);
  });

  it('soft deletes a resource', async () => {
    const created = await h.call<{ id: string }>('POST', '/v1/resources', {
      token,
      body: { name: 'Temporary court' },
    });
    const deleted = await h.call<{ deleted: boolean }>(
      'DELETE',
      `/v1/resources/${created.body.id}`,
      { token },
    );
    expect(deleted.body.deleted).toBe(true);

    const gone = await h.call('GET', `/v1/resources/${created.body.id}`, { token });
    expect(gone.status).toBe(404);

    const list = await h.call<ListBody<{ id: string }>>('GET', '/v1/resources?limit=100', {
      token,
    });
    expect(list.body.data.map((r) => r.id)).not.toContain(created.body.id);
  });

  describe('block and unblock', () => {
    it('blocks a period and refuses an overlapping block on a capacity-1 resource', async () => {
      const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
        token,
        body: { name: 'Maintenance court', capacity: 1 },
      });

      const block = await h.call<{ id: string; from: string; to: string; object: string }>(
        'POST',
        `/v1/resources/${resource.body.id}/block`,
        {
          token,
          body: {
            from: '2026-12-24T00:00:00Z',
            to: '2026-12-26T00:00:00Z',
            reason: 'Christmas',
          },
        },
      );
      expect(block.status).toBe(201);
      expect(block.body.object).toBe('resource_block');
      expect(block.body.from).toBe('2026-12-24T00:00:00.000Z');

      const overlapping = await h.call<{ error: { type: string; code: string } }>(
        'POST',
        `/v1/resources/${resource.body.id}/block`,
        { token, body: { from: '2026-12-25T00:00:00Z', to: '2026-12-27T00:00:00Z' } },
      );
      expect(overlapping.status).toBe(409);
      expect(overlapping.body.error.type).toBe('conflict');
      expect(overlapping.body.error.code).toBe('slot_unavailable');

      const unblocked = await h.call<{ deleted: boolean }>(
        'POST',
        `/v1/resources/${resource.body.id}/unblock`,
        { token, body: { block_id: block.body.id } },
      );
      expect(unblocked.status).toBe(200);
      expect(unblocked.body.deleted).toBe(true);

      // Now the same period is free again.
      const again = await h.call('POST', `/v1/resources/${resource.body.id}/block`, {
        token,
        body: { from: '2026-12-25T00:00:00Z', to: '2026-12-27T00:00:00Z' },
      });
      expect(again.status).toBe(201);
    });

    it('still refuses overlaps after the capacity is lowered to 1', async () => {
      // The exact reproduction of the hole that was found: a block written while the resource had
      // capacity 4 carries capacity_used = 4, and the old constraint only looked at rows with
      // capacity_used = 1, so lowering the capacity afterwards opened a hole.
      const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
        token,
        body: { name: 'Shrinking court', capacity: 4 },
      });

      const first = await h.call('POST', `/v1/resources/${resource.body.id}/block`, {
        token,
        body: { from: '2027-02-01T00:00:00Z', to: '2027-02-02T00:00:00Z' },
      });
      expect(first.status).toBe(201);

      const shrunk = await h.call<{ capacity: number }>(
        'PATCH',
        `/v1/resources/${resource.body.id}`,
        { token, body: { capacity: 1 } },
      );
      expect(shrunk.status).toBe(200);
      expect(shrunk.body.capacity).toBe(1);

      const overlapping = await h.call<{ error: { type: string; code: string } }>(
        'POST',
        `/v1/resources/${resource.body.id}/block`,
        { token, body: { from: '2027-02-01T12:00:00Z', to: '2027-02-03T00:00:00Z' } },
      );
      expect(overlapping.status).toBe(409);
      expect(overlapping.body.error.code).toBe('slot_unavailable');
    });

    /**
     * A block takes the **whole** capacity of a resource, so a second overlapping block has
     * nothing left to take. This route used to write its occupancy by hand, with no
     * lock and no verification, and two overlapping blocks on a resource of capacity fifteen
     * left thirty units taken out of fifteen. It now goes
     * through `takeOccupancy` like every other writer of `occupancies`.
     */
    it('refuses a block that overlaps another one, whatever the capacity', async () => {
      const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
        token,
        body: { name: 'Yoga room', capacity: 15 },
      });
      const first = await h.call('POST', `/v1/resources/${resource.body.id}/block`, {
        token,
        body: { from: '2026-11-01T09:00:00Z', to: '2026-11-01T11:00:00Z' },
      });
      const second = await h.call<{ error: { code: string } }>(
        'POST',
        `/v1/resources/${resource.body.id}/block`,
        { token, body: { from: '2026-11-01T10:00:00Z', to: '2026-11-01T12:00:00Z' } },
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('slot_unavailable');

      // Adjacent, not overlapping: the periods are half open, so this one is fine.
      const adjacent = await h.call('POST', `/v1/resources/${resource.body.id}/block`, {
        token,
        body: { from: '2026-11-01T11:00:00Z', to: '2026-11-01T12:00:00Z' },
      });
      expect(adjacent.status).toBe(201);
    });

    it('rejects an inverted period', async () => {
      const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
        token,
        body: { name: 'Any court' },
      });
      const res = await h.call('POST', `/v1/resources/${resource.body.id}/block`, {
        token,
        body: { from: '2026-11-02T12:00:00Z', to: '2026-11-02T09:00:00Z' },
      });
      expect(res.status).toBe(400);
    });

    /**
     * `GET /v1/resources/{id}/blocks`.
     *
     * The read that makes `unblock` reachable: before it existed, a lost `blk_...` meant the
     * block could not be removed at all. The properties tested here are the ones a caller
     * depends on: the order, the default window, the cursor, and the project boundary.
     */
    describe('GET /v1/resources/{id}/blocks', () => {
      const YEAR = 2027;
      const day = (n: number): string => `${String(YEAR)}-03-${String(n).padStart(2, '0')}`;

      async function blockedResource(name: string, days: number[]): Promise<string> {
        const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
          token,
          body: { name },
        });
        for (const d of days) {
          const created = await h.call('POST', `/v1/resources/${resource.body.id}/block`, {
            token,
            body: {
              from: `${day(d)}T09:00:00Z`,
              to: `${day(d)}T11:00:00Z`,
              reason: `day ${String(d)}`,
            },
          });
          expect(created.status).toBe(201);
        }
        return resource.body.id;
      }

      it('returns the blocks of the resource, ordered by start, in the shape POST returns', async () => {
        // Created out of order on purpose: the answer is ordered by period, not by creation.
        const id = await blockedResource('Ordered court', [12, 4, 8]);
        const list = await h.call<ListBody<Record<string, unknown>>>(
          'GET',
          `/v1/resources/${id}/blocks`,
          { token },
        );
        expect(list.status).toBe(200);
        expect(list.body.object).toBe('list');
        expect(list.body.has_more).toBe(false);
        expect(list.body.data.map((row) => row.from)).toEqual([
          `${day(4)}T09:00:00.000Z`,
          `${day(8)}T09:00:00.000Z`,
          `${day(12)}T09:00:00.000Z`,
        ]);
        const first = list.body.data[0] ?? {};
        expect(first.object).toBe('resource_block');
        expect(String(first.id)).toMatch(/^blk_/);
        expect(first.resource_id).toBe(id);
        expect(first.reason).toBe('day 4');
        expect(first.metadata).toEqual({});
        expect(first.environment).toBe('test');
        expect(first.to).toBe(`${day(4)}T11:00:00.000Z`);
        expect(typeof first.created_at).toBe('string');
      });

      it('paginates on the cursor, without repeating or skipping a row', async () => {
        const id = await blockedResource('Paged court', [1, 2, 3, 4, 5]);
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          const query = `limit=2${cursor === undefined ? '' : `&starting_after=${cursor}`}`;
          const response = await h.call<ListBody<{ id: string }>>(
            'GET',
            `/v1/resources/${id}/blocks?${query}`,
            { token },
          );
          seen.push(...response.body.data.map((row) => row.id));
          if (!response.body.has_more) break;
          cursor = response.body.data.at(-1)?.id;
        }
        const whole = await h.call<ListBody<{ id: string }>>(
          'GET',
          `/v1/resources/${id}/blocks?limit=100`,
          { token },
        );
        expect(seen).toEqual(whole.body.data.map((row) => row.id));
        expect(new Set(seen).size).toBe(5);
      });

      it('defaults to the blocks that have not ended, and honours from/to', async () => {
        const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
          token,
          body: { name: 'Past and future court' },
        });
        const id = resource.body.id;
        // A block in the past can only be written by an endpoint that accepts one: this one
        // does, because closing a room yesterday is a legitimate record.
        await h.call('POST', `/v1/resources/${id}/block`, {
          token,
          body: { from: '2020-01-01T09:00:00Z', to: '2020-01-01T11:00:00Z', reason: 'over' },
        });
        await h.call('POST', `/v1/resources/${id}/block`, {
          token,
          body: { from: `${day(20)}T09:00:00Z`, to: `${day(20)}T11:00:00Z`, reason: 'coming' },
        });

        const byDefault = await h.call<ListBody<{ reason: string }>>(
          'GET',
          `/v1/resources/${id}/blocks`,
          { token },
        );
        expect(byDefault.body.data.map((row) => row.reason)).toEqual(['coming']);

        // Naming a bound turns the default off: the old block is reachable again.
        const withWindow = await h.call<ListBody<{ reason: string }>>(
          'GET',
          `/v1/resources/${id}/blocks?from=2019-01-01T00:00:00Z`,
          { token },
        );
        expect(withWindow.body.data.map((row) => row.reason)).toEqual(['over', 'coming']);

        const onlyOld = await h.call<ListBody<{ reason: string }>>(
          'GET',
          `/v1/resources/${id}/blocks?from=2019-01-01T00:00:00Z&to=2021-01-01T00:00:00Z`,
          { token },
        );
        expect(onlyOld.body.data.map((row) => row.reason)).toEqual(['over']);

        const inverted = await h.call<{ error: { code: string } }>(
          'GET',
          `/v1/resources/${id}/blocks?from=2021-01-01T00:00:00Z&to=2019-01-01T00:00:00Z`,
          { token },
        );
        expect(inverted.status).toBe(400);
        const badInstant = await h.call('GET', `/v1/resources/${id}/blocks?from=yesterday`, {
          token,
        });
        expect(badInstant.status).toBe(400);
      });

      it('stops listing a block that was lifted', async () => {
        const id = await blockedResource('Lifted court', [15]);
        const before = await h.call<ListBody<{ id: string }>>('GET', `/v1/resources/${id}/blocks`, {
          token,
        });
        const blockId = before.body.data[0]?.id ?? '';
        expect(blockId).toMatch(/^blk_/);
        const removed = await h.call('POST', `/v1/resources/${id}/unblock`, {
          token,
          body: { block_id: blockId },
        });
        expect(removed.status).toBe(200);
        const after = await h.call<ListBody<{ id: string }>>('GET', `/v1/resources/${id}/blocks`, {
          token,
        });
        expect(after.body.data).toEqual([]);
      });

      it('404s on a resource of another project, and on one that never existed', async () => {
        const other = await h.bootstrap('Other block reader');
        const theirs = await h.call<{ id: string }>('POST', '/v1/resources', {
          token: other.testKey,
          body: { name: 'Theirs' },
        });
        await h.call('POST', `/v1/resources/${theirs.body.id}/block`, {
          token: other.testKey,
          body: { from: `${day(21)}T09:00:00Z`, to: `${day(21)}T11:00:00Z` },
        });
        const foreign = await h.call('GET', `/v1/resources/${theirs.body.id}/blocks`, { token });
        expect(foreign.status).toBe(404);

        const nonsense = await h.call('GET', '/v1/resources/res_deadbeef/blocks', { token });
        expect(nonsense.status).toBe(404);
      });

      it('answers an empty page for a cursor that belongs to another resource', async () => {
        const mine = await blockedResource('Cursor court A', [22]);
        const other = await blockedResource('Cursor court B', [23]);
        const theirs = await h.call<ListBody<{ id: string }>>(
          'GET',
          `/v1/resources/${other}/blocks`,
          { token },
        );
        const foreignCursor = theirs.body.data[0]?.id ?? '';
        const page = await h.call<ListBody<{ id: string }>>(
          'GET',
          `/v1/resources/${mine}/blocks?starting_after=${foreignCursor}`,
          { token },
        );
        expect(page.status).toBe(200);
        expect(page.body.data).toEqual([]);

        const wrongKind = await h.call<{ error: { param: string } }>(
          'GET',
          `/v1/resources/${mine}/blocks?starting_after=svc_ff`,
          { token },
        );
        expect(wrongKind.status).toBe(400);
        expect(wrongKind.body.error.param).toBe('starting_after');
      });
    });

    it('404s when blocking a resource of another project', async () => {
      const other = await h.bootstrap('Other blocks');
      const theirs = await h.call<{ id: string }>('POST', '/v1/resources', {
        token: other.testKey,
        body: { name: 'Theirs' },
      });
      const res = await h.call('POST', `/v1/resources/${theirs.body.id}/block`, {
        token,
        body: { from: '2026-11-03T09:00:00Z', to: '2026-11-03T10:00:00Z' },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('resource groups', () => {
    it('creates a group with members and expands them', async () => {
      const a = await h.call<{ id: string }>('POST', '/v1/resources', {
        token,
        body: { name: 'Court A' },
      });
      const b = await h.call<{ id: string }>('POST', '/v1/resources', {
        token,
        body: { name: 'Court B' },
      });

      const group = await h.call<{ id: string; resource_ids: string[] }>(
        'POST',
        '/v1/resource_groups',
        {
          token,
          body: {
            name: 'All courts',
            allocation_strategy: 'least_busy',
            resource_ids: [a.body.id, b.body.id],
          },
        },
      );
      expect(group.status).toBe(201);
      expect(group.body.resource_ids).toEqual([a.body.id, b.body.id]);

      const expanded = await h.call<{ resources: { id: string; name: string }[] }>(
        'GET',
        `/v1/resource_groups/${group.body.id}?expand[]=resources`,
        { token },
      );
      expect(expanded.body.resources.map((r) => r.name)).toEqual(['Court A', 'Court B']);

      const replaced = await h.call<{ resource_ids: string[] }>(
        'PATCH',
        `/v1/resource_groups/${group.body.id}`,
        { token, body: { resource_ids: [b.body.id] } },
      );
      expect(replaced.body.resource_ids).toEqual([b.body.id]);

      const deleted = await h.call('DELETE', `/v1/resource_groups/${group.body.id}`, { token });
      expect(deleted.status).toBe(200);
    });

    it('rejects a member that belongs to another project', async () => {
      const other = await h.bootstrap('Other members');
      const theirs = await h.call<{ id: string }>('POST', '/v1/resources', {
        token: other.testKey,
        body: { name: 'Theirs' },
      });
      const res = await h.call<{ error: { param: string } }>('POST', '/v1/resource_groups', {
        token,
        body: { name: 'Mixed', resource_ids: [theirs.body.id] },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe('resource_ids');
    });
  });

  describe('services', () => {
    it('creates a service with requirements and expands them', async () => {
      const policy = await h.call<{ id: string }>('POST', '/v1/policies', {
        token,
        body: { name: 'Service policy' },
      });
      const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
        token,
        body: { name: 'Therapist' },
      });
      const group = await h.call<{ id: string }>('POST', '/v1/resource_groups', {
        token,
        body: { name: 'Cabins', resource_ids: [] },
      });

      const service = await h.call<{
        id: string;
        duration: number;
        price: { amount: number; currency: string };
        requirement_ids: string[];
        policy_id: string;
      }>('POST', '/v1/services', {
        token,
        body: {
          name: 'Massage 60',
          duration: 60,
          buffer_after: 15,
          price: { amount: 6000, currency: 'EUR' },
          policy_id: policy.body.id,
          requirements: [
            { resource_id: resource.body.id, quantity: 1, role: 'operator' },
            { resource_group_id: group.body.id, quantity: 1, role: 'cabin' },
          ],
        },
      });
      expect(service.status).toBe(201);
      expect(service.body.duration).toBe(60);
      expect(service.body.price).toEqual({ amount: 6000, currency: 'EUR' });
      expect(service.body.requirement_ids).toHaveLength(2);
      expect(service.body.policy_id).toBe(policy.body.id);

      const expanded = await h.call<{ requirements: { role: string }[] }>(
        'GET',
        `/v1/services/${service.body.id}?expand[]=requirements`,
        { token },
      );
      expect(expanded.body.requirements.map((r) => r.role)).toEqual(['operator', 'cabin']);

      const patched = await h.call<{ requirement_ids: string[]; buffer_after: number }>(
        'PATCH',
        `/v1/services/${service.body.id}`,
        { token, body: { buffer_after: 30, requirements: [{ resource_id: resource.body.id }] } },
      );
      expect(patched.body.buffer_after).toBe(30);
      expect(patched.body.requirement_ids).toHaveLength(1);

      const deleted = await h.call('DELETE', `/v1/services/${service.body.id}`, { token });
      expect(deleted.status).toBe(200);
      const gone = await h.call('GET', `/v1/services/${service.body.id}`, { token });
      expect(gone.status).toBe(404);
    });

    it('supports a duration range for open ended rentals', async () => {
      const service = await h.call<{ duration_range: { min: number; max: number } }>(
        'POST',
        '/v1/services',
        {
          token,
          body: {
            name: 'Car rental',
            duration_range: { min: 1440, max: 43200 },
            allow_multi_day: true,
          },
        },
      );
      expect(service.status).toBe(201);
      expect(service.body.duration_range).toEqual({ min: 1440, max: 43200 });
    });

    it('requires exactly one way of expressing the duration', async () => {
      const none = await h.call('POST', '/v1/services', { token, body: { name: 'No duration' } });
      expect(none.status).toBe(400);

      const both = await h.call('POST', '/v1/services', {
        token,
        body: { name: 'Two durations', duration: 60, duration_options: [30, 60] },
      });
      expect(both.status).toBe(400);
    });

    /**
     * The two columns migration 0008 added, plus the numeric shape settled for
     * `booking_window`: minutes and days, never duration strings.
     */
    it('round trips buffer_sharing, allow_split and the booking window', async () => {
      const created = await h.call<{
        id: string;
        buffer_sharing: boolean;
        allow_split: boolean;
        booking_window: { min_notice_minutes: number; max_advance_days: number };
      }>('POST', '/v1/services', {
        token,
        body: {
          name: 'Dinner',
          duration: 120,
          buffer_sharing: true,
          allow_split: true,
          booking_window: { min_notice_minutes: 120, max_advance_days: 30 },
        },
      });
      expect(created.status).toBe(201);
      expect(created.body.buffer_sharing).toBe(true);
      expect(created.body.allow_split).toBe(true);
      expect(created.body.booking_window).toEqual({
        min_notice_minutes: 120,
        max_advance_days: 30,
      });

      const patched = await h.call<{ buffer_sharing: boolean; allow_split: boolean }>(
        'PATCH',
        `/v1/services/${created.body.id}`,
        { token, body: { buffer_sharing: false } },
      );
      expect(patched.body.buffer_sharing).toBe(false);
      expect(patched.body.allow_split).toBe(true);

      // Both default to false, and an unknown booking_window key is refused.
      const plain = await h.call<{ buffer_sharing: boolean; allow_split: boolean }>(
        'POST',
        '/v1/services',
        { token, body: { name: 'Plain', duration: 30 } },
      );
      expect(plain.body.buffer_sharing).toBe(false);
      expect(plain.body.allow_split).toBe(false);

      const stale = await h.call('POST', '/v1/services', {
        token,
        body: { name: 'Old shape', duration: 30, booking_window: { min_notice: '2h' } },
      });
      expect(stale.status).toBe(400);
    });

    it('rejects a requirement that names neither a resource nor a group', async () => {
      const res = await h.call('POST', '/v1/services', {
        token,
        body: { name: 'Broken', duration: 30, requirements: [{ quantity: 1 }] },
      });
      expect(res.status).toBe(400);
    });
  });
});
