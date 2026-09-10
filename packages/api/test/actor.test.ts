/**
 * `Bookrail-Actor`: the header a client uses to say which of Bookrail's own tools it is.
 *
 * Three properties, and they are the whole feature:
 *
 *  1. a value from the closed list is written into `events.actor.via`;
 *  2. no header means no `via` field at all, not `via: null`;
 *  3. a value outside the list is a `400 parameter_invalid` naming the header.
 *
 * The first block uses the event `POST /v1/webhooks/{id}/test` writes, because it is the one
 * event the API layer writes **itself**. The second block uses the events written inside the
 * **engine's** transaction (`booking.created`, every transition, `hold.created` and
 * `hold.released`), which until then either dropped `via` on the floor (`actorPayload()`
 * rebuilt the actor as `{type, id}`) or carried no actor at all, because `createBooking` and
 * `releaseHold` had nowhere to put one. Those are the events an audit actually reads: an
 * integration that books on somebody's behalf leaves its trace in `booking.created`, not in a
 * webhook test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@bookrail/db';
import { createHold } from '@bookrail/engine';
import { decodeId } from '@bookrail/shared';
import { createHarness, type Harness } from './harness.js';
import { startReceiver, type TestReceiver } from './webhook-receiver.js';
import { quiesceWebhooks } from './webhook-fixtures.js';
import { settleEventLog } from './event-horizon.js';
import {
  buildScenario,
  firstSlot,
  nextMonday,
  plusDays,
  slotsFor,
  type ErrorBody,
} from './booking-fixtures.js';

interface EventBody {
  id: string;
  type: string;
  actor: { type: string; id: string | null; via?: string } | null;
}

interface WebhookBody {
  id: string;
  secret?: string;
}

interface DeliveryBody {
  event_id: string;
}

describe('Bookrail-Actor', () => {
  let h: Harness;
  let token: string;
  let projectId: string;
  let receiver: TestReceiver;

  beforeAll(async () => {
    h = createHarness({ allowPrivateWebhookTargets: true });
    receiver = await startReceiver();
    const project = await h.bootstrap('actor');
    token = project.testKey;
    projectId = project.projectId;
  });

  afterAll(async () => {
    await quiesceWebhooks(h);
    await receiver.close();
    await h.close();
  });

  /** Registers an endpoint, fires `/test` with the given headers, and returns the event. */
  async function eventOfTest(headers: Record<string, string>): Promise<EventBody> {
    receiver.reset();
    const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url },
    });
    expect(created.status).toBe(201);
    const tested = await h.call<DeliveryBody>('POST', `/v1/webhooks/${created.body.id}/test`, {
      token,
      headers,
    });
    expect(tested.status).toBe(200);
    const event = await h.call<EventBody>('GET', `/v1/events/${tested.body.event_id}`, { token });
    expect(event.status).toBe(200);
    return event.body;
  }

  it('writes `via` into the event actor when the header names a known tool', async () => {
    const event = await eventOfTest({ 'bookrail-actor': 'mcp' });
    expect(event.type).toBe('webhook.test');
    expect(event.actor?.type).toBe('api');
    expect(event.actor?.id).toMatch(/^key_/);
    expect(event.actor?.via).toBe('mcp');
  });

  it('accepts every value of the closed list', async () => {
    for (const actor of ['mcp', 'cli', 'sdk', 'dashboard']) {
      const event = await eventOfTest({ 'bookrail-actor': actor });
      expect(event.actor?.via).toBe(actor);
    }
  });

  it('omits `via` entirely when no header is sent', async () => {
    const event = await eventOfTest({});
    expect(event.actor).toEqual({ type: 'api', id: expect.stringMatching(/^key_/) as string });
    // Not `null`, not `undefined` under a present key: the field is absent from the JSON.
    // (`jsonb` does not preserve key order, so the comparison is on the set.)
    expect(Object.keys(event.actor ?? {}).sort()).toEqual(['id', 'type']);
    expect('via' in (event.actor ?? {})).toBe(false);
  });

  it('refuses a value outside the list with 400 parameter_invalid', async () => {
    const response = await h.call<ErrorBody>('GET', '/v1/project', {
      token,
      headers: { 'bookrail-actor': 'curl' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('parameter_invalid');
    expect(response.body.error.param).toBe('Bookrail-Actor');
    expect(response.body.error.message).toContain('mcp, cli, sdk, dashboard');
  });

  it('refuses a bad actor before the endpoint runs, on a write as well as on a read', async () => {
    const response = await h.call<ErrorBody>('POST', '/v1/locations', {
      token,
      headers: { 'bookrail-actor': 'MCP' },
      body: { name: 'Should not exist', timezone: 'Europe/Rome' },
    });
    // The list is case sensitive: `MCP` is not `mcp`, and guessing which one the caller meant
    // is how a closed list stops being closed.
    expect(response.status).toBe(400);
    expect(response.body.error.param).toBe('Bookrail-Actor');
    const list = await h.call<{ data: { name: string }[] }>('GET', '/v1/locations', { token });
    expect(list.body.data.some((row) => row.name === 'Should not exist')).toBe(false);
  });

  it('ignores an empty header, which is what an HTTP client sends for an unset variable', async () => {
    const response = await h.call('GET', '/v1/project', {
      token,
      headers: { 'bookrail-actor': '' },
    });
    expect(response.status).toBe(200);
  });

  /**
   * The events the **engine** writes, which is where an audit trail actually lives.
   *
   * Two distinct bugs met here: the transitions carried an actor and lost
   * its `via` (the payload was rebuilt from two named fields), and the creations carried no
   * actor at all (`CreateBookingInput` had no field for one), so `booking.created`, the single
   * most important event in the system, did not say which credential wrote it.
   */
  describe('the events written inside the engine transaction', () => {
    let serviceId: string;
    let monday: Date;

    beforeAll(async () => {
      monday = nextMonday();
      const scenario = await buildScenario(h, token, {});
      serviceId = scenario.serviceId;
    });

    /** `decodeId` is nullable by contract; here the identifiers come from our own responses. */
    function bare(kind: 'project' | 'service', prefixed: string): string {
      const id = decodeId(kind, prefixed);
      if (id === null) throw new Error(`not a ${kind} id: ${prefixed}`);
      return id;
    }

    /**
     * The last event of the given type about the given object.
     *
     * `GET /v1/events` is behind a visibility horizon: an event is not listed until every
     * write transaction started before it has finished, anywhere in the Postgres cluster,
     * because `pg_snapshot_xmin` is a property of the cluster and not of one database. This
     * used to read the list again and again until something turned up, which hides the
     * difference between "the horizon had not moved yet" and "the event was never written".
     * Waiting for the horizon and then reading once keeps that difference: the list is asked
     * exactly one question, and a missing event is a missing event.
     */
    async function latestEvent(type: string, objectId: string): Promise<EventBody> {
      await settleEventLog(h);
      const list = await h.call<{ data: (EventBody & { data: { id: string } })[] }>(
        'GET',
        `/v1/events?object_id=${objectId}&type=${type}`,
        { token },
      );
      expect(list.status).toBe(200);
      const found = list.body.data.at(-1);
      if (!found) throw new Error(`no ${type} event for ${objectId}`);
      return found;
    }

    it('stamps booking.created with the credential and the declared tool', async () => {
      const slot = await firstSlot(h, token, serviceId, monday, plusDays(monday, 1));
      const created = await h.call<{ id: string }>('POST', '/v1/bookings', {
        token,
        headers: { 'bookrail-actor': 'mcp' },
        body: { service_id: serviceId, start: slot.start },
      });
      expect(created.status).toBe(201);

      const event = await latestEvent('booking.created', created.body.id);
      expect(event.actor?.type).toBe('api');
      expect(event.actor?.id).toMatch(/^key_/);
      expect(event.actor?.via).toBe('mcp');
    });

    it('omits via on a booking.created made without the header', async () => {
      const slots = await slotsFor(h, token, serviceId, monday, plusDays(monday, 1));
      const slot = slots[0];
      expect(slot).toBeDefined();
      const created = await h.call<{ id: string }>('POST', '/v1/bookings', {
        token,
        body: { service_id: serviceId, start: slot!.start },
      });
      expect(created.status).toBe(201);

      const event = await latestEvent('booking.created', created.body.id);
      expect(Object.keys(event.actor ?? {}).sort()).toEqual(['id', 'type']);
      expect('via' in (event.actor ?? {})).toBe(false);
    });

    it('carries via through a transition, which is written by the engine too', async () => {
      const slots = await slotsFor(h, token, serviceId, monday, plusDays(monday, 1));
      const slot = slots[0];
      expect(slot).toBeDefined();
      const created = await h.call<{ id: string }>('POST', '/v1/bookings', {
        token,
        body: { service_id: serviceId, start: slot!.start },
      });
      expect(created.status).toBe(201);

      // `cancel` and not `confirm`: with no policy asking for a confirmation the booking is
      // born `confirmed`, so `confirm` is a `409 invalid_transition`. The point of the test is
      // the actor of a transition, and any legal transition makes it.
      const cancelled = await h.call('POST', `/v1/bookings/${created.body.id}/cancel`, {
        token,
        headers: { 'bookrail-actor': 'cli' },
        body: {},
      });
      expect(cancelled.status).toBe(200);

      const event = await latestEvent('booking.cancelled', created.body.id);
      expect(event.actor?.via).toBe('cli');
      expect(event.actor?.id).toMatch(/^key_/);
    });

    it('stamps hold.created and hold.released, which had no actor at all', async () => {
      const slots = await slotsFor(h, token, serviceId, monday, plusDays(monday, 1));
      const slot = slots[0];
      expect(slot).toBeDefined();
      const hold = await h.call<{ id: string }>('POST', '/v1/holds', {
        token,
        headers: { 'bookrail-actor': 'sdk' },
        body: { service_id: serviceId, start: slot!.start },
      });
      expect(hold.status).toBe(201);

      const createdEvent = await latestEvent('hold.created', hold.body.id);
      expect(createdEvent.actor?.type).toBe('api');
      expect(createdEvent.actor?.id).toMatch(/^key_/);
      expect(createdEvent.actor?.via).toBe('sdk');

      const released = await h.call('DELETE', `/v1/holds/${hold.body.id}`, {
        token,
        headers: { 'bookrail-actor': 'dashboard' },
      });
      expect(released.status).toBe(200);

      const releasedEvent = await latestEvent('hold.released', hold.body.id);
      expect(releasedEvent.actor?.via).toBe('dashboard');
      expect(releasedEvent.actor?.id).toMatch(/^key_/);
    });

    /**
     * The engine still writes a NULL actor when nobody names one, and that is deliberate.
     *
     * An absent actor says "no credential claimed this", which is the truth for the events the
     * sweeper writes and for any caller of the engine that is not the HTTP layer. It is a
     * different statement from `{type: "system"}`, and making the new `actor` field mandatory
     * would have forced every such caller to invent one.
     */
    it('leaves the actor null when the engine is called without one', async () => {
      const slots = await slotsFor(h, token, serviceId, monday, plusDays(monday, 1));
      const slot = slots[0];
      expect(slot).toBeDefined();
      const result = await createHold(createDatabase(h.pools.app), {
        projectId: bare('project', projectId),
        environment: 'test',
        serviceId: bare('service', serviceId),
        start: new Date(slot!.start).getTime(),
        now: Date.now(),
      });

      const { rows } = await h.pools.admin.query<{ actor: unknown }>(
        'SELECT actor FROM events WHERE id = $1',
        [result.eventId],
      );
      expect(rows[0]?.actor).toBeNull();
    });
  });
});
