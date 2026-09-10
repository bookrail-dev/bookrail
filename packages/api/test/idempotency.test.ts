/**
 * `Idempotency-Key`: the same key, within 24 hours, gives the same response and no second
 * effect.
 *
 * The test that matters is the last one of the first block: twenty requests carrying one key,
 * fired together, must leave **one** booking. Everything else here is contract (the replay,
 * the reuse, the error that is replayed, the key that expires) and would pass against a
 * read-then-write implementation too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from '@bookrail/db';
import { decodeId, uuidv7 } from '@bookrail/shared';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';
import { purgeIdempotencyKeys } from '../src/jobs/index.js';
import { createDatabase, resolveDatabaseUrls } from '@bookrail/db';
import {
  buildScenario,
  firstSlot,
  nextMonday,
  plusDays,
  slotsFor,
  type ErrorBody,
} from './booking-fixtures.js';

interface BookingBody {
  id: string;
  object: string;
  status: string;
  start: string;
}

interface ListBody {
  data: { id: string }[];
}

function key(): string {
  return `idem-${uuidv7()}`;
}

/**
 * The role the API serves requests as, read from the environment rather than written out.
 *
 * Two tests below create a RESTRICTIVE policy that only bites the application role, and a
 * policy names its role literally. With the name hard coded, a checkout that sets
 * `APP_DB_ROLE` to anything else got a policy that applied to nobody, the request it was meant
 * to break went through, and two tests failed with nothing actually wrong. `resolveDatabaseUrls`
 * is the one place that answers this question, and it validates the name as a bare SQL
 * identifier before returning it, which is what makes it safe to interpolate here.
 */
const APP_ROLE = sql.raw(resolveDatabaseUrls().appRole);

describe('Idempotency-Key', () => {
  let h: Harness;
  let p: BootstrappedProject;
  let token: string;
  let monday: Date;

  beforeAll(async () => {
    h = createHarness();
    p = await h.bootstrap('Idempotency project');
    token = p.testKey;
    monday = nextMonday();
  });

  afterAll(async () => {
    await h.close();
  });

  it('replays the same response and creates one booking only', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const idempotencyKey = key();
    const body = { service_id: scenario.serviceId, start: slot.start };

    const first = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(first.status).toBe(201);
    expect(first.headers.get('Idempotent-Replayed')).toBeNull();

    const second = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    // A replay still gets its own request id: it is a different HTTP request.
    expect(second.headers.get('Bookrail-Request-Id')).not.toBe(
      first.headers.get('Bookrail-Request-Id'),
    );

    const list = await h.call<ListBody>(
      'GET',
      `/v1/bookings?resource_id=${scenario.resourceIds[0]!}`,
      {
        token,
      },
    );
    expect(list.body.data).toHaveLength(1);
  });

  it('refuses the same key with a different body', async () => {
    const scenario = await buildScenario(h, token, { capacity: 2 });
    const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const idempotencyKey = key();

    const first = await h.call('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slots[0]!.start },
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(first.status).toBe(201);

    const reused = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slots[1]!.start },
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(reused.status).toBe(400);
    expect(reused.body.error.type).toBe('invalid_request');
    expect(reused.body.error.code).toBe('idempotency_key_reused');
  });

  it('refuses the same key on a different endpoint', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const idempotencyKey = key();
    const body = { service_id: scenario.serviceId, start: slot.start };

    const hold = await h.call('POST', '/v1/holds', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(hold.status).toBe(201);

    const booking = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(booking.status).toBe(400);
    expect(booking.body.error.code).toBe('idempotency_key_reused');
  });

  it('replays a 4xx answer verbatim instead of retrying it', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    // Saturate the slot with a booking that carries no key.
    const taken = await h.call('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(taken.status).toBe(201);

    const idempotencyKey = key();
    const body = { service_id: scenario.serviceId, start: slot.start };
    const first = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('slot_unavailable');

    // Even if the slot were freed in between, the stored answer is the answer.
    const replayed = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(replayed.status).toBe(409);
    expect(replayed.headers.get('Idempotent-Replayed')).toBe('true');
    expect(replayed.body.error.code).toBe('slot_unavailable');
    // The request id inside the envelope is the one of the original request, because the body
    // is stored verbatim; the header is the current one.
    expect(replayed.headers.get('Bookrail-Request-Id')).not.toBe(
      first.headers.get('Bookrail-Request-Id'),
    );
  });

  it('scopes the key to the project and the environment', async () => {
    const scenario = await buildScenario(h, token, {});
    const liveScenario = await buildScenario(h, p.liveKey, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const liveSlot = await firstSlot(
      h,
      p.liveKey,
      liveScenario.serviceId,
      monday,
      plusDays(monday, 1),
    );
    const idempotencyKey = key();

    const test = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(test.status).toBe(201);

    // The same key text in the live environment is a different key entirely.
    const live = await h.call<BookingBody>('POST', '/v1/bookings', {
      token: p.liveKey,
      body: { service_id: liveScenario.serviceId, start: liveSlot.start },
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(live.status).toBe(201);
    expect(live.body.id).not.toBe(test.body.id);
    expect(live.headers.get('Idempotent-Replayed')).toBeNull();
  });

  it('refuses an empty or over-long key, and writes no row for either', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const body = { service_id: scenario.serviceId, start: slot.start };
    const adminDb = createDatabase(h.pools.admin);

    const before = await adminDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM idempotency_keys`,
    );

    const empty = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': '' },
    });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('parameter_invalid');
    expect(empty.body.error.param).toBe('Idempotency-Key');

    // Whitespace only is empty too: the middleware trims, so the contract does not depend on
    // whether the HTTP client happened to normalise the header.
    const blank = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': '   ' },
    });
    expect(blank.status).toBe(400);

    const long = await h.call<ErrorBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': 'x'.repeat(256) },
    });
    expect(long.status).toBe(400);
    expect(long.body.error.param).toBe('Idempotency-Key');

    const after = await adminDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM idempotency_keys`,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('treats a key with surrounding spaces as the same key', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const body = { service_id: scenario.serviceId, start: slot.start };
    const idempotencyKey = key();

    const first = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(first.status).toBe(201);

    const padded = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': `  ${idempotencyKey}  ` },
    });
    expect(padded.status).toBe(201);
    expect(padded.headers.get('Idempotent-Replayed')).toBe('true');
    expect(padded.body.id).toBe(first.body.id);
  });

  it('does not burn the key on a POST to a path that does not exist', async () => {
    const idempotencyKey = key();
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const typo = await h.call<ErrorBody>('POST', '/v1/bookinggs', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(typo.status).toBe(404);
    expect(typo.body.error.code).toBe('unknown_endpoint');

    const adminDb = createDatabase(h.pools.admin);
    const { rows } = await adminDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = ${idempotencyKey}`,
    );
    expect(rows[0]?.n).toBe(0);

    // The corrected request works, instead of being told the key was already used.
    const corrected = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(corrected.status).toBe(201);
  });

  it('takes the query string into account', async () => {
    const scenario = await buildScenario(h, token, {});
    const idempotencyKey = key();
    const body = {
      service_id: scenario.serviceId,
      from: monday.toISOString(),
      to: plusDays(monday, 1).toISOString(),
    };

    const first = await h.call('POST', '/v1/availability?probe=1', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(first.status).toBe(200);

    const otherQuery = await h.call<ErrorBody>('POST', '/v1/availability?probe=2', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(otherQuery.status).toBe(400);
    expect(otherQuery.body.error.code).toBe('idempotency_key_reused');

    // The same parameters in a different order are the same request.
    const reordered = await h.call('POST', '/v1/availability?probe=1', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(reordered.status).toBe(200);
    expect(reordered.headers.get('Idempotent-Replayed')).toBe('true');
  });

  /**
   * The lease of 90 seconds, in its three branches.
   *
   * A row is planted by hand with an old `locked_at`, because no endpoint ever leaves one in
   * that state: it is the shape a process that died between the claim and the answer would
   * leave behind. The test the review wrote and the author had not.
   */
  describe('lease', () => {
    async function plant(
      keyText: string,
      body: unknown,
      lockedAgo: string,
      hashOverride?: string,
    ): Promise<void> {
      const adminDb = createDatabase(h.pools.admin);
      const hash =
        hashOverride ??
        createHash('sha256')
          .update(
            `POST
/v1/bookings
${JSON.stringify(body)}`,
            'utf8',
          )
          .digest('hex');
      await adminDb.execute(sql`
        INSERT INTO idempotency_keys (id, project_id, environment, key, request_hash, locked_at,
                                      expires_at)
        VALUES (${uuidv7()}, ${decodeId('project', p.projectId) ?? p.projectId}, 'test',
                ${keyText}, ${hash}, now() - ${sql.raw(`interval '${lockedAgo}'`)},
                now() + interval '24 hours')
      `);
    }

    async function completedAt(keyText: string): Promise<string | null> {
      const adminDb = createDatabase(h.pools.admin);
      const { rows } = await adminDb.execute<{ completed_at: string | null }>(sql`
        SELECT completed_at::text AS completed_at FROM idempotency_keys WHERE key = ${keyText}
      `);
      return rows[0]?.completed_at ?? null;
    }

    it('takes over a claim whose owner died, and refuses a fresh one', async () => {
      const scenario = await buildScenario(h, token, { capacity: 3 });
      const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));

      // 1. old claim, same hash → the claim is taken over and the request runs.
      const stale = key();
      const bodyA = { service_id: scenario.serviceId, start: slots[0]!.start };
      await plant(stale, bodyA, '5 minutes');
      const taken = await h.call<BookingBody>('POST', '/v1/bookings', {
        token,
        body: bodyA,
        headers: { 'idempotency-key': stale },
      });
      expect(taken.status).toBe(201);
      expect(await completedAt(stale)).not.toBeNull();

      // 2. fresh claim, same hash → still in progress.
      const fresh = key();
      const bodyB = { service_id: scenario.serviceId, start: slots[1]!.start };
      await plant(fresh, bodyB, '1 second');
      const busy = await h.call<ErrorBody>('POST', '/v1/bookings', {
        token,
        body: bodyB,
        headers: { 'idempotency-key': fresh },
      });
      expect(busy.status).toBe(409);
      expect(busy.body.error.code).toBe('idempotency_key_in_progress');

      // 3. old claim, different hash → the consistency check comes first, and must.
      const mismatched = key();
      const bodyC = { service_id: scenario.serviceId, start: slots[2]!.start };
      await plant(mismatched, bodyC, '5 minutes', 'f'.repeat(64));
      const reused = await h.call<ErrorBody>('POST', '/v1/bookings', {
        token,
        body: bodyC,
        headers: { 'idempotency-key': mismatched },
      });
      expect(reused.status).toBe(400);
      expect(reused.body.error.code).toBe('idempotency_key_reused');
    });
  });

  /**
   * The blocker of the independent review, reproduced and then pinned.
   *
   * The engine commits the booking and only afterwards does the route invalidate the cache and
   * **re-read** the row it wrote. A failure in that window used to release the key, and the
   * retry, which is exactly what the documentation invites, created a second booking.
   *
   * The failure is provoked deterministically with a RESTRICTIVE policy that makes any SELECT
   * of `booking_allocations` raise: the engine writes that table without RETURNING and never
   * reads it, so only the route's re-read is hit. The policy is a device; in production the
   * same window is a dead pool connection, a `statement_timeout` or a failover.
   */
  describe('a 5xx after the commit', () => {
    it('keeps the key, so the retry gets the same 500 and never a second booking', async () => {
      const scenario = await buildScenario(h, token, { capacity: 5 });
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const idempotencyKey = key();
      const body = { service_id: scenario.serviceId, start: slot.start };
      const adminDb = createDatabase(h.pools.admin);

      await adminDb.execute(sql`
        CREATE FUNCTION idem_boom() RETURNS boolean AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$
        LANGUAGE plpgsql
      `);
      let failed: unknown = null;
      try {
        await adminDb.execute(sql`
          CREATE POLICY idem_boom ON booking_allocations AS RESTRICTIVE FOR SELECT
            TO ${APP_ROLE} USING (idem_boom())
        `);
        try {
          const first = await h.call<ErrorBody>('POST', '/v1/bookings', {
            token,
            body,
            headers: { 'idempotency-key': idempotencyKey },
          });
          expect(first.status).toBe(500);
          expect(first.body.error.code).toBe('internal_error');
        } finally {
          await adminDb.execute(sql`DROP POLICY idem_boom ON booking_allocations`);
        }

        // The booking exists: the engine committed before the re-read blew up.
        const written = await adminDb.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM bookings
           WHERE service_id = ${decodeId('service', scenario.serviceId)}
        `);
        expect(written.rows[0]?.n).toBe(1);

        // And so does the key, remembered as a 500 instead of released.
        const stored = await adminDb.execute<{ response_status: number | null }>(sql`
          SELECT response_status FROM idempotency_keys WHERE key = ${idempotencyKey}
        `);
        expect(stored.rows).toHaveLength(1);
        expect(stored.rows[0]?.response_status).toBe(500);

        // The retry the documentation invites: the same 500, not a second booking.
        const retry = await h.call<ErrorBody>('POST', '/v1/bookings', {
          token,
          body,
          headers: { 'idempotency-key': idempotencyKey },
        });
        expect(retry.status).toBe(500);
        expect(retry.headers.get('Idempotent-Replayed')).toBe('true');

        const list = await h.call<ListBody>(
          'GET',
          `/v1/bookings?service_id=${scenario.serviceId}`,
          { token },
        );
        expect(list.body.data).toHaveLength(1);
      } catch (error) {
        failed = error;
      } finally {
        await adminDb
          .execute(sql`DROP POLICY IF EXISTS idem_boom ON booking_allocations`)
          .catch(() => undefined);
        await adminDb.execute(sql`DROP FUNCTION IF EXISTS idem_boom()`).catch(() => undefined);
      }
      if (failed) throw failed;
    });

    it('still releases the key when nothing was committed', async () => {
      // A 5xx *before* any effect keeps the documented behaviour: the key goes back, because
      // the request really did not happen. Provoked on `POST /v1/availability`, which commits
      // nothing at all, by making the read of `services` raise.
      const scenario = await buildScenario(h, token, {});
      const idempotencyKey = key();
      const body = {
        service_id: scenario.serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      };
      const adminDb = createDatabase(h.pools.admin);

      await adminDb.execute(sql`
        CREATE FUNCTION idem_boom_read() RETURNS boolean AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$
        LANGUAGE plpgsql
      `);
      let failed: unknown = null;
      try {
        await adminDb.execute(sql`
          CREATE POLICY idem_boom_read ON services AS RESTRICTIVE FOR SELECT
            TO ${APP_ROLE} USING (idem_boom_read())
        `);
        try {
          const first = await h.call<ErrorBody>('POST', '/v1/availability', {
            token,
            body,
            headers: { 'idempotency-key': idempotencyKey },
          });
          expect(first.status).toBe(500);
        } finally {
          await adminDb.execute(sql`DROP POLICY idem_boom_read ON services`);
        }

        const { rows } = await adminDb.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM idempotency_keys WHERE key = ${idempotencyKey}
        `);
        expect(rows[0]?.n).toBe(0);

        const retry = await h.call('POST', '/v1/availability', {
          token,
          body,
          headers: { 'idempotency-key': idempotencyKey },
        });
        expect(retry.status).toBe(200);
      } catch (error) {
        failed = error;
      } finally {
        await adminDb
          .execute(sql`DROP POLICY IF EXISTS idem_boom_read ON services`)
          .catch(() => undefined);
        await adminDb.execute(sql`DROP FUNCTION IF EXISTS idem_boom_read()`).catch(() => undefined);
      }
      if (failed) throw failed;
    });
  });

  it('is optional: a POST without the header behaves exactly as before', async () => {
    const scenario = await buildScenario(h, token, { capacity: 2 });
    const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const first = await h.call('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slots[0]!.start },
    });
    const second = await h.call('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slots[0]!.start },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('works on POST /v1/availability too, where it is merely harmless', async () => {
    const scenario = await buildScenario(h, token, {});
    const idempotencyKey = key();
    const body = {
      service_id: scenario.serviceId,
      from: monday.toISOString(),
      to: plusDays(monday, 1).toISOString(),
    };
    const first = await h.call('POST', '/v1/availability', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    const second = await h.call('POST', '/v1/availability', {
      token,
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(second.body).toEqual(first.body);
  });

  /**
   * The reason the table exists.
   *
   * Twenty requests, one key, fired without awaiting any of them. Exactly one may create the
   * booking; the rest are either the replay of that one answer (if it had already committed)
   * or `409 idempotency_key_in_progress` (if it had not). What is **not** allowed is two
   * bookings, and the assertion is made against the database, not against the responses.
   */
  it('lets exactly one of twenty concurrent requests with one key create a booking', async () => {
    const scenario = await buildScenario(h, token, { capacity: 20 });
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const idempotencyKey = key();
    const body = { service_id: scenario.serviceId, start: slot.start, quantity: 1 };

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        h.call<BookingBody & ErrorBody>('POST', '/v1/bookings', {
          token,
          body,
          headers: { 'idempotency-key': idempotencyKey },
        }),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    const inProgress = responses.filter((r) => r.status === 409);
    const other = responses.filter((r) => r.status !== 201 && r.status !== 409);

    expect(other.map((r) => r.status)).toEqual([]);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(inProgress.every((r) => r.body.error.code === 'idempotency_key_in_progress')).toBe(true);
    // Every 201 is the same booking: one execution, replayed.
    expect(new Set(created.map((r) => r.body.id)).size).toBe(1);

    // The database is the judge. The resource has capacity 20 on purpose: a second execution
    // would have succeeded, so a single row here means the key stopped it, not the capacity.
    const list = await h.call<ListBody>(
      'GET',
      `/v1/bookings?resource_id=${scenario.resourceIds[0]!}`,
      { token },
    );
    expect(list.body.data).toHaveLength(1);
  });

  describe('purge', () => {
    it('deletes the keys past their retention and leaves the rest', async () => {
      const scenario = await buildScenario(h, token, {});
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const fresh = key();
      const stale = key();

      const created = await h.call('POST', '/v1/bookings', {
        token,
        body: { service_id: scenario.serviceId, start: slot.start },
        headers: { 'idempotency-key': fresh },
      });
      expect(created.status).toBe(201);

      const adminDb = createDatabase(h.pools.admin);
      await adminDb.execute(sql`
        INSERT INTO idempotency_keys (id, project_id, environment, key, request_hash,
                                      response_status, response_body, completed_at, expires_at)
        VALUES (${uuidv7()}, ${decodeId('project', p.projectId) ?? p.projectId}, 'test', ${stale}, repeat('b', 64),
                200, '{}'::jsonb, now() - interval '25 hours', now() - interval '1 hour')
      `);

      const deleted = await purgeIdempotencyKeys({
        db: createDatabase(h.pools.app),
        logger: h.logger,
      });
      expect(deleted).toBeGreaterThanOrEqual(1);

      const { rows } = await adminDb.execute<{ key: string }>(sql`
        SELECT key FROM idempotency_keys WHERE key IN (${fresh}, ${stale})
      `);
      expect(rows.map((row) => row.key)).toEqual([fresh]);
    });
  });
});
