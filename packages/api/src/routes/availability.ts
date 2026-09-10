/**
 * `POST /v1/availability`, `GET /v1/availability/next`, `POST /v1/availability/check`.
 *
 * The three availability endpoints. They are thin on purpose: the calculation is
 * `@bookrail/engine` and nothing here reimplements any part of it. What lives here is the HTTP
 * contract (ISO 8601 in, UTC out, prefixed identifiers, the documented error codes) plus the
 * two guards a public endpoint owes its callers:
 *
 * 1. **ceilings are refused, never crashed into.** The engine protects itself with
 *    `EngineLimitError` (`discretize`'s `maxInstants`, `materializeSchedule`'s `maxDays`),
 *    which is the right thing for a library and a 500 for an API. The window is checked against
 *    `MAX_RANGE_DAYS` before the database is touched, the window × interval product against
 *    `DEFAULT_MAX_INSTANTS` as soon as the service is known, and anything that still escapes is
 *    translated into a 400, by its `code`, not by a regular expression over its message;
 * 2. **`explain` is capped at seven days.** It costs up to three materializations per
 *    resource plus a second residual timeline, and it is a debugging tool, not a listing.
 *
 * The cache sits under the engine, not over these handlers: the response is always
 * recomputed, from per (resource, local day) entries. See `packages/engine/src/cache/` for why
 * that is the only safe level to cache at: a stored response would be a window computed with an
 * old `now`, while the two lower entries are a pure function of the data.
 */
import { Hono } from 'hono';
import {
  computeAvailability,
  DEFAULT_MAX_INSTANTS,
  EngineLimitError,
  loadAvailabilityData,
  loadOpenTimelines,
  MAX_RANGE_DAYS,
  serviceDurations,
  type AvailabilityData,
  type AvailabilityResult,
  type AvailabilitySlot,
  type Granularity,
  type ServiceData,
} from '@bookrail/engine';
import { errors } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import { inProject, parseJsonBody, parseQuery } from '../http.js';
import {
  availabilityCheckSchema,
  availabilityNextQuerySchema,
  availabilityRequestSchema,
} from '../schemas/index.js';
import {
  serializeAvailability,
  serializeAvailabilitySlot,
  serializeExplainEntry,
  serializeResourceOption,
} from '../serialize.js';
import { encodeId } from '@bookrail/shared';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Widest window `explain: true` may cover. */
export const MAX_EXPLAIN_DAYS = 7;

/** `GET /v1/availability/next` scans the horizon one window at a time. */
export const NEXT_WINDOW_DAYS = 30;
export const NEXT_HORIZON_DAYS = 90;

interface LoadQuery {
  serviceId: string;
  from: number;
  to: number;
  resourceIds?: readonly string[] | null;
  customerId?: string | null;
}

/**
 * An `EngineLimitError` is a ceiling the caller crossed or an argument the engine will not
 * accept, never a server fault, and never a 500.
 *
 * It used to be read off the **message**: `/instants|local days/` meant `range_too_large` and
 * anything else meant `parameter_invalid`, which made the wording of an engine error part of
 * the public API contract without anybody saying so. The engine carries the code itself now
 * (`EngineLimitError`), so this translates by type and the two documented
 * codes, `range_too_large` and `parameter_invalid`, are unchanged.
 *
 * A bare `RangeError` is deliberately **not** caught: the engine no longer throws one on this
 * path, so one arriving here would be a genuine bug, and turning it into a 400 would hide it.
 */
function asRequestError(error: unknown): unknown {
  if (!(error instanceof EngineLimitError)) return error;
  return errors.invalidRequest(error.message, error.param, error.code);
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw asRequestError(error);
  }
}

function assertWindow(from: number, to: number, explain: boolean): void {
  if (to - from > MAX_RANGE_DAYS * DAY_MS) {
    throw errors.invalidRequest(
      `An availability request may not span more than ${String(MAX_RANGE_DAYS)} days; page the window instead.`,
      'to',
      'range_too_large',
    );
  }
  if (explain && to - from > MAX_EXPLAIN_DAYS * DAY_MS) {
    throw errors.invalidRequest(
      `explain may not span more than ${String(MAX_EXPLAIN_DAYS)} days; it reports on every candidate instant of the window.`,
      'explain',
      'range_too_large',
    );
  }
}

/**
 * Refuses, before any calendar is materialized, a window whose slot grid could not fit under
 * `DEFAULT_MAX_INSTANTS`.
 *
 * The bound is exact from above: each duration option contributes at most one instant per
 * `slot_interval`, and the engine spends the ceiling across all of them. Without this a
 * ninety day window on a one minute grid reaches `discretize`'s ceiling and the caller gets
 * a 500 for a request that was simply too fine.
 */
function assertInstantBudget(service: ServiceData, from: number, to: number): void {
  const durations = serviceDurations(service);
  const intervalMs = (service.slotIntervalMinutes ?? durations[0]!) * MINUTE_MS;
  const upperBound = durations.length * Math.ceil((to - from) / intervalMs);
  if (upperBound > DEFAULT_MAX_INSTANTS) {
    throw errors.invalidRequest(
      `This window would produce up to ${String(upperBound)} candidate instants, over the ${String(DEFAULT_MAX_INSTANTS)} ceiling; narrow the window or widen slot_interval.`,
      'to',
      'range_too_large',
    );
  }
}

export function availabilityRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  const load = (c: Parameters<typeof inProject>[0], query: LoadQuery): Promise<AvailabilityData> =>
    guarded(() =>
      inProject(c, deps, (tx) =>
        loadAvailabilityData(
          tx,
          {
            serviceId: query.serviceId,
            from: query.from,
            to: query.to,
            resourceIds: query.resourceIds ?? null,
            customerId: query.customerId ?? null,
          },
          { occupancyCache: { cache: deps.cache } },
        ),
      ),
    );

  /**
   * Fills the open timelines from the (resource, day) cache and runs the engine on them.
   * Outside the database transaction on purpose: the cache round trip must not hold a
   * Postgres connection open.
   */
  const compute = (
    data: AvailabilityData,
    input: {
      from: number;
      to: number;
      quantity?: number | null;
      granularity?: Granularity;
      explain?: boolean;
      candidates?: readonly number[];
    },
  ): Promise<AvailabilityResult> =>
    guarded(async () => {
      const { timelines } = await loadOpenTimelines(data, input.from, input.to, {
        cache: deps.cache,
      });
      return computeAvailability({ ...input, data, now: Date.now(), openTimelines: timelines });
    });

  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, availabilityRequestSchema);
    const from = body.from.getTime();
    const to = body.to.getTime();
    const explain = body.explain === true;
    const granularity: Granularity = body.granularity ?? 'slots';
    assertWindow(from, to, explain);

    const data = await load(c, {
      serviceId: body.service_id,
      from,
      to,
      resourceIds: body.resource_ids ?? null,
      customerId: body.customer_id ?? null,
    });
    // A `ranges` request without `explain` never discretizes, so the grid ceiling does not
    // apply to it.
    if (granularity === 'slots' || explain) assertInstantBudget(data.service, from, to);

    const result = await compute(data, {
      from,
      to,
      quantity: body.quantity ?? null,
      granularity,
      explain,
    });

    return c.json(
      serializeAvailability(result, {
        serviceId: data.service.id,
        timezone: body.timezone ?? data.timezone,
        granularity,
        truncateEndAt: to,
      }),
    );
  });

  /**
   * The next bookable slot, searched one thirty day window at a time up to ninety days.
   *
   * Windows rather than one ninety day request because the common answer is "tomorrow": the
   * first window almost always finds it, and a request that has to reach the horizon pays
   * three cheap passes instead of one expensive one.
   */
  routes.get('/next', async (c) => {
    const query = parseQuery(c, availabilityNextQuerySchema);
    const now = Date.now();
    const start = query.from === undefined ? now : query.from.getTime();
    const horizon = start + NEXT_HORIZON_DAYS * DAY_MS;

    let cursor = start;
    let found: AvailabilitySlot | null = null;
    let timezone: string | null = null;
    let searched = start;

    while (cursor < horizon && found === null) {
      const to = Math.min(cursor + NEXT_WINDOW_DAYS * DAY_MS, horizon);
      const data = await load(c, { serviceId: query.service_id, from: cursor, to });
      assertInstantBudget(data.service, cursor, to);
      timezone = query.timezone ?? data.timezone;
      const result = await compute(data, {
        from: cursor,
        to,
        quantity: query.quantity ?? null,
        granularity: 'slots',
      });
      found = result.slots[0] ?? null;
      searched = to;
      cursor = to;
    }

    return c.json({
      object: 'availability_next',
      service_id: encodeId('service', query.service_id),
      timezone: timezone ?? 'UTC',
      next_available: found === null ? null : new Date(found.start).toISOString(),
      slot: found === null ? null : serializeAvailabilitySlot(found),
      searched_through: new Date(searched).toISOString(),
    });
  });

  /**
   * One precise instant, the call a client makes between showing a slot and booking it.
   *
   * The instant is handed to the engine as the **only** candidate, which is what makes the
   * answer useful: a start that is not on the service's grid (outside the opening hours, in
   * the middle of a block) still gets structured reasons instead of a bare "no". The check
   * is therefore about feasibility at that instant, not about grid alignment; a client that
   * wants the grid asks `POST /v1/availability`.
   */
  routes.post('/check', async (c) => {
    const body = await parseJsonBody(c, availabilityCheckSchema);
    const start = body.start.getTime();
    const loaded = await load(c, {
      serviceId: body.service_id,
      from: start,
      to: start + 1,
      resourceIds: body.resource_ids ?? null,
    });
    const data = withDuration(loaded, body.duration_minutes);

    const result = await compute(data, {
      from: start,
      to: start + 1,
      quantity: body.quantity ?? null,
      granularity: 'slots',
      explain: true,
      candidates: [start],
    });

    const slot = result.slots.find((candidate) => candidate.start === start) ?? null;
    const entry = result.explain?.find((candidate) => candidate.at === start);
    const payload: Record<string, unknown> = {
      object: 'availability_check',
      service_id: encodeId('service', data.service.id),
      start: new Date(start).toISOString(),
      duration_minutes: slot?.durationMinutes ?? serviceDurations(data.service)[0] ?? null,
      available: slot !== null,
      available_capacity: slot?.availableCapacity ?? 0,
      price:
        slot?.price === undefined || slot.price === null
          ? null
          : { amount: slot.price.amount, currency: slot.price.currency },
      price_rule: slot?.priceRule ?? null,
      resource_options: (slot?.resourceOptions ?? []).map(serializeResourceOption),
    };
    if (slot === null) {
      payload.reasons = entry === undefined ? [] : serializeExplainEntry(entry).reasons;
    }
    if (result.reason !== undefined) {
      payload.reason = { code: result.reason.code, message: result.reason.detail };
    }
    return c.json(payload);
  });

  return routes;
}

/**
 * Narrows a multi-duration service to the one duration the caller is checking.
 *
 * A `duration_minutes` the service does not offer is a client error, not an empty answer:
 * answering "unavailable" would send the caller looking for a booking conflict that does not
 * exist.
 */
function withDuration(data: AvailabilityData, minutes: number | undefined): AvailabilityData {
  if (minutes === undefined) return data;
  const service = data.service;
  const options = service.durationOptions;
  const allowed =
    options !== null && options.length > 0
      ? options.includes(minutes)
      : service.durationMinutes !== null
        ? service.durationMinutes === minutes
        : service.durationMinMinutes !== null && service.durationMaxMinutes !== null
          ? minutes >= service.durationMinMinutes && minutes <= service.durationMaxMinutes
          : false;
  if (!allowed) {
    throw errors.invalidRequest(
      `This service does not offer a ${String(minutes)} minute booking.`,
      'duration_minutes',
      'parameter_invalid',
    );
  }
  return {
    ...data,
    service: {
      ...service,
      durationMinutes: minutes,
      durationOptions: null,
      durationMinMinutes: null,
      durationMaxMinutes: null,
    },
  };
}
