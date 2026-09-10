import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';
import { adminClient, appClient, asProject, expectPgError } from './helpers.js';
import { createProject } from './fixtures.js';

const P = { environment: 'test' } as const;

async function insertOccupancy(
  client: Client,
  projectId: string,
  resourceId: string,
  from: string,
  to: string,
  capacityUsed = 1,
): Promise<string> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO occupancies (id, project_id, environment, resource_id, period, capacity_used, kind, ref_id)
     VALUES ($1, $2, 'test', $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6, 'booking', $7)`,
    [id, projectId, resourceId, from, to, capacityUsed, uuidv7()],
  );
  return id;
}

describe('occupancies and the capacity-1 exclusion constraint', () => {
  let admin: Client;
  let app: Client;
  let projectId: string;
  let singleCapacityResource: string;
  let multiCapacityResource: string;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
    projectId = (await createProject(admin, 'Occupancy project')).projectId;

    singleCapacityResource = uuidv7();
    multiCapacityResource = uuidv7();
    await admin.query(
      `INSERT INTO resources (id, project_id, environment, name, capacity)
       VALUES ($1, $2, 'test', 'Court 1', 1), ($3, $2, 'test', 'Yoga room', 15)`,
      [singleCapacityResource, projectId, multiCapacityResource],
    );
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it('rejects two overlapping occupancies on a capacity-1 resource', async () => {
    await asProject(app, { projectId, ...P }, async () => {
      await insertOccupancy(
        app,
        projectId,
        singleCapacityResource,
        '2026-09-08T07:00:00Z',
        '2026-09-08T08:00:00Z',
      );
    });

    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.project_id', $1, true), set_config('app.environment', 'test', true)`,
      [projectId],
    );
    const failure = await expectPgError(
      insertOccupancy(
        app,
        projectId,
        singleCapacityResource,
        '2026-09-08T07:30:00Z',
        '2026-09-08T08:30:00Z',
      ),
    );
    expect(failure.code).toBe('23P01');
    expect(failure.message).toContain('occ_no_overlap_cap1');
    await app.query('ROLLBACK');
  });

  it('accepts a back-to-back occupancy, because ranges are half open', async () => {
    await asProject(app, { projectId, ...P }, async () => {
      const id = await insertOccupancy(
        app,
        projectId,
        singleCapacityResource,
        '2026-09-08T08:00:00Z',
        '2026-09-08T09:00:00Z',
      );
      expect(id).toBeTruthy();
    });
  });

  it('allows overlaps on a resource whose capacity is greater than 1', async () => {
    await asProject(app, { projectId, ...P }, async () => {
      await insertOccupancy(
        app,
        projectId,
        multiCapacityResource,
        '2026-09-09T07:00:00Z',
        '2026-09-09T08:00:00Z',
      );
      await insertOccupancy(
        app,
        projectId,
        multiCapacityResource,
        '2026-09-09T07:15:00Z',
        '2026-09-09T08:15:00Z',
      );
      const { rows } = await app.query<{ count: string }>(
        `SELECT count(*)::text FROM occupancies WHERE resource_id = $1`,
        [multiCapacityResource],
      );
      expect(rows[0]?.count).toBe('2');
    });
  });

  it('sets single_capacity_resource from the resource, not from the caller', async () => {
    await asProject(app, { projectId, ...P }, async () => {
      const { rows } = await app.query<{ resource_id: string; single_capacity_resource: boolean }>(
        `SELECT resource_id, single_capacity_resource FROM occupancies`,
      );
      for (const row of rows) {
        expect(row.single_capacity_resource).toBe(row.resource_id === singleCapacityResource);
      }
    });
  });

  it('re-flags existing occupancies when the capacity of a resource changes', async () => {
    const resourceId = uuidv7();
    await admin.query(
      `INSERT INTO resources (id, project_id, environment, name, capacity)
       VALUES ($1, $2, 'test', 'Flexible room', 4)`,
      [resourceId, projectId],
    );

    await asProject(app, { projectId, ...P }, async () => {
      await insertOccupancy(
        app,
        projectId,
        resourceId,
        '2026-09-10T07:00:00Z',
        '2026-09-10T08:00:00Z',
      );
      const before = await app.query<{ flag: boolean }>(
        `SELECT single_capacity_resource AS flag FROM occupancies WHERE resource_id = $1`,
        [resourceId],
      );
      expect(before.rows[0]?.flag).toBe(false);

      await app.query(`UPDATE resources SET capacity = 1 WHERE id = $1`, [resourceId]);

      const after = await app.query<{ flag: boolean }>(
        `SELECT single_capacity_resource AS flag FROM occupancies WHERE resource_id = $1`,
        [resourceId],
      );
      expect(after.rows[0]?.flag).toBe(true);
    });

    // And from now on the constraint bites.
    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.project_id', $1, true), set_config('app.environment', 'test', true)`,
      [projectId],
    );
    const failure = await expectPgError(
      insertOccupancy(app, projectId, resourceId, '2026-09-10T07:30:00Z', '2026-09-10T08:30:00Z'),
    );
    expect(failure.code).toBe('23P01');
    await app.query('ROLLBACK');
  });

  /**
   * The regression that was found in review: an occupancy written while the resource had capacity 4
   * carries capacity_used = 4. Lowering the resource to capacity 1 flips
   * single_capacity_resource but leaves capacity_used alone, so a predicate gated on
   * `capacity_used = 1` would have let an overlapping occupancy through.
   */
  it('closes the hole opened by lowering the capacity under a saturating occupancy', async () => {
    const resourceId = uuidv7();
    await admin.query(
      `INSERT INTO resources (id, project_id, environment, name, capacity)
       VALUES ($1, $2, 'test', 'Shrinking room', 4)`,
      [resourceId, projectId],
    );

    await asProject(app, { projectId, ...P }, async () => {
      // capacity_used = 4, i.e. exactly what POST /resources/{id}/block writes.
      await insertOccupancy(
        app,
        projectId,
        resourceId,
        '2027-02-01T00:00:00Z',
        '2027-02-02T00:00:00Z',
        4,
      );
      await app.query(`UPDATE resources SET capacity = 1 WHERE id = $1`, [resourceId]);
      const { rows } = await app.query<{ flag: boolean; used: number }>(
        `SELECT single_capacity_resource AS flag, capacity_used AS used
           FROM occupancies WHERE resource_id = $1`,
        [resourceId],
      );
      expect(rows[0]?.flag).toBe(true);
      expect(rows[0]?.used, 'capacity_used is intentionally left untouched').toBe(4);
    });

    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.project_id', $1, true), set_config('app.environment', 'test', true)`,
      [projectId],
    );
    const failure = await expectPgError(
      insertOccupancy(app, projectId, resourceId, '2027-02-01T12:00:00Z', '2027-02-03T00:00:00Z'),
    );
    expect(failure.code).toBe('23P01');
    expect(failure.message).toContain('occ_no_overlap_cap1');
    await app.query('ROLLBACK');
  });

  it('refuses to lower the capacity to 1 while two occupancies already overlap', async () => {
    const resourceId = uuidv7();
    await admin.query(
      `INSERT INTO resources (id, project_id, environment, name, capacity)
       VALUES ($1, $2, 'test', 'Busy room', 4)`,
      [resourceId, projectId],
    );
    await asProject(app, { projectId, ...P }, async () => {
      await insertOccupancy(
        app,
        projectId,
        resourceId,
        '2027-03-01T09:00:00Z',
        '2027-03-01T11:00:00Z',
      );
      await insertOccupancy(
        app,
        projectId,
        resourceId,
        '2027-03-01T10:00:00Z',
        '2027-03-01T12:00:00Z',
      );
    });

    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.project_id', $1, true), set_config('app.environment', 'test', true)`,
      [projectId],
    );
    // The trigger re-flags both rows, and the constraint then refuses the inconsistent state.
    const failure = await expectPgError(
      app.query(`UPDATE resources SET capacity = 1 WHERE id = $1`, [resourceId]),
    );
    expect(failure.code).toBe('23P01');
    await app.query('ROLLBACK');
  });

  it('ignores inactive occupancies', async () => {
    const resourceId = uuidv7();
    await admin.query(
      `INSERT INTO resources (id, project_id, environment, name, capacity)
       VALUES ($1, $2, 'test', 'Cancelled court', 1)`,
      [resourceId, projectId],
    );
    await asProject(app, { projectId, ...P }, async () => {
      const id = await insertOccupancy(
        app,
        projectId,
        resourceId,
        '2026-09-11T07:00:00Z',
        '2026-09-11T08:00:00Z',
      );
      await app.query(`UPDATE occupancies SET active = false WHERE id = $1`, [id]);
      // The slot is free again once the occupancy is deactivated.
      await insertOccupancy(
        app,
        projectId,
        resourceId,
        '2026-09-11T07:00:00Z',
        '2026-09-11T08:00:00Z',
      );
    });
  });

  /**
   * The database net for capacity N (migration 0014). Where `occ_no_overlap_cap1` covers a
   * resource with one unit, this covers the rest, and unlike `takeOccupancy` it is not a
   * discipline the application has to keep: the write below never touches the engine.
   */
  describe('the capacity guard for capacity N', () => {
    let room: string;

    beforeAll(async () => {
      room = uuidv7();
      await admin.query(
        `INSERT INTO resources (id, project_id, environment, name, capacity)
         VALUES ($1, $2, 'test', 'Studio', 2)`,
        [room, projectId],
      );
    });

    it('accepts occupancies up to the capacity', async () => {
      await asProject(app, { projectId, ...P }, async () => {
        await insertOccupancy(app, projectId, room, '2026-10-01T07:00:00Z', '2026-10-01T09:00:00Z');
        await insertOccupancy(app, projectId, room, '2026-10-01T08:00:00Z', '2026-10-01T10:00:00Z');
      });
    });

    it('refuses the unit past the capacity with a check violation, written in raw SQL', async () => {
      await app.query('BEGIN');
      await app.query(
        `SELECT set_config('app.project_id', $1, true), set_config('app.environment', 'test', true)`,
        [projectId],
      );
      const failure = await expectPgError(
        insertOccupancy(app, projectId, room, '2026-10-01T08:30:00Z', '2026-10-01T08:45:00Z'),
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain(room);
      await app.query('ROLLBACK');
    });

    /**
     * The same, straight through the **admin** connection, which bypasses Row Level Security and
     * every advisory lock the engine takes. This is the whole point of the guard: a writer that
     * is not `takeOccupancy` (a support session, a repair script, a future endpoint) is
     * stopped by the database and not by a convention.
     */
    it('refuses it on the admin connection too', async () => {
      const failure = await expectPgError(
        insertOccupancy(admin, projectId, room, '2026-10-01T08:30:00Z', '2026-10-01T08:45:00Z', 5),
      );
      expect(failure.code).toBe('23514');
    });

    /** Lowering a capacity under what is already sold stays legal: it is what emits booking.orphaned. */
    it('does not fire when a resource capacity is lowered under what is sold', async () => {
      const shrinking = uuidv7();
      await admin.query(
        `INSERT INTO resources (id, project_id, environment, name, capacity)
         VALUES ($1, $2, 'test', 'Shrinking', 4)`,
        [shrinking, projectId],
      );
      await insertOccupancy(
        admin,
        projectId,
        shrinking,
        '2026-10-02T07:00:00Z',
        '2026-10-02T09:00:00Z',
        4,
      );
      await admin.query(`UPDATE resources SET capacity = 1 WHERE id = $1`, [shrinking]);
      const { rows } = await admin.query<{ capacity: number }>(
        `SELECT capacity FROM resources WHERE id = $1`,
        [shrinking],
      );
      expect(rows[0]?.capacity).toBe(1);
    });

    /** Releasing gives capacity back; it can never be the write that breaks the invariant. */
    it('does not fire when an occupancy is released', async () => {
      const id = await insertOccupancy(
        admin,
        projectId,
        room,
        '2026-10-03T07:00:00Z',
        '2026-10-03T08:00:00Z',
        2,
      );
      await admin.query(`UPDATE occupancies SET active = false WHERE id = $1`, [id]);
      const { rows } = await admin.query<{ active: boolean }>(
        `SELECT active FROM occupancies WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.active).toBe(false);
    });

    /**
     * `capacity_violations` is the same measurement, asked of the whole estate.
     *
     * The assertion is per resource and not global on purpose: a **legitimate** violation exists
     * on any database where somebody has lowered a resource's capacity under what was already
     * sold, which is an allowed operation (`booking.orphaned`, reason `capacity_exceeded`). The
     * suites above do exactly that, and so will real customers. See the report.
     */
    it('reports nothing for a resource whose invariant holds', async () => {
      const { rows } = await admin.query<{ resource_id: string }>(
        `SELECT * FROM capacity_violations(100000)`,
      );
      expect(rows.map((r) => r.resource_id)).not.toContain(room);
    });

    /**
     * And it finds a row that was smuggled in with the trigger disabled, which is the only way
     * to produce one and therefore the only way to prove the daily check would see it.
     */
    it('reports a violation that was written with the guard disabled', async () => {
      const smuggled = uuidv7();
      await admin.query(
        `INSERT INTO resources (id, project_id, environment, name, capacity)
         VALUES ($1, $2, 'test', 'Smuggled', 1)`,
        [smuggled, projectId],
      );
      await admin.query(
        `ALTER TABLE occupancies DISABLE TRIGGER occupancies_capacity_guard_insert`,
      );
      try {
        await admin.query(
          `INSERT INTO occupancies (id, project_id, environment, resource_id, period,
                                    capacity_used, kind, ref_id)
           VALUES ($1, $2, 'test', $3, tstzrange('2026-10-04T07:00:00Z'::timestamptz,
                                                 '2026-10-04T08:00:00Z'::timestamptz, '[)'),
                   9, 'booking', $4)`,
          [uuidv7(), projectId, smuggled, uuidv7()],
        );
      } finally {
        await admin.query(
          `ALTER TABLE occupancies ENABLE TRIGGER occupancies_capacity_guard_insert`,
        );
      }

      const { rows } = await admin.query<{
        resource_id: string;
        peak: string;
        capacity: number;
        window_start: Date;
        window_end: Date;
      }>(`SELECT * FROM capacity_violations(100000)`);
      expect(rows.map((r) => r.resource_id)).toContain(smuggled);
      // The window is part of the answer since migration 0016: the integrity job needs it to
      // look for the `booking.orphaned` event that would explain the violation.
      const found = rows.find((r) => r.resource_id === smuggled);
      expect(found?.window_start).toBeInstanceOf(Date);
      expect(found?.window_end).toBeInstanceOf(Date);
      expect(found?.window_start?.toISOString()).toBe('2026-10-04T07:00:00.000Z');

      await admin.query(`DELETE FROM occupancies WHERE resource_id = $1`, [smuggled]);
    });

    /**
     * Above the cap the scan is partial, which is documented. What it must not be is **random**:
     * without an `ORDER BY` before the `LIMIT` the subset measured changed from call to call, so
     * a real violation could be seen one night and not the next with nothing having changed. An
     * `error` that appears and disappears is worse than no check at all, because it teaches
     * everybody to ignore the line. Migration 0016 orders by `(resource_id, period)`, which is
     * total over a set that is already `DISTINCT` on exactly those two columns.
     */
    it('measures the same subset twice when the scan is capped', async () => {
      const total = await admin.query<{ n: string }>(`SELECT capacity_scan_size() AS n`);
      const size = Number(total.rows[0]?.n ?? 0);
      // The cap has to bite for the test to mean anything.
      expect(size).toBeGreaterThan(3);

      const windows = async (limit: number): Promise<string> => {
        const { rows } = await admin.query<{ rid: string; lo: string }>(
          `WITH scanned AS (
             SELECT DISTINCT o.resource_id AS rid, o.period AS w
               FROM occupancies o
              WHERE o.active AND (o.expires_at IS NULL OR o.expires_at > now())
              ORDER BY 1, 2
              LIMIT $1
           )
           SELECT rid, lower(w)::text AS lo FROM scanned ORDER BY rid, lo`,
          [limit],
        );
        return rows.map((r) => `${r.rid}@${r.lo}`).join('|');
      };

      const first = await windows(3);
      const second = await windows(3);
      expect(second).toBe(first);
      expect(first.split('|')).toHaveLength(3);

      // And the denominator exists, so a capped run can say how much of the estate it saw.
      expect(size).toBeGreaterThanOrEqual(3);
    });
  });

  it('refuses an occupancy on a resource of another project', async () => {
    const other = (await createProject(admin, 'Other project')).projectId;
    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.project_id', $1, true), set_config('app.environment', 'test', true)`,
      [other],
    );
    const failure = await expectPgError(
      insertOccupancy(
        app,
        other,
        singleCapacityResource,
        '2026-09-12T07:00:00Z',
        '2026-09-12T08:00:00Z',
      ),
    );
    // The BEFORE trigger cannot see the foreign resource under RLS, so it raises a foreign key
    // violation before the composite foreign key itself gets a chance to.
    expect(failure.code).toBe('23503');
    await app.query('ROLLBACK');
  });
});
