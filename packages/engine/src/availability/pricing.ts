/**
 * Step 8 of the availability pipeline: what one slot costs.
 *
 * `services.pricing_rules` is an ordered list in which **the first rule that matches wins**,
 * applied to the flat price of the service; the rules never compose. This module is what makes
 * that true: the column used to be stored and never read, and every slot and every booking
 * carried `services.price_amount` whatever the rules said.
 *
 * The function is pure and takes the zone explicitly, like everything else in this package: a
 * rule is about the local calendar of the offer (a Saturday surcharge is the club's Saturday),
 * and the same instant is Saturday in Auckland and Friday in Rome. The zone is the offer's,
 * never the customer's, exactly as it is for the slot grid.
 *
 * ## Local time, and the two nights a year it is not a function
 *
 * The local wall clock of an **instant** is total: every instant has exactly one local reading
 * in a zone, clock change or not. So `Temporal.Instant.toZonedDateTimeISO` is all this file
 * needs, and there is no disambiguation to make: the ambiguity of `schedule/` runs the other
 * way, from a wall time to an instant, which is the direction that can have zero or two
 * answers. What follows from that, rather than being decided here:
 *
 *  - on the **spring forward** night no instant reads 02:30 local, so a band `[02:00, 03:00)`
 *    matches nothing that night. The hour does not exist; a rule about it cannot fire.
 *  - on the **fall back** night two instants read 02:30 local, and the band matches **both**.
 *    The hour happens twice; a rule about it fires twice.
 *
 * Both are the behaviour a person reading the rule would predict from the wall clock, which is
 * the only defensible answer, and both are tested (`packages/engine/test/pricing.test.ts`).
 *
 * ## Rounding
 *
 * `price_multiplier` is the only effect that can leave the integers. The multiplier carries at most
 * four decimals (the schema enforces it), so the product is computed in integer arithmetic
 * (`amount x round(multiplier x 10 000) / 10 000`) and only then rounded to the minor unit with
 * `Math.round`, which rounds a half towards positive infinity. Doing the multiplication in floating
 * point first would make `2500 x 1.15` land on 2874.9999999999995, and while `Math.round` recovers
 * 2875 there, the drift is not something to rely on.
 *
 * The result is clamped into `[0, MAX_PRICE_AMOUNT]`: a `price_add` of -5000 on a price of 3000
 * is a free slot, not a debt, and `bookings.price_amount` is a Postgres `integer`, so a
 * computed amount past its ceiling is not a price this system can freeze.
 */
import { Temporal } from '@js-temporal/polyfill';
import {
  MAX_PRICE_AMOUNT,
  decodeId,
  type PriceRuleRef,
  type PricingRule,
  type PricingRuleWhen,
  type PricingWeekday,
} from '@bookrail/shared';

import type { Price, ServiceData } from './compute.js';

/** The part of a slot a price can depend on. */
export interface PricedSlot {
  /** Start of the slot, epoch milliseconds. Rules are evaluated on the **start**. */
  readonly startUtc: number;
  readonly durationMinutes: number;
  /** Bare uuids of the resources the slot would use. */
  readonly resourceIds: readonly string[];
}

export interface SlotPrice {
  readonly price: Price;
  /** Index of the rule that priced it, or `null` when the flat price applied. */
  readonly ruleIndex: number | null;
  readonly label: string | null;
}

/** `Temporal` counts 1 = Monday .. 7 = Sunday; `07` names them. */
const WEEKDAY_BY_ISO: readonly PricingWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Minutes since local midnight of an `HH:MM` string the schema has already validated. */
function minutesOfDay(time: string): number {
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  return hour * 60 + minute;
}

/**
 * `[from, to)` on the local clock, wrapping when `to` is before `from`.
 *
 * A band that wraps is the union of `[from, 24:00)` and `[00:00, to)`, which is how a person
 * writes "the night rate, 22:00 to 02:00" and expects it to be read. `from === to` is refused
 * by the schema, so the empty band never gets here.
 */
function withinBand(minutes: number, from: number, to: number): boolean {
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

interface LocalStart {
  readonly weekday: PricingWeekday;
  readonly minutes: number;
  /** `YYYY-MM-DD` of the local calendar day the slot starts on. */
  readonly date: string;
}

function localStartOf(startUtc: number, timezone: string): LocalStart {
  const zoned = Temporal.Instant.fromEpochMilliseconds(startUtc).toZonedDateTimeISO(timezone);
  return {
    weekday: WEEKDAY_BY_ISO[zoned.dayOfWeek - 1]!,
    minutes: zoned.hour * 60 + zoned.minute,
    date: zoned.toPlainDate().toString(),
  };
}

/**
 * Every condition present has to hold: a `when` is a conjunction. The schema refuses an empty
 * one, so a rule always carries at least one condition.
 *
 * `resource_id` is the prefixed form the API speaks; the engine works in bare uuids, so it is
 * decoded here rather than encoding every resource of the slot. A malformed one decodes to
 * `null` and matches nothing, which cannot happen through the API (the schema refuses it)
 * and is the safe reading of a row written before the schema existed.
 */
function matches(
  when: PricingRuleWhen,
  slot: PricedSlot,
  local: LocalStart,
  resources: ReadonlySet<string>,
): boolean {
  if (when.days !== undefined && !when.days.includes(local.weekday)) return false;
  if (when.time_from !== undefined && when.time_to !== undefined) {
    if (!withinBand(local.minutes, minutesOfDay(when.time_from), minutesOfDay(when.time_to))) {
      return false;
    }
  }
  if (when.date_from !== undefined && local.date < when.date_from) return false;
  if (when.date_to !== undefined && local.date > when.date_to) return false;
  if (when.resource_id !== undefined) {
    const uuid = decodeId('resource', when.resource_id);
    if (uuid === null || !resources.has(uuid)) return false;
  }
  if (when.duration_min !== undefined && when.duration_min !== slot.durationMinutes) return false;
  return true;
}

function clamp(amount: number): number {
  return Math.min(MAX_PRICE_AMOUNT, Math.max(0, amount));
}

/** The amount a rule makes of a base amount: a flat price, an addition, or a multiplier. */
export function applyPricingRule(rule: PricingRule, base: number): number {
  if (rule.price !== undefined) return clamp(rule.price);
  if (rule.price_add !== undefined) return clamp(base + rule.price_add);
  if (rule.price_multiplier !== undefined) {
    const scaled = Math.round(rule.price_multiplier * 10_000);
    return clamp(Math.round((base * scaled) / 10_000));
  }
  // Unreachable through the schema, which requires exactly one effect. A row that predates it
  // keeps the base price rather than pricing at zero.
  return clamp(base);
}

/**
 * The price of one slot: the first matching rule applied to the flat price, or the flat price.
 *
 * `null` when the service has no price at all. A service without a price has nothing for a rule
 * to modify, which is why `POST`/`PATCH /v1/services` refuses the combination outright rather
 * than letting it sit there doing nothing.
 */
export function priceForSlot(
  service: ServiceData,
  slot: PricedSlot,
  timezone: string,
): SlotPrice | null {
  if (service.priceAmount === null || service.priceCurrency === null) return null;
  const base: Price = { amount: service.priceAmount, currency: service.priceCurrency };
  const rules = service.pricingRules;
  if (rules.length === 0) return { price: base, ruleIndex: null, label: null };

  const local = localStartOf(slot.startUtc, timezone);
  const resources = new Set(slot.resourceIds);
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    // A `null` is a stored rule the schema refuses (`load.ts`). It is skipped and keeps its
    // position, so the index reported for the rules after it is still the index of the column.
    if (rule === undefined || rule === null) continue;
    if (!matches(rule.when, slot, local, resources)) continue;
    return {
      price: { amount: applyPricingRule(rule, base.amount), currency: base.currency },
      ruleIndex: index,
      label: rule.label ?? null,
    };
  }
  return { price: base, ruleIndex: null, label: null };
}

/** The `{ index, label }` an API response carries, or `null` when no rule applied. */
export function priceRuleOf(priced: SlotPrice | null): PriceRuleRef | null {
  if (priced === null || priced.ruleIndex === null) return null;
  return { index: priced.ruleIndex, label: priced.label };
}
