import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';

export interface SeededProject {
  accountId: string;
  projectId: string;
}

export async function createProject(client: Client, name: string): Promise<SeededProject> {
  const accountId = uuidv7();
  const projectId = uuidv7();
  await client.query(`INSERT INTO accounts (id, name, api_version) VALUES ($1, $2, '2026-09-01')`, [
    accountId,
    name,
  ]);
  await client.query(`INSERT INTO projects (id, account_id, name) VALUES ($1, $2, $3)`, [
    projectId,
    accountId,
    name,
  ]);
  return { accountId, projectId };
}

export interface SeededRows {
  [table: string]: string;
}

export interface SeedOptions {
  resourceCapacity?: number;
}

/**
 * Inserts exactly one row in every project table, in dependency order, for the given
 * (project, environment). Run through the admin connection, which bypasses RLS, so the RLS
 * tests can then check what the application role is and is not allowed to see.
 */
export async function seedProjectData(
  client: Client,
  projectId: string,
  environment: 'test' | 'live',
  options: SeedOptions = {},
): Promise<SeededRows> {
  const id = (): string => uuidv7();
  const scope = [projectId, environment];
  const rows: SeededRows = {};

  const locationId = id();
  await client.query(
    `INSERT INTO locations (id, project_id, environment, name, timezone)
     VALUES ($1, $2, $3, 'HQ', 'Europe/Rome')`,
    [locationId, ...scope],
  );
  rows.locations = locationId;

  const scheduleId = id();
  await client.query(
    `INSERT INTO schedules (id, project_id, environment, name) VALUES ($1, $2, $3, 'Weekdays')`,
    [scheduleId, ...scope],
  );
  rows.schedules = scheduleId;

  const ruleId = id();
  await client.query(
    `INSERT INTO schedule_rules (id, project_id, environment, schedule_id, days_of_week, start_time, end_time)
     VALUES ($1, $2, $3, $4, ARRAY[1,2,3,4,5]::smallint[], '09:00', '18:00')`,
    [ruleId, ...scope, scheduleId],
  );
  rows.schedule_rules = ruleId;

  const exceptionId = id();
  await client.query(
    `INSERT INTO schedule_exceptions (id, project_id, environment, schedule_id, date, type)
     VALUES ($1, $2, $3, $4, '2026-08-15', 'closed')`,
    [exceptionId, ...scope, scheduleId],
  );
  rows.schedule_exceptions = exceptionId;

  const resourceId = id();
  await client.query(
    `INSERT INTO resources (id, project_id, environment, name, type, location_id, schedule_id, capacity)
     VALUES ($1, $2, $3, 'Court 1', 'room', $4, $5, $6)`,
    [resourceId, ...scope, locationId, scheduleId, options.resourceCapacity ?? 1],
  );
  rows.resources = resourceId;

  const groupId = id();
  await client.query(
    `INSERT INTO resource_groups (id, project_id, environment, name) VALUES ($1, $2, $3, 'Courts')`,
    [groupId, ...scope],
  );
  rows.resource_groups = groupId;

  const memberId = id();
  await client.query(
    `INSERT INTO resource_group_members (id, project_id, environment, resource_group_id, resource_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [memberId, ...scope, groupId, resourceId],
  );
  rows.resource_group_members = memberId;

  const blockId = id();
  await client.query(
    `INSERT INTO resource_blocks (id, project_id, environment, resource_id, period, reason)
     VALUES ($1, $2, $3, $4, tstzrange('2026-12-24T00:00:00Z','2026-12-26T00:00:00Z','[)'), 'holidays')`,
    [blockId, ...scope, resourceId],
  );
  rows.resource_blocks = blockId;

  const policyId = id();
  await client.query(
    `INSERT INTO policies (id, project_id, environment, name) VALUES ($1, $2, $3, 'Standard')`,
    [policyId, ...scope],
  );
  rows.policies = policyId;

  const serviceId = id();
  await client.query(
    `INSERT INTO services (id, project_id, environment, name, duration_minutes, policy_id)
     VALUES ($1, $2, $3, 'Match 60', 60, $4)`,
    [serviceId, ...scope, policyId],
  );
  rows.services = serviceId;

  const requirementId = id();
  await client.query(
    `INSERT INTO service_requirements (id, project_id, environment, service_id, resource_id, quantity)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [requirementId, ...scope, serviceId, resourceId],
  );
  rows.service_requirements = requirementId;

  const customerId = id();
  await client.query(
    `INSERT INTO customers (id, project_id, environment, external_id, email, name)
     VALUES ($1, $2, $3, $4, 'ada@example.com', 'Ada')`,
    [customerId, ...scope, `ext-${customerId}`],
  );
  rows.customers = customerId;

  const recurrenceId = id();
  await client.query(
    `INSERT INTO recurrences (id, project_id, environment, service_id, customer_id, rrule, starts_at)
     VALUES ($1, $2, $3, $4, $5, 'FREQ=WEEKLY;COUNT=10', '2026-09-08T07:00:00Z')`,
    [recurrenceId, ...scope, serviceId, customerId],
  );
  rows.recurrences = recurrenceId;

  const holdId = id();
  await client.query(
    `INSERT INTO holds (id, project_id, environment, service_id, customer_id, starts_at, ends_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, '2026-09-08T07:00:00Z', '2026-09-08T08:00:00Z', '2026-09-08T06:10:00Z')`,
    [holdId, ...scope, serviceId, customerId],
  );
  rows.holds = holdId;

  const bookingId = id();
  await client.query(
    `INSERT INTO bookings (id, project_id, environment, service_id, customer_id, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, $4, $5, '2026-09-08T07:00:00Z', '2026-09-08T08:00:00Z', 'Europe/Rome')`,
    [bookingId, ...scope, serviceId, customerId],
  );
  rows.bookings = bookingId;

  const allocationId = id();
  await client.query(
    `INSERT INTO booking_allocations (id, project_id, environment, booking_id, resource_id, capacity_used)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [allocationId, ...scope, bookingId, resourceId],
  );
  rows.booking_allocations = allocationId;

  const occupancyId = id();
  await client.query(
    `INSERT INTO occupancies (id, project_id, environment, resource_id, period, capacity_used, kind, ref_id)
     VALUES ($1, $2, $3, $4, tstzrange('2026-09-08T07:00:00Z','2026-09-08T08:00:00Z','[)'), 1, 'booking', $5)`,
    [occupancyId, ...scope, resourceId, bookingId],
  );
  rows.occupancies = occupancyId;

  const waitlistId = id();
  await client.query(
    `INSERT INTO waitlist_entries (id, project_id, environment, customer_id, service_id, window_from, window_to)
     VALUES ($1, $2, $3, $4, $5, '2026-09-08T00:00:00Z', '2026-09-09T00:00:00Z')`,
    [waitlistId, ...scope, customerId, serviceId],
  );
  rows.waitlist_entries = waitlistId;

  const entitlementId = id();
  await client.query(
    `INSERT INTO entitlements (id, project_id, environment, customer_id, type, total, remaining)
     VALUES ($1, $2, $3, $4, 'package', 10, 10)`,
    [entitlementId, ...scope, customerId],
  );
  rows.entitlements = entitlementId;

  const paymentId = id();
  await client.query(
    `INSERT INTO payments (id, project_id, environment, booking_id, provider, provider_account_id,
                           type, amount, currency)
     VALUES ($1, $2, $3, $4, 'stripe', $5, 'deposit', 2500, 'EUR')`,
    [paymentId, ...scope, bookingId, `acct_${paymentId.replaceAll('-', '')}`],
  );
  rows.payments = paymentId;

  // One incoming provider event, attributed to this project. The identifier is global (the
  // unique is on `(provider, provider_event_id)` alone), so it is derived from the row id.
  const providerEventId = id();
  await client.query(
    `INSERT INTO payment_provider_events (id, project_id, environment, provider,
                                          provider_event_id, type, provider_account_id,
                                          processed_at, outcome)
     VALUES ($1, $2, $3, 'stripe', $4, 'payment_intent.succeeded', $5, now(), 'applied')`,
    [
      providerEventId,
      ...scope,
      `evt_${providerEventId.replaceAll('-', '')}`,
      `acct_${paymentId.replaceAll('-', '')}`,
    ],
  );
  rows.payment_provider_events = providerEventId;

  // The plan counter exists in the live environment only (a CHECK refuses a test row), so a
  // test scope gets no row here and the isolation tests expect none.
  if (environment === 'live') {
    const usageId = id();
    await client.query(
      `INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed,
                               payment_volume, currency)
       VALUES ($1, $2, $3, '2026-09', 3, 4500, 'EUR')`,
      [usageId, ...scope],
    );
    rows.plan_usage = usageId;
  }

  const eventId = id();
  await client.query(
    `INSERT INTO events (id, project_id, environment, type, data, api_version)
     VALUES ($1, $2, $3, 'booking.created', '{"object":{}}'::jsonb, '2026-09-01')`,
    [eventId, ...scope],
  );
  rows.events = eventId;

  const webhookId = id();
  await client.query(
    `INSERT INTO webhooks (id, project_id, environment, url, secret)
     VALUES ($1, $2, $3, 'https://example.test/hook', 'whsec_test')`,
    [webhookId, ...scope],
  );
  rows.webhooks = webhookId;

  const deliveryId = id();
  await client.query(
    `INSERT INTO webhook_deliveries (id, project_id, environment, webhook_id, event_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [deliveryId, ...scope, webhookId, eventId],
  );
  rows.webhook_deliveries = deliveryId;

  const cursorId = id();
  await client.query(
    `INSERT INTO outbox_cursor (id, project_id, environment, last_txid, last_seq)
     VALUES ($1, $2, $3, '2'::xid8, 0)`,
    [cursorId, ...scope],
  );
  rows.outbox_cursor = cursorId;

  const idempotencyId = id();
  await client.query(
    `INSERT INTO idempotency_keys (id, project_id, environment, key, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, repeat('a', 64), now() + interval '24 hours')`,
    [idempotencyId, ...scope, `key-${idempotencyId}`],
  );
  rows.idempotency_keys = idempotencyId;

  const connectionId = id();
  await client.query(
    `INSERT INTO payment_provider_connections
       (id, project_id, environment, provider, provider_account_id, status, connected_at,
        livemode)
     VALUES ($1, $2, $3, 'stripe', $4, 'connected', now(), $5)`,
    [connectionId, ...scope, `acct_${connectionId.replaceAll('-', '')}`, environment === 'live'],
  );
  rows.payment_provider_connections = connectionId;

  // An OAuth state needs the key that asked for it, and a project fixture has no key of its
  // own, so one is created here. It is not a credential: `key_hash` is a hash of nothing that
  // was ever generated, so there is no text that would authenticate with it.
  const apiKeyId = id();
  await client.query(
    `INSERT INTO api_keys (id, project_id, environment, kind, name, prefix, key_hash)
     VALUES ($1, $2, $3, 'secret', 'fixture', $4, encode(sha256($5::bytea), 'hex'))`,
    [apiKeyId, ...scope, apiKeyId.slice(0, 8), Buffer.from(apiKeyId, 'utf8')],
  );

  const stateId = id();
  await client.query(
    `INSERT INTO stripe_oauth_states (id, project_id, environment, state_hash, api_key_id,
                                      expires_at)
     VALUES ($1, $2, $3, sha256($4::bytea), $5, now() + interval '15 minutes')`,
    [stateId, ...scope, stateId, apiKeyId],
  );
  rows.stripe_oauth_states = stateId;

  return rows;
}
