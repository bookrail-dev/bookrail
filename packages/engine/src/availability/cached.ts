/**
 * The (resource, local day) cache, wired to the two halves of the engine.
 *
 * Two families, one per key prefix:
 *
 * - `avail:open:{resource}:{day}` holds the two open layers of a resource for one local
 *   day: rules alone, and rules ⊕ exceptions. They are a function of the resource, its
 *   schedule and the window only, so they survive every booking. The blocks
 *   are **not** here: a block is an occupancy, and it lives in the other family;
 * - `avail:occ:{resource}:{day}` holds the occupancies overlapping that local day, as rows
 *   rather than as a merged timeline. Rows, because the buffers of the *querying* service
 *   dilate each occupancy separately (`occupancyFootprint`): two adjacent occupancies of one
 *   unit each on a resource of capacity two overlap once dilated, and merging them first
 *   would lose that. Rows also carry the `kind` and `ref_id` that `explain` points at, and
 *   the buffers of the service that wrote them (migration 0009).
 *
 * The final response is never cached. That is the whole design: the engine anchors the slot
 * grid to the opening bands, so the answer is a function of the data plus the `min_notice` /
 * `max_advance` trim, and recomputing it from warm day slices is both cheap and always
 * current with respect to `now`.
 *
 * Day slices are always **whole local days**, so a narrow request can never store a partial
 * day that a wider one would then read as complete. The loader widens its read window for
 * the same reason.
 */
import { localDayRange, localDaysBetween, type LocalDate } from '../schedule/index.js';
import { clip, normalize, type Segment, type Timeline } from '../timeline/index.js';
import {
  cacheKey,
  DEFAULT_OCCUPANCY_TTL_SECONDS,
  DEFAULT_OPEN_TTL_SECONDS,
  type AvailabilityCache,
  type CacheWrite,
} from '../cache/index.js';
import {
  materializationWindow,
  resourceOpenTimelines,
  type AvailabilityData,
  type OccupancyData,
  type OccupancyKind,
  type ResourceData,
  type ResourceOpenTimelines,
} from './compute.js';

/**
 * Bumped whenever the serialized shape changes; an old value is read as a miss.
 *
 * Version 3: the `open` family lost its block layer (blocks are occupancies now) and the `occ`
 * family gained the two per-row buffers.
 */
const FORMAT_VERSION = 3;

/** Cheapest possible wire form of a segment. */
type WireSegment = [start: number, end: number, capacity: number];

interface WireOpen {
  v: number;
  /** Resource capacity the layers were built with; a change makes the entry a miss. */
  c: number;
  /** Zone the local day was computed in; a change makes the entry a miss. */
  z: string;
  r: WireSegment[];
  /** `null` means "identical to `r`". */
  e: WireSegment[] | null;
}

type WireOccupancy = [
  id: string,
  start: number,
  end: number,
  capacityUsed: number,
  kind: OccupancyKind,
  refId: string,
  expiresAt: number | null,
  bufferBeforeMs: number,
  bufferAfterMs: number,
];

interface WireOccupancies {
  v: number;
  o: WireOccupancy[];
}

/** An occupancy as the loader reads it, with the hold expiry the cache has to re-evaluate. */
export interface LoadedOccupancy extends OccupancyData {
  /** `occupancies.expires_at` for a hold, `null` otherwise. */
  readonly expiresAt: number | null;
}

function toWire(timeline: Timeline): WireSegment[] {
  return timeline.map((segment) => [segment.start, segment.end, segment.capacity]);
}

function fromWire(segments: WireSegment[]): Timeline {
  return segments.map(([start, end, capacity]) => ({ start, end, capacity }));
}

// --- Open layers --------------------------------------------------------------------------

export interface OpenTimelineOptions {
  readonly cache: AvailabilityCache;
  readonly ttlSeconds?: number;
  /** Passed to `materializeSchedule` and to the day enumeration. */
  readonly maxDays?: number;
}

export interface OpenTimelineStats {
  readonly hits: number;
  readonly misses: number;
}

export interface OpenTimelinesResult extends OpenTimelineStats {
  /** Ready for `computeAvailability`'s `openTimelines`. */
  readonly timelines: Map<string, ResourceOpenTimelines>;
}

interface DaySlot {
  readonly day: LocalDate;
  readonly start: number;
  readonly end: number;
}

function daysOf(
  timezone: string,
  from: number,
  to: number,
  maxDays: number | undefined,
): DaySlot[] {
  return localDaysBetween(timezone, from, to, maxDays).map((day) => {
    const range = localDayRange(timezone, day);
    return { day, start: range.start, end: range.end };
  });
}

/**
 * Assembles the open layers of every resource of `data` over the window
 * {@link materializationWindow} defines, reading whole local days from the cache and
 * materializing only the days that are missing.
 *
 * The days that miss are materialized in **one** call spanning from the first to the last of
 * them, then sliced: `materializeSchedule` clipped to a sub-window is the same timeline as
 * `materializeSchedule` of that sub-window, so slicing is exact and one cold request costs
 * one materialization per layer, not one per day.
 */
export async function loadOpenTimelines(
  data: AvailabilityData,
  from: number,
  to: number,
  options: OpenTimelineOptions,
): Promise<OpenTimelinesResult> {
  const window = materializationWindow(data.service, from, to);
  const timelines = new Map<string, ResourceOpenTimelines>();
  if (window.to <= window.from || data.resources.length === 0) {
    return { timelines, hits: 0, misses: 0 };
  }

  const ttl = options.ttlSeconds ?? DEFAULT_OPEN_TTL_SECONDS;
  const plan = data.resources.map((resource) => ({
    resource,
    days: daysOf(resource.timezone, window.from, window.to, options.maxDays),
  }));

  const keys: string[] = [];
  for (const entry of plan) {
    for (const slot of entry.days) keys.push(cacheKey('open', entry.resource.id, slot.day));
  }
  const values = await options.cache.getMany(keys);

  const writes: CacheWrite[] = [];
  let cursor = 0;
  let hits = 0;
  let misses = 0;

  for (const entry of plan) {
    const perDay = new Map<LocalDate, ResourceOpenTimelines>();
    const missing: DaySlot[] = [];
    for (const slot of entry.days) {
      const decoded = decodeOpen(values[cursor] ?? null, entry.resource);
      cursor += 1;
      if (decoded === null) {
        missing.push(slot);
        misses += 1;
      } else {
        perDay.set(slot.day, decoded);
        hits += 1;
      }
    }

    if (missing.length > 0) {
      const spanFrom = missing[0]!.start;
      const spanTo = missing[missing.length - 1]!.end;
      const whole = resourceOpenTimelines(entry.resource, spanFrom, spanTo, options.maxDays);
      for (const slot of missing) {
        const sliced = sliceLayers(whole, slot.start, slot.end);
        perDay.set(slot.day, sliced);
        writes.push({
          family: 'open',
          resourceId: entry.resource.id,
          day: slot.day,
          value: encodeOpen(sliced, entry.resource),
          ttlSeconds: ttl,
        });
      }
    }

    timelines.set(entry.resource.id, assembleLayers(entry.days, perDay, window.from, window.to));
  }

  await options.cache.put(writes);
  return { timelines, hits, misses };
}

function sliceLayers(
  layers: ResourceOpenTimelines,
  from: number,
  to: number,
): ResourceOpenTimelines {
  const rulesOnly = clip(layers.rulesOnly, from, to);
  const withExceptions =
    layers.withExceptions === layers.rulesOnly ? rulesOnly : clip(layers.withExceptions, from, to);
  return { rulesOnly, withExceptions };
}

/**
 * Glues the day slices back into one timeline per layer and clips to the window.
 *
 * The slices are disjoint half-open days, so `normalize` only ever fuses two touching
 * segments of equal capacity; it never sums two capacities into one. Reference identity
 * between the layers is preserved when every day agrees, which keeps the "no exceptions, no
 * blocks: one materialization, not three" shortcut of `computeAvailability` working on a
 * fully cached read.
 */
function assembleLayers(
  days: readonly DaySlot[],
  perDay: ReadonlyMap<LocalDate, ResourceOpenTimelines>,
  from: number,
  to: number,
): ResourceOpenTimelines {
  const rules: Segment[] = [];
  const exceptions: Segment[] = [];
  let exceptionsSame = true;
  for (const slot of days) {
    const layers = perDay.get(slot.day);
    if (layers === undefined) continue;
    rules.push(...layers.rulesOnly);
    exceptions.push(...layers.withExceptions);
    if (layers.withExceptions !== layers.rulesOnly) exceptionsSame = false;
  }
  const rulesOnly = clip(normalize(rules), from, to);
  const withExceptions = exceptionsSame ? rulesOnly : clip(normalize(exceptions), from, to);
  return { rulesOnly, withExceptions };
}

function encodeOpen(layers: ResourceOpenTimelines, resource: ResourceData): string {
  const wire: WireOpen = {
    v: FORMAT_VERSION,
    c: resource.capacity,
    z: resource.timezone,
    r: toWire(layers.rulesOnly),
    e: layers.withExceptions === layers.rulesOnly ? null : toWire(layers.withExceptions),
  };
  return JSON.stringify(wire);
}

/**
 * A value written for a different capacity or a different zone is treated as a miss rather
 * than as data: capacity is invalidated by `PATCH /v1/resources`, but a location that
 * changes zone is not on the invalidation list, and an entry that cannot be
 * trusted must never be believed.
 */
function decodeOpen(raw: string | null, resource: ResourceData): ResourceOpenTimelines | null {
  if (raw === null) return null;
  let wire: WireOpen;
  try {
    wire = JSON.parse(raw) as WireOpen;
  } catch {
    return null;
  }
  if (wire.v !== FORMAT_VERSION || wire.c !== resource.capacity || wire.z !== resource.timezone) {
    return null;
  }
  if (!Array.isArray(wire.r)) return null;
  const rulesOnly = fromWire(wire.r);
  const withExceptions = wire.e === null ? rulesOnly : fromWire(wire.e);
  return { rulesOnly, withExceptions };
}

// --- Occupancies --------------------------------------------------------------------------

export interface OccupancyCacheOptions {
  readonly cache: AvailabilityCache;
  readonly ttlSeconds?: number;
  readonly maxDays?: number;
  /** Instant hold expiry is evaluated at; the SQL path uses the database's `now()`. */
  readonly now?: number;
}

/**
 * Occupancies per resource over `[from, to)`, from the cache where possible.
 *
 * `fetch` is called **once**, with the resources that had at least one missing day, and must
 * return every occupancy of those resources overlapping `[from, to)`: the caller's window is
 * already whole local days, so what comes back can be sliced and stored day by day.
 *
 * Expired holds are dropped here as the SQL drops them, but against this process's clock
 * instead of the database's. The two can differ by the usual clock skew; a hold that expires
 * inside that gap is counted as occupied for a moment longer, which removes a slot from the
 * offer and never adds one.
 */
export async function loadCachedOccupancies(
  resources: readonly ResourceCoordinates[],
  from: number,
  to: number,
  options: OccupancyCacheOptions,
  fetch: (resourceIds: string[]) => Promise<Map<string, LoadedOccupancy[]>>,
): Promise<Map<string, OccupancyData[]>> {
  const ttl = options.ttlSeconds ?? DEFAULT_OCCUPANCY_TTL_SECONDS;
  const now = options.now ?? Date.now();
  const plan = resources.map((resource) => ({
    resource,
    days: daysOf(resource.timezone, from, to, options.maxDays),
  }));

  const keys: string[] = [];
  for (const entry of plan) {
    for (const slot of entry.days) keys.push(cacheKey('occ', entry.resource.id, slot.day));
  }
  const values = await options.cache.getMany(keys);

  const fromCache = new Map<string, LoadedOccupancy[]>();
  const stale: typeof plan = [];
  let cursor = 0;
  for (const entry of plan) {
    const collected = new Map<string, LoadedOccupancy>();
    let complete = true;
    for (let day = 0; day < entry.days.length; day += 1) {
      const decoded = decodeOccupancies(values[cursor] ?? null, entry.resource.id);
      cursor += 1;
      if (decoded === null) {
        complete = false;
        continue;
      }
      for (const occupancy of decoded) collected.set(occupancy.id, occupancy);
    }
    if (complete) fromCache.set(entry.resource.id, [...collected.values()]);
    else stale.push(entry);
  }

  const fetched =
    stale.length === 0
      ? new Map<string, LoadedOccupancy[]>()
      : await fetch(stale.map((e) => e.resource.id));

  const writes: CacheWrite[] = [];
  for (const entry of stale) {
    const rows = fetched.get(entry.resource.id) ?? [];
    for (const slot of entry.days) {
      const inDay = rows.filter((row) => row.start < slot.end && row.end > slot.start);
      writes.push({
        family: 'occ',
        resourceId: entry.resource.id,
        day: slot.day,
        value: encodeOccupancies(inDay),
        ttlSeconds: ttl,
      });
    }
    fromCache.set(entry.resource.id, rows);
  }
  await options.cache.put(writes);

  const out = new Map<string, OccupancyData[]>();
  for (const [resourceId, rows] of fromCache) {
    const live = rows
      .filter((row) => row.expiresAt === null || row.expiresAt > now)
      .map(
        ({
          id,
          resourceId: owner,
          start,
          end,
          capacityUsed,
          kind,
          refId,
          bufferBeforeMs,
          bufferAfterMs,
        }): OccupancyData => ({
          id,
          resourceId: owner,
          start,
          end,
          capacityUsed,
          kind,
          refId,
          bufferBeforeMs,
          bufferAfterMs,
        }),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.set(resourceId, live);
  }
  return out;
}

/** Just enough of a resource to know which local days its cache entries live on. */
export interface ResourceCoordinates {
  readonly id: string;
  readonly timezone: string;
}

function encodeOccupancies(rows: readonly LoadedOccupancy[]): string {
  const wire: WireOccupancies = {
    v: FORMAT_VERSION,
    o: rows.map((row) => [
      row.id,
      row.start,
      row.end,
      row.capacityUsed,
      row.kind,
      row.refId,
      row.expiresAt,
      row.bufferBeforeMs,
      row.bufferAfterMs,
    ]),
  };
  return JSON.stringify(wire);
}

function decodeOccupancies(raw: string | null, resourceId: string): LoadedOccupancy[] | null {
  if (raw === null) return null;
  let wire: WireOccupancies;
  try {
    wire = JSON.parse(raw) as WireOccupancies;
  } catch {
    return null;
  }
  if (wire.v !== FORMAT_VERSION || !Array.isArray(wire.o)) return null;
  return wire.o.map(
    ([id, start, end, capacityUsed, kind, refId, expiresAt, bufferBeforeMs, bufferAfterMs]) => ({
      id,
      resourceId,
      start,
      end,
      capacityUsed,
      kind,
      refId,
      expiresAt,
      bufferBeforeMs,
      bufferAfterMs,
    }),
  );
}
