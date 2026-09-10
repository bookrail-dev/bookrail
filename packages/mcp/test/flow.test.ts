import { createServer as createHttpServer, type Server } from 'node:http';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  nextWeek,
  PADEL_CONFIG,
  type Harness,
  type Project,
  type Session,
} from './harness.js';
import { TEMP_ROOT } from '../src/tempdir.js';

let h: Harness;
let project: Project;
let session: Session;
let serviceId: string;

beforeAll(async () => {
  h = await createHarness();
  project = await h.bootstrap('MCP Flow');
  session = await h.session({
    cwd: await h.workdir(),
    env: { BOOKRAIL_SECRET_KEY: project.testKey },
  });
}, 120_000);

afterAll(async () => {
  await h.close();
});

/**
 * The whole walkthrough, driven only through MCP tools: model the padel vertical, push it to test, ask for availability, book.
 *
 * The order is the order the server's own `instructions` prescribe, and each step asserts on
 * the field the next step reads, which is the property that actually matters here: an agent
 * that follows the chain never has to guess a value.
 */
describe('the padel walkthrough, through MCP tools only', () => {
  let bookingId = '';
  let bookingStart = '';

  it('1. says which project it is about to change', async () => {
    const result = await session.call<{ project: { id: string }; live_allowed: boolean }>(
      'bookrail_project_info',
      {},
    );
    expect(result.isError).toBe(false);
    expect(result.envelope.environment).toBe('test');
    expect(result.envelope.data?.project.id).toBe(project.projectId);
    expect(result.envelope.data?.live_allowed).toBe(false);
    expect(result.envelope.next_steps?.length).toBeGreaterThan(0);
  });

  it('2. reports a broken configuration as issues with a position, not as a failure', async () => {
    const broken = {
      ...PADEL_CONFIG,
      services: [{ ...PADEL_CONFIG.services[0], requirements: [{ group: 'missing_group' }] }],
    };
    const result = await session.call<{ valid: boolean; issues: { path: string }[] }>(
      'bookrail_config_validate',
      { config: broken },
    );
    expect(result.isError).toBe(false);
    expect(result.envelope.data?.valid).toBe(false);
    expect(result.envelope.data?.issues.length).toBeGreaterThan(0);
    expect(result.envelope.data?.issues[0]?.path).toContain('services');
  });

  it('3. validates the padel model', async () => {
    const result = await session.call<{ valid: boolean; counts: Record<string, number> }>(
      'bookrail_config_validate',
      { config: PADEL_CONFIG },
    );
    expect(result.envelope.data?.valid).toBe(true);
    expect(result.envelope.data?.counts.services).toBe(1);
    expect(result.envelope.data?.counts.resources).toBe(2);
  });

  it('4. plans the push without writing anything', async () => {
    const before = h.seenRequests.length;
    const result = await session.call<{ counts: Record<string, number>; applied: boolean }>(
      'bookrail_config_push',
      { config: PADEL_CONFIG, dry_run: true },
    );
    expect(result.isError).toBe(false);
    expect(result.envelope.data?.counts.create).toBe(7);
    expect(result.envelope.data?.applied).toBe(false);
    expect(h.seenRequests.slice(before).every((line) => line.startsWith('GET '))).toBe(true);
  });

  it('5. refuses to apply without confirm, and writes nothing', async () => {
    const before = h.seenRequests.length;
    const result = await session.call<never>('bookrail_config_push', {
      config: PADEL_CONFIG,
      dry_run: false,
    });
    expect(result.isError).toBe(false);
    expect(result.envelope.requires_confirmation).toBe(true);
    expect(result.envelope.preview).toBeDefined();
    expect(result.envelope.next_steps?.join(' ')).toContain('confirm: true');
    expect(h.seenRequests.slice(before).every((line) => line.startsWith('GET '))).toBe(true);
  });

  it('6. applies the push with confirm', async () => {
    const result = await session.call<{ applied: boolean; counts: Record<string, number> }>(
      'bookrail_config_push',
      { config: PADEL_CONFIG, dry_run: false, confirm: true },
    );
    expect(result.isError).toBe(false);
    expect(result.envelope.data?.applied).toBe(true);
    expect(result.envelope.data?.counts.create).toBe(7);
    expect(h.seenRequests).toContain('POST /v1/services');
  });

  it('7. is idempotent: a second push finds nothing to do', async () => {
    const result = await session.call<{ counts: Record<string, number> }>('bookrail_config_push', {
      config: PADEL_CONFIG,
      dry_run: true,
    });
    expect(result.envelope.data?.counts.create).toBe(0);
    expect(result.envelope.data?.counts.update).toBe(0);
    expect(result.envelope.data?.counts.delete).toBe(0);
    expect(result.envelope.data?.counts.unchanged).toBe(7);
  });

  it('8. reads the svc_ id back, matched by metadata.config_id', async () => {
    const result = await session.call<{
      data: { id: string; metadata: { config_id?: string } }[];
    }>('bookrail_objects_list', { kind: 'services' });
    expect(result.isError).toBe(false);
    const match = result.envelope.data?.data.find(
      (service) => service.metadata.config_id === 'match',
    );
    expect(match).toBeDefined();
    serviceId = match?.id ?? '';
    expect(serviceId.startsWith('svc_')).toBe(true);
  });

  it('9. answers availability, and the slots line up with the declared grid', async () => {
    const from = nextWeek(7);
    const to = nextWeek(8);
    const result = await session.call<{
      slots: {
        start: string;
        duration_minutes: number | null;
        price_rule: { index: number; label: string | null } | null;
      }[];
      timezone: string;
    }>('bookrail_availability', { service_id: serviceId, from, to, explain: false });
    expect(result.isError).toBe(false);
    const slots = result.envelope.data?.slots ?? [];
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(new Date(slot.start).getUTCMinutes() % 30).toBe(0);
      // The field is on every slot, `null` when the flat service price applied.
      expect(slot).toHaveProperty('price_rule');
      expect(slot.price_rule).toBeNull();
    }
    expect(result.envelope.next_steps?.join(' ')).toContain('bookrail');
  });

  it('10. explains an instant outside the opening hours', async () => {
    const result = await session.call<{ available: boolean; reasons: { code: string }[] }>(
      'bookrail_explain_unavailable',
      { service_id: serviceId, start: nextWeek(7), duration_minutes: 60 },
    );
    // Midnight UTC is 02:00 in Rome, which the club_hours schedule does not open.
    expect(result.isError).toBe(false);
    expect(result.envelope.data?.available).toBe(false);
    expect((result.envelope.data?.reasons ?? []).length).toBeGreaterThan(0);
    expect(result.envelope.next_steps?.join(' ')).toContain('bookrail_availability_next');
  });

  it('11. finds the first bookable instant, holds it and books it', async () => {
    const next = await session.call<{ next_available: string | null }>(
      'bookrail_availability_next',
      { service_id: serviceId, from: nextWeek(7) },
    );
    const start = next.envelope.data?.next_available;
    expect(start).toBeTruthy();

    const check = await session.call<{ available: boolean }>('bookrail_availability_check', {
      service_id: serviceId,
      start: start as string,
      duration_minutes: 60,
    });
    expect(check.envelope.data?.available).toBe(true);

    const hold = await session.call<{ id: string; expires_at: string }>('bookrail_hold_create', {
      service_id: serviceId,
      start: start as string,
      duration_minutes: 60,
      ttl: '10m',
      customer_email: 'ada@example.com',
      customer_name: 'Ada',
    });
    expect(hold.isError).toBe(false);
    expect(hold.envelope.data?.id.startsWith('hold_')).toBe(true);

    const booking = await session.call<{ id: string; status: string; hold_id: string | null }>(
      'bookrail_booking_create',
      {
        service_id: serviceId,
        start: start as string,
        duration_minutes: 60,
        hold_id: hold.envelope.data?.id,
        customer_email: 'ada@example.com',
        customer_name: 'Ada',
      },
    );
    expect(booking.isError).toBe(false);
    expect(booking.envelope.data?.id.startsWith('bk_')).toBe(true);
    bookingId = booking.envelope.data?.id ?? '';
    bookingStart = start as string;
  });

  it('12. reads the booking back and finds its creation in the event log', async () => {
    const read = await session.call<{ id: string; status: string }>('bookrail_booking_get', {
      booking_id: bookingId,
    });
    expect(read.envelope.data?.id).toBe(bookingId);

    const events = await session.call<{
      data: { type: string; data: { object: { id: string } } }[];
    }>('bookrail_events_list', { type: ['booking.created'], limit: 20 });
    const found = events.envelope.data?.data.find((event) => event.data.object.id === bookingId);
    expect(found?.type).toBe('booking.created');
  });

  it('13. shows the slot is now taken', async () => {
    const check = await session.call<{ available: boolean; reasons?: { code: string }[] }>(
      'bookrail_availability_check',
      { service_id: serviceId, start: bookingStart, duration_minutes: 60, quantity: 2 },
    );
    // Two courts, one taken: asking for two units at once no longer fits.
    expect(check.envelope.data?.available).toBe(false);
  });

  it('14. previews a cancellation without cancelling', async () => {
    const preview = await session.call<never>('bookrail_booking_cancel', {
      booking_id: bookingId,
    });
    expect(preview.isError).toBe(false);
    expect(preview.envelope.requires_confirmation).toBe(true);
    expect((preview.envelope.preview as { id: string }).id).toBe(bookingId);

    const still = await session.call<{ status: string }>('bookrail_booking_get', {
      booking_id: bookingId,
    });
    expect(still.envelope.data?.status).not.toBe('cancelled');
  });

  it('15. cancels with confirm, and the refund follows the frozen policy', async () => {
    const result = await session.call<{ status: string; refund_percent: number | null }>(
      'bookrail_booking_cancel',
      { booking_id: bookingId, confirm: true, by: 'customer', reason: 'rain' },
    );
    expect(result.isError).toBe(false);
    expect(result.envelope.data?.status).toBe('cancelled');
    expect(result.envelope.data?.refund_percent).toBe(100);
  });

  it('16. previews and then performs a delete', async () => {
    const created = await session.call<{ id: string }>('bookrail_object_create', {
      kind: 'customers',
      data: { email: 'to-delete@example.com', name: 'Temporary' },
    });
    const id = created.envelope.data?.id ?? '';
    expect(id.startsWith('cus_')).toBe(true);

    const preview = await session.call<never>('bookrail_object_delete', {
      kind: 'customers',
      id,
    });
    expect(preview.envelope.requires_confirmation).toBe(true);
    expect((preview.envelope.preview as { email: string }).email).toBe('to-delete@example.com');

    const stillThere = await session.call<{ id: string }>('bookrail_object_get', {
      kind: 'customers',
      id,
    });
    expect(stillThere.envelope.data?.id).toBe(id);

    const deleted = await session.call<{ deleted: boolean }>('bookrail_object_delete', {
      kind: 'customers',
      id,
      confirm: true,
    });
    expect(deleted.envelope.data?.deleted).toBe(true);
  });
});

/**
 * The tools the walkthrough does not reach, exercised against the same real API.
 *
 * The `006` suite left seven of the thirty-four registered against the server and asserted only
 * through `tools/list`, which proves the schema and nothing about what happens when the tool is
 * called. These are pass-through tools, so what is being checked is not clever: that the argv
 * the tool builds is the argv the CLI accepts, and that the envelope comes back `ok`. That is
 * exactly the class of bug a wrong flag name produces, and the class `tools/list` cannot catch.
 */
describe('the tools the walkthrough does not reach', () => {
  it('bookrail_hold_get and bookrail_hold_release, through the API', async () => {
    const next = await session.call<{ next_available: string | null }>(
      'bookrail_availability_next',
      {
        service_id: serviceId,
        duration_minutes: 60,
      },
    );
    const start = next.envelope.data?.next_available;
    expect(start).toBeTruthy();

    const hold = await session.call<{ id: string }>('bookrail_hold_create', {
      service_id: serviceId,
      start: start as string,
      duration_minutes: 60,
      ttl: '10m',
    });
    expect(hold.isError).toBe(false);
    const holdId = hold.envelope.data?.id ?? '';

    const read = await session.call<{ id: string; status: string; booking_id: string | null }>(
      'bookrail_hold_get',
      { hold_id: holdId },
    );
    expect(read.isError).toBe(false);
    expect(read.envelope.data?.id).toBe(holdId);
    expect(read.envelope.data?.status).toBe('active');
    expect(read.envelope.data?.booking_id).toBeNull();

    const released = await session.call<{ deleted: boolean }>('bookrail_hold_release', {
      hold_id: holdId,
    });
    expect(released.isError).toBe(false);
    expect(released.envelope.data?.deleted).toBe(true);

    const after = await session.call<{ status: string }>('bookrail_hold_get', {
      hold_id: holdId,
    });
    expect(after.envelope.data?.status).toBe('released');
  });

  it('bookrail_booking_transition and bookrail_booking_reschedule, on a real booking', async () => {
    const slots = await session.call<{ slots: { start: string }[] }>('bookrail_availability', {
      service_id: serviceId,
      from: nextWeek(9),
      to: nextWeek(10),
      duration_minutes: 60,
    });
    const first = slots.envelope.data?.slots[0]?.start;
    const second = slots.envelope.data?.slots[1]?.start;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    const booking = await session.call<{ id: string; status: string }>('bookrail_booking_create', {
      service_id: serviceId,
      start: first as string,
      duration_minutes: 60,
      customer_email: 'transitions@example.com',
    });
    expect(booking.isError).toBe(false);
    const bookingId = booking.envelope.data?.id ?? '';

    // This policy requires no confirmation, so the booking is already `confirmed` when it is
    // created, and `confirm` from there is an `invalid_transition`.
    expect(booking.envelope.data?.status).toBe('confirmed');

    // A reschedule creates a **new** booking and leaves the old one as `rescheduled`, so the
    // id in the answer is not the id that went in.
    const moved = await session.call<{ id: string; start: string; status: string }>(
      'bookrail_booking_reschedule',
      { booking_id: bookingId, start: second as string, confirm: true },
    );
    expect(moved.isError).toBe(false);
    expect(moved.envelope.data?.start).toBe(second);
    expect(moved.envelope.data?.id).not.toBe(bookingId);
    const movedId = moved.envelope.data?.id ?? '';

    const old = await session.call<{ status: string }>('bookrail_booking_get', {
      booking_id: bookingId,
    });
    expect(old.envelope.data?.status).toBe('rescheduled');

    const checkedIn = await session.call<{ id: string; status: string }>(
      'bookrail_booking_transition',
      { booking_id: movedId, action: 'check_in' },
    );
    expect(checkedIn.isError).toBe(false);
    expect(checkedIn.envelope.data?.status).toBe('in_progress');

    // And a transition the matrix forbids comes back as the API's own error, not as a
    // malformed command: which is the other half of "the argv is right".
    const refused = await session.call('bookrail_booking_transition', {
      booking_id: movedId,
      action: 'confirm',
    });
    expect(refused.isError).toBe(true);
    expect(refused.envelope.error?.code).toBe('invalid_transition');

    const listed = await session.call<{ data: { id: string }[] }>('bookrail_booking_list', {
      status: 'confirmed',
      limit: 100,
    });
    expect(listed.isError).toBe(false);

    await session.call('bookrail_booking_cancel', { booking_id: movedId, confirm: true });
  });

  it('bookrail_object_update writes through to the API', async () => {
    const created = await session.call<{ id: string }>('bookrail_object_create', {
      kind: 'customers',
      data: { email: 'updatable@example.com', name: 'Before' },
    });
    const id = created.envelope.data?.id ?? '';

    const updated = await session.call<{ id: string; name: string }>('bookrail_object_update', {
      kind: 'customers',
      id,
      data: { name: 'After' },
    });
    expect(updated.isError).toBe(false);
    expect(updated.envelope.data?.name).toBe('After');

    const read = await session.call<{ name: string }>('bookrail_object_get', {
      kind: 'customers',
      id,
    });
    expect(read.envelope.data?.name).toBe('After');
  });

  it('bookrail_event_get reads back one event of the log', async () => {
    const list = await session.call<{ data: { id: string; type: string }[] }>(
      'bookrail_events_list',
      { limit: 5 },
    );
    const first = list.envelope.data?.data[0];
    expect(first).toBeDefined();

    const one = await session.call<{ id: string; type: string; data: { object: unknown } }>(
      'bookrail_event_get',
      { event_id: first?.id },
    );
    expect(one.isError).toBe(false);
    expect(one.envelope.data?.id).toBe(first?.id);
    expect(one.envelope.data?.type).toBe(first?.type);
  });

  it('bookrail_availability_next honours `quantity`', async () => {
    const one = await session.call<{ next_available: string | null }>(
      'bookrail_availability_next',
      { service_id: serviceId, duration_minutes: 60, quantity: 1 },
    );
    expect(one.isError).toBe(false);
    expect(one.envelope.data?.next_available).toBeTruthy();

    // The padel service has `capacity_per_booking: 1`, so two units are never servable, and
    // the answer is `null` with `searched_through`, not an error: "nothing in the horizon" is
    // an answer, and it is the answer that proves the parameter reached the server.
    const two = await session.call<{ next_available: string | null; searched_through: string }>(
      'bookrail_availability_next',
      { service_id: serviceId, duration_minutes: 60, quantity: 2 },
    );
    expect(two.isError).toBe(false);
    expect(two.envelope.data?.next_available).toBeNull();
    expect(two.envelope.data?.searched_through).toBeTruthy();
    expect(two.envelope.next_steps?.join(' ')).toContain('90 days');
  });

  it('bookrail_resource_blocks lists what is closed on a resource', async () => {
    const resources = await session.call<{ data: { id: string }[] }>('bookrail_objects_list', {
      kind: 'resources',
      limit: 100,
    });
    const resourceId = resources.envelope.data?.data[0]?.id ?? '';
    expect(resourceId.startsWith('res_')).toBe(true);

    const empty = await session.call<{ data: unknown[] }>('bookrail_resource_blocks', {
      resource_id: resourceId,
    });
    expect(empty.isError).toBe(false);
    expect(empty.envelope.data?.data).toEqual([]);

    // The block itself has no tool yet, so it goes through the API the way a customer would.
    const created = await fetch(`${h.url}/v1/resources/${resourceId}/block`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${project.testKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: '2027-08-01T09:00:00Z',
        to: '2027-08-01T11:00:00Z',
        reason: 'maintenance',
      }),
    });
    expect(created.status).toBe(201);

    const listed = await session.call<{ data: { id: string; reason: string }[] }>(
      'bookrail_resource_blocks',
      { resource_id: resourceId },
    );
    expect(listed.isError).toBe(false);
    expect(listed.envelope.data?.data).toHaveLength(1);
    expect(listed.envelope.data?.data[0]?.reason).toBe('maintenance');
    expect(listed.envelope.data?.data[0]?.id.startsWith('blk_')).toBe(true);
  });

  it('bookrail_doctor answers against the real API', async () => {
    const result = await session.call<{ checks: { name: string; status: string }[] }>(
      'bookrail_doctor',
      {},
    );
    expect(result.isError).toBe(false);
    const names = result.envelope.data?.checks.map((check) => check.name) ?? [];
    expect(names).toContain('api_reachable');
    expect(names).toContain('project');
    const failed = result.envelope.data?.checks.filter((check) => check.status === 'fail') ?? [];
    expect(failed.map((check) => check.name)).toEqual([]);
  });

  it('bookrail_config_pull on a project that has nothing in it', async () => {
    const empty = await h.bootstrap('MCP Empty');
    const other = await h.session({
      cwd: await h.workdir(),
      env: { BOOKRAIL_SECRET_KEY: empty.testKey },
    });
    try {
      const pulled = await other.call<{
        config: Record<string, unknown>;
        written: string | null;
        stamped: unknown[];
        adopted: unknown[];
      }>('bookrail_config_pull', {});
      expect(pulled.isError).toBe(false);
      expect(pulled.envelope.ok).toBe(true);
      expect(pulled.envelope.data?.adopted).toEqual([]);
      expect(pulled.envelope.data?.stamped).toEqual([]);
      // Read only, on the project and on the disk: `--stdout`, so nothing was written.
      expect(pulled.envelope.data?.written).toBeNull();
      // Nothing to adopt means the "run pull --adopt first" advice is absent, and the next step
      // is the push.
      expect(pulled.envelope.next_steps?.join(' ')).toContain('bookrail_config_push');
      for (const value of Object.values(pulled.envelope.data?.config ?? {})) {
        if (Array.isArray(value)) expect(value).toEqual([]);
        else if (value !== null && typeof value === 'object') expect(value).toEqual({});
      }
    } finally {
      await other.close();
    }
  });
});

/**
 * The temporary file `bookrail_config_push` writes for an inline configuration.
 *
 * It is not secret (a booking model, not a key) but a server started by `npx` on every
 * session that leaves a directory behind every time is a server that fills a laptop's temp
 * directory over a year. The assertion is on what *this* push created, not on the root being
 * empty: another process on the same machine may legitimately have one open.
 */
describe('the inline-config temporary directory', () => {
  async function entries(): Promise<string[]> {
    try {
      return (await readdir(TEMP_ROOT)).sort();
    } catch {
      return [];
    }
  }

  it('leaves nothing behind after a push', async () => {
    const before = await entries();
    const pushed = await session.call<{ applied: boolean }>('bookrail_config_push', {
      config: PADEL_CONFIG,
      dry_run: false,
      confirm: true,
    });
    expect(pushed.isError).toBe(false);
    expect(await entries()).toEqual(before);
  });

  it('leaves nothing behind when the push fails', async () => {
    const before = await entries();
    const failed = await session.call('bookrail_config_push', {
      config: { services: [{ id: 'broken', name: 'Broken', requirements: [{ group: 'nope' }] }] },
      dry_run: true,
    });
    expect(failed.isError).toBe(true);
    expect(await entries()).toEqual(before);
  });

  it('registers its signal handlers only once, however many pushes there are', async () => {
    const counts = (): number => process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
    await session.call('bookrail_config_push', { config: PADEL_CONFIG, dry_run: true });
    const after = counts();
    await session.call('bookrail_config_push', { config: PADEL_CONFIG, dry_run: true });
    await session.call('bookrail_config_push', { config: PADEL_CONFIG, dry_run: true });
    // A handler installed per call is a leak that only shows up after a few hours of use.
    expect(counts()).toBe(after);
  });
});

describe('webhooks', () => {
  let receiver: Server | null = null;
  const received: string[] = [];

  afterAll(async () => {
    if (receiver !== null) await new Promise<void>((resolve) => receiver?.close(() => resolve()));
  });

  it('registers an endpoint, delivers to it, and removes it behind a confirmation', async () => {
    // On the test environment a plain http endpoint is accepted on ports 8080-8099. The
    // receiver is a real socket, so `bookrail_webhook_test` is a real delivery and not a
    // simulation.
    const port = await listenSomewhere();
    const created = await session.call<{ id: string; secret: string; url: string }>(
      'bookrail_webhook_create',
      { url: `http://127.0.0.1:${String(port)}/hooks`, events: ['booking.created'] },
    );
    expect(created.isError).toBe(false);
    expect(created.envelope.data?.secret).toBeTruthy();
    expect(created.envelope.next_steps?.join(' ')).toContain('shown once');
    const id = created.envelope.data?.id ?? '';

    const listed = await session.call<{ data: Record<string, unknown>[] }>(
      'bookrail_webhook_list',
      {},
    );
    expect(listed.envelope.data?.data.some((row) => row.id === id)).toBe(true);
    // The secret is returned once and never again.
    expect(JSON.stringify(listed.envelope.data)).not.toContain(
      created.envelope.data?.secret ?? '?',
    );

    const tested = await session.call<{ status: string; response_status: number | null }>(
      'bookrail_webhook_test',
      { webhook_id: id },
    );
    expect(tested.isError).toBe(false);
    expect(tested.envelope.ok).toBe(true);
    expect(tested.envelope.data?.status).toBe('succeeded');
    expect(received.length).toBe(1);

    const deliveries = await session.call<{ data: { status: string }[] }>(
      'bookrail_webhook_deliveries',
      { webhook_id: id },
    );
    expect(deliveries.envelope.data?.data.length).toBeGreaterThan(0);

    const preview = await session.call<never>('bookrail_webhook_delete', { webhook_id: id });
    expect(preview.envelope.requires_confirmation).toBe(true);
    const stillThere = await session.call<{ data: Record<string, unknown>[] }>(
      'bookrail_webhook_list',
      {},
    );
    expect(stillThere.envelope.data?.data.some((row) => row.id === id)).toBe(true);

    const removed = await session.call<{ deleted: boolean }>('bookrail_webhook_delete', {
      webhook_id: id,
      confirm: true,
    });
    expect(removed.envelope.data?.deleted).toBe(true);
  });

  async function listenSomewhere(): Promise<number> {
    for (let port = 8080; port <= 8099; port += 1) {
      const server = createHttpServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          received.push(Buffer.concat(chunks).toString('utf8'));
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"ok":true}');
        });
      });
      const bound = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (bound) {
        receiver = server;
        return port;
      }
    }
    throw new Error('no free port in 8080-8099 for the webhook receiver');
  }
});
