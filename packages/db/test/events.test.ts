import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';
import { adminClient, appClient, asProject, expectPgError, testUrls } from './helpers.js';
import { createProject } from './fixtures.js';

/** The event log is append-only for the application role: it may read and append, never rewrite. */
describe('events are append-only for the application role', () => {
  let admin: Client;
  let app: Client;
  let projectId: string;
  let eventId: string;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
    projectId = (await createProject(admin, 'Events project')).projectId;
    eventId = uuidv7();
    await admin.query(
      `INSERT INTO events (id, project_id, environment, type, data, api_version)
       VALUES ($1, $2, 'test', 'booking.created', '{"object":{}}'::jsonb, '2026-09-01')`,
      [eventId, projectId],
    );
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it('grants only SELECT and INSERT to the application role', async () => {
    const { appRole } = testUrls();
    const privileges = await admin.query<{ p: string; has: boolean }>(
      `SELECT p, has_table_privilege($1, 'events', p) AS has
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p`,
      [appRole],
    );
    const byName = new Map(privileges.rows.map((r) => [r.p, r.has]));
    expect(byName.get('SELECT')).toBe(true);
    expect(byName.get('INSERT')).toBe(true);
    expect(byName.get('UPDATE')).toBe(false);
    expect(byName.get('DELETE')).toBe(false);
    expect(byName.get('TRUNCATE')).toBe(false);
  });

  it('allows appending an event', async () => {
    await asProject(app, { projectId, environment: 'test' }, async () => {
      const id = uuidv7();
      await app.query(
        `INSERT INTO events (id, project_id, environment, type, data, api_version)
         VALUES ($1, $2, 'test', 'booking.confirmed', '{"object":{}}'::jsonb, '2026-09-01')`,
        [id, projectId],
      );
      const { rows } = await app.query(`SELECT id FROM events WHERE id = $1`, [id]);
      expect(rows).toHaveLength(1);
    });
  });

  it('rejects UPDATE', async () => {
    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.project_id', $1, true), set_config('app.environment', 'test', true)`,
      [projectId],
    );
    const failure = await expectPgError(
      app.query(`UPDATE events SET type = 'tampered' WHERE id = $1`, [eventId]),
    );
    expect(failure.code).toBe('42501');
    expect(failure.message).toMatch(/permission denied/i);
    await app.query('ROLLBACK');
  });

  it('rejects DELETE', async () => {
    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.project_id', $1, true), set_config('app.environment', 'test', true)`,
      [projectId],
    );
    const failure = await expectPgError(app.query(`DELETE FROM events WHERE id = $1`, [eventId]));
    expect(failure.code).toBe('42501');
    await app.query('ROLLBACK');
  });

  it('rejects TRUNCATE', async () => {
    await app.query('BEGIN');
    const failure = await expectPgError(app.query(`TRUNCATE events`));
    expect(failure.code).toBe('42501');
    await app.query('ROLLBACK');
  });

  it('assigns a monotonic sequence number per project', async () => {
    await asProject(app, { projectId, environment: 'test' }, async () => {
      // `events.seq` and not `seq`: the output column is the text cast, and ordering by it sorted
      // "10" before "9" the first time a project's numbers crossed a power of ten.
      const { rows } = await app.query<{ seq: string }>(
        `SELECT seq::text AS seq FROM events ORDER BY events.seq`,
      );
      const values = rows.map((r) => Number(r.seq));
      expect(values.length).toBeGreaterThanOrEqual(2);
      expect([...values].sort((a, b) => a - b)).toEqual(values);
    });
  });
});
