/**
 * `services.pricing_rules`: the one definition of what a pricing rule is.
 *
 * Until the rules were evaluated, the column existed, the API accepted anything shaped like an
 * array of objects, and the engine never read it: every slot and every booking carried the flat
 * price of the service. This module is the schema the API validates against, the type the engine
 * evaluates, and the shape `openapi.json` publishes, so there is exactly one answer to "what is
 * a pricing rule" in the repository.
 *
 * The semantics of a rule:
 *
 *  - the rules are evaluated **in order** and the **first one that matches wins**. There is no
 *    chaining: a slot is priced by one rule or by the flat price, never by two rules in a row.
 *  - a rule's `when` is a conjunction: every condition present has to hold. A `when` with no
 *    condition at all is refused, because a rule that always matches is a price, not a rule,
 *    and writing it as a rule hides the fact that everything after it is dead.
 *  - the effect is exactly one of `price` (replace), `price_add` (add, possibly negative) or
 *    `price_multiplier` (scale). The result never goes below zero.
 *
 * Everything time-shaped in a rule is **local to the offer's zone**, never UTC: a Saturday
 * surcharge is about the Saturday of the club, and the same instant is Saturday in Auckland and
 * Friday in Rome. The evaluation lives in `@bookrail/engine`
 * (`packages/engine/src/availability/pricing.ts`), which is where `Temporal` already is; this
 * module carries the schema, the types and the conformance corpus and stays free of any clock.
 */
import { z } from 'zod';

/** Local weekday names, as a rule's `days` condition writes them. */
export const PRICING_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export type PricingWeekday = (typeof PRICING_WEEKDAYS)[number];

/**
 * Bounds of a price in the minor unit.
 *
 * `services.price_amount` and `bookings.price_amount` are Postgres `integer` columns, so a
 * computed price that does not fit in one is not a price the system can freeze. The bound is
 * enforced twice: here, on what a rule may state, and in the engine, which clamps the computed
 * amount into `[0, MAX_PRICE_AMOUNT]` rather than handing the database a number it will refuse.
 */
export const MAX_PRICE_AMOUNT = 2_147_483_647;

/**
 * Ceiling on `price_multiplier`.
 *
 * There is no business reason for a rule that multiplies a price by more than a thousand, and
 * an unbounded multiplier is the shortest path from a typo to an overflow.
 */
export const MAX_PRICE_MULTIPLIER = 1000;

/** `HH:MM`, local wall clock, minute resolution. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `YYYY-MM-DD`, a local calendar date. */
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `res_` plus 32 hex characters: the prefixed form of a resource id, as the API speaks it. */
const RESOURCE_ID = /^res_[0-9a-f]{32}$/;

function isRealDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const localDate = (what: string) =>
  z
    .string()
    .regex(LOCAL_DATE, `${what} must be a local calendar date such as 2026-09-08.`)
    .refine(isRealDate, `${what} is not a real calendar date.`);

const timeOfDay = (what: string) =>
  z.string().regex(TIME_OF_DAY, `${what} must be a local time of day such as 18:00.`);

/**
 * At most four decimals, checked on the decimal text rather than on the float.
 *
 * `1.15` is not representable in binary floating point, so any test that multiplies and looks
 * at the remainder answers "more than four decimals" for numbers that plainly have two. The
 * string the number prints as is the number the caller wrote, which is what the rule is about.
 */
function hasAtMostFourDecimals(value: number): boolean {
  const text = String(value);
  if (text.includes('e') || text.includes('E')) return false;
  const dot = text.indexOf('.');
  return dot < 0 || text.length - dot - 1 <= 4;
}

export const pricingRuleWhenSchema = z
  .object({
    days: z
      .array(z.enum(PRICING_WEEKDAYS))
      .min(1)
      .max(PRICING_WEEKDAYS.length)
      .refine((days) => new Set(days).size === days.length, 'days must not repeat a weekday.')
      .optional(),
    time_from: timeOfDay('time_from').optional(),
    time_to: timeOfDay('time_to').optional(),
    date_from: localDate('date_from').optional(),
    date_to: localDate('date_to').optional(),
    resource_id: z
      .string()
      .regex(RESOURCE_ID, 'resource_id must be a resource identifier such as res_0193f0c2...')
      .optional(),
    duration_min: z.number().int().positive().max(525600).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'when must carry at least one condition; a rule that always matches is a price, not a rule.',
      });
    }
    // The two halves of a time band are meaningless apart: `time_from` alone would have to mean
    // "until midnight", which is a guess the caller should be making, not this schema.
    if ((value.time_from === undefined) !== (value.time_to === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.time_from === undefined ? 'time_from' : 'time_to'],
        message: 'time_from and time_to go together: give both or neither.',
      });
    }
    // `[from, to)` with `from === to` is the empty band, which can never match. A band that
    // covers the whole day is written by leaving both out.
    if (value.time_from !== undefined && value.time_from === value.time_to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['time_to'],
        message:
          'time_to must differ from time_from: [from, from) is empty and would never match. Omit both for the whole day.',
      });
    }
    if (
      value.date_from !== undefined &&
      value.date_to !== undefined &&
      value.date_from > value.date_to
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['date_to'],
        message: 'date_to must not be before date_from.',
      });
    }
  });

export const pricingRuleSchema = z
  .object({
    when: pricingRuleWhenSchema,
    price: z.number().int().min(0).max(MAX_PRICE_AMOUNT).optional(),
    price_add: z.number().int().min(-MAX_PRICE_AMOUNT).max(MAX_PRICE_AMOUNT).optional(),
    price_multiplier: z
      .number()
      .positive()
      .max(MAX_PRICE_MULTIPLIER)
      .refine(hasAtMostFourDecimals, 'price_multiplier takes at most four decimals.')
      .optional(),
    label: z.string().min(1).max(60).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const effects = (['price', 'price_add', 'price_multiplier'] as const).filter(
      (key) => value[key] !== undefined,
    );
    if (effects.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A rule states exactly one of price, price_add or price_multiplier; this one states ' +
          (effects.length === 0 ? 'none' : effects.join(' and ')) +
          '.',
      });
    }
  });

/** `services.pricing_rules`: an ordered list, at most a hundred long. */
export const pricingRulesSchema = z.array(pricingRuleSchema).max(100);

export type PricingRuleWhen = z.infer<typeof pricingRuleWhenSchema>;
export type PricingRule = z.infer<typeof pricingRuleSchema>;

/** Which rule priced a slot or a booking, and what it is called. */
export interface PriceRuleRef {
  readonly index: number;
  readonly label: string | null;
}

/**
 * `bookings.price_rule` as it comes back from Postgres: the one reader of that column.
 *
 * The column is `jsonb` with a `CHECK` that it is an object, and nothing writes it but the
 * booking transaction, so the shape is ours. It is still read defensively rather than cast: a
 * booking that cannot be cancelled because a jsonb column has an unexpected shape would be the
 * wrong failure at the worst moment, and `null` (priced flat) is the reading every booking
 * written before migration 0020 deserves anyway.
 *
 * It lives here, next to the type it returns, because two readers of the same column with two
 * sets of criteria are two answers to the same question: the engine puts `price_rule` on an
 * event and the API puts it on a response, and a row that one of them refuses and the other
 * publishes would let a consumer that mirrors bookings from events and then reads them back
 * see two truths. `index` is a non-negative integer or the value is not a reference at all,
 * and a `label` that is not a string reads as no label.
 */
export function priceRuleOfRow(value: unknown): PriceRuleRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 0) return null;
  return { index: raw.index, label: typeof raw.label === 'string' ? raw.label : null };
}

/**
 * A corpus every re-declaration of the schema has to agree with, verdict by verdict.
 *
 * The CLI cannot import this package at run time: `bookrail` ships with three dependencies and
 * none of them is a workspace package with dependencies of its own, which is a budget that
 * `packages/cli/test/binary.test.ts` enforces. So `packages/cli/src/config/schema.ts` declares
 * the same rule a second time, and a second declaration is a second source of truth unless
 * something compares them. This is that something: `packages/cli/test/config.test.ts` runs every
 * case below through the CLI's schema and requires the same verdict, and
 * `packages/shared/test/pricing.test.ts` runs them through this one.
 *
 * Add a case here when the schema gains a rule; both suites pick it up.
 */
export interface PricingRuleCase {
  readonly title: string;
  readonly valid: boolean;
  readonly rule: unknown;
}

export const PRICING_RULE_CONFORMANCE_CASES: readonly PricingRuleCase[] = [
  { title: 'a weekend price', valid: true, rule: { when: { days: ['sat', 'sun'] }, price: 3500 } },
  {
    title: 'an evening band',
    valid: true,
    rule: { when: { time_from: '18:00', time_to: '22:00' }, price: 3000 },
  },
  {
    title: 'a band that crosses midnight',
    valid: true,
    rule: { when: { time_from: '22:00', time_to: '02:00' }, price_add: 500 },
  },
  {
    title: 'a surcharge on one resource',
    valid: true,
    rule: {
      when: { resource_id: 'res_0193f0c2a1b47e2e9a1c0f4d5e6a7b8c' },
      price_add: 500,
      label: 'Centre court',
    },
  },
  {
    title: 'a multiplier on one duration',
    valid: true,
    rule: { when: { duration_min: 90 }, price_multiplier: 1.4 },
  },
  {
    title: 'a season',
    valid: true,
    rule: { when: { date_from: '2026-07-01', date_to: '2026-08-31' }, price_multiplier: 1.2 },
  },
  {
    title: 'every condition at once',
    valid: true,
    rule: {
      when: {
        days: ['fri', 'sat'],
        time_from: '20:00',
        time_to: '23:30',
        date_from: '2026-01-01',
        date_to: '2026-12-31',
        resource_id: 'res_0193f0c2a1b47e2e9a1c0f4d5e6a7b8c',
        duration_min: 60,
      },
      price: 9900,
    },
  },
  { title: 'a negative addition', valid: true, rule: { when: { days: ['mon'] }, price_add: -500 } },
  {
    title: 'a multiplier with four decimals',
    valid: true,
    rule: { when: { days: ['mon'] }, price_multiplier: 1.2345 },
  },
  { title: 'a free slot', valid: true, rule: { when: { days: ['mon'] }, price: 0 } },
  { title: 'an empty when', valid: false, rule: { when: {}, price: 100 } },
  { title: 'no when at all', valid: false, rule: { price: 100 } },
  { title: 'no effect', valid: false, rule: { when: { days: ['sat'] } } },
  {
    title: 'two effects',
    valid: false,
    rule: { when: { days: ['sat'] }, price: 100, price_add: 100 },
  },
  {
    title: 'an unknown condition',
    valid: false,
    rule: { when: { customer_tag: 'member' }, price: 100 },
  },
  {
    title: 'an unknown field',
    valid: false,
    rule: { when: { days: ['sat'] }, price: 100, note: 'x' },
  },
  { title: 'an unknown weekday', valid: false, rule: { when: { days: ['saturday'] }, price: 100 } },
  {
    title: 'a repeated weekday',
    valid: false,
    rule: { when: { days: ['sat', 'sat'] }, price: 100 },
  },
  { title: 'an empty days list', valid: false, rule: { when: { days: [] }, price: 100 } },
  {
    title: 'a 24 hour clock past 23',
    valid: false,
    rule: { when: { time_from: '24:00', time_to: '01:00' }, price: 100 },
  },
  {
    title: 'a time with seconds',
    valid: false,
    rule: { when: { time_from: '18:00:00', time_to: '22:00' }, price: 100 },
  },
  {
    title: 'time_from without time_to',
    valid: false,
    rule: { when: { time_from: '18:00' }, price: 100 },
  },
  {
    title: 'an empty time band',
    valid: false,
    rule: { when: { time_from: '18:00', time_to: '18:00' }, price: 100 },
  },
  {
    title: 'a date that does not exist',
    valid: false,
    rule: { when: { date_from: '2026-02-30' }, price: 100 },
  },
  {
    title: 'a reversed date range',
    valid: false,
    rule: { when: { date_from: '2026-08-31', date_to: '2026-07-01' }, price: 100 },
  },
  {
    title: 'a bare uuid as resource_id',
    valid: false,
    rule: { when: { resource_id: '0193f0c2-a1b4-7e2e-9a1c-0f4d5e6a7b8c' }, price: 100 },
  },
  {
    title: 'a resource id of the wrong kind',
    valid: false,
    rule: { when: { resource_id: 'svc_0193f0c2a1b47e2e9a1c0f4d5e6a7b8c' }, price: 100 },
  },
  {
    title: 'a fractional duration',
    valid: false,
    rule: { when: { duration_min: 90.5 }, price: 100 },
  },
  { title: 'a zero duration', valid: false, rule: { when: { duration_min: 0 }, price: 100 } },
  { title: 'a fractional price', valid: false, rule: { when: { days: ['sat'] }, price: 35.5 } },
  { title: 'a negative price', valid: false, rule: { when: { days: ['sat'] }, price: -1 } },
  {
    title: 'a zero multiplier',
    valid: false,
    rule: { when: { days: ['sat'] }, price_multiplier: 0 },
  },
  {
    title: 'a negative multiplier',
    valid: false,
    rule: { when: { days: ['sat'] }, price_multiplier: -1 },
  },
  {
    title: 'a multiplier with five decimals',
    valid: false,
    rule: { when: { days: ['sat'] }, price_multiplier: 1.23456 },
  },
  {
    title: 'a multiplier past the ceiling',
    valid: false,
    rule: { when: { days: ['sat'] }, price_multiplier: 1001 },
  },
  {
    title: 'a price past the integer column',
    valid: false,
    rule: { when: { days: ['sat'] }, price: MAX_PRICE_AMOUNT + 1 },
  },
  {
    title: 'an empty label',
    valid: false,
    rule: { when: { days: ['sat'] }, price: 100, label: '' },
  },
  {
    title: 'a label past sixty characters',
    valid: false,
    rule: { when: { days: ['sat'] }, price: 100, label: 'x'.repeat(61) },
  },
  { title: 'a rule that is not an object', valid: false, rule: 'weekend' },
];
