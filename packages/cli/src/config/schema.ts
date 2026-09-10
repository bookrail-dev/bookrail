import { z } from 'zod';

/**
 * The schema of `bookrail.config.ts`.
 *
 * Two rules govern every field here.
 *
 * 1. **It describes the objects the API really has today**, not the earlier sketch of the file
 *    format. Every field maps onto a column or a request field of `packages/api/src/schemas`,
 *    including the ones added after that sketch was written: `consumes` on a requirement,
 *    `bufferSharing` and `allowSplit` on a service, `bookingWindow` as minutes and days rather
 *    than as a duration string, and `autoStart` / `autoComplete` / `maxReschedules` / `noShow`
 *    on a policy.
 * 2. **Identifiers are logical.** `id` is the customer's own name for the object; the push
 *    stores it in `metadata.config_id` on the remote object and that is the whole mapping.
 *    A `res_...` identifier never appears in a config file.
 *
 * Every collection accepts two spellings, an array of objects carrying `id` or a record keyed
 * by that id, because the documented examples show `resources` as an array and `schedules`,
 * `resourceGroups` and `policies` as records, and an agent that guesses the wrong one should
 * get a config that works rather than a validation error.
 */

const idSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'A logical id starts with a letter or a digit and contains only letters, digits, ".", "_" and "-".',
  );

const timezoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid IANA time zone, for example Europe/Rome.' },
);

const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Must be a time of day such as 09:00.');

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a calendar date such as 2026-09-08.');

/** `dateSchema` plus "and it is a day that exists": 2026-02-30 matches the pattern. */
function localDateSchema(what: string) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${what} must be a calendar date such as 2026-09-08.`)
    .refine((value) => {
      const [year, month, day] = value.split('-').map(Number) as [number, number, number];
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    }, `${what} is not a real calendar date.`);
}

/** The duration grammar the engine parses, shared by hold TTLs and policy windows. */
const durationSchema = z
  .string()
  .regex(/^\d+(\.\d+)?[smhdw]$/, 'Use a duration such as 48h, 30m, 90s, 7d.');

const metadataSchema = z.record(z.unknown());
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Three letter ISO 4217 code, e.g. EUR.');

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayName = (typeof DAY_NAMES)[number];

/**
 * `days: ["mon", "tue"]`, the spelling a configuration file uses, or the numeric form the API
 * takes (`0` = Sunday). Names are what a human writes and what an agent reads back correctly.
 */
const daysSchema = z
  .array(z.union([z.enum(DAY_NAMES), z.number().int().min(0).max(6)]))
  .min(1)
  .max(7);

export function dayToNumber(day: DayName | number): number {
  return typeof day === 'number' ? day : DAY_NAMES.indexOf(day);
}

export function numberToDay(day: number): DayName {
  return DAY_NAMES[day] ?? 'sun';
}

// --- Location ---------------------------------------------------------------------------

const locationBody = {
  name: z.string().min(1).max(200).optional(),
  timezone: timezoneSchema,
  address: z.record(z.unknown()).nullish(),
  tenantId: z.string().min(1).max(200).nullish(),
  metadata: metadataSchema.optional(),
};

// --- Schedule ---------------------------------------------------------------------------

const scheduleRuleSchema = z
  .object({
    days: daysSchema,
    /** Inclusive start of the opening band, on the local clock of the schedule. */
    from: timeOfDaySchema,
    /**
     * End of the band. `to` less than or equal to `from` crosses midnight, and `00:00`-`00:00`
     * is therefore the whole local day.
     */
    to: timeOfDaySchema,
    validFrom: dateSchema.nullish(),
    validUntil: dateSchema.nullish(),
  })
  .strict();

const scheduleExceptionSchema = z
  .object({
    date: dateSchema,
    type: z.enum(['closed', 'open']),
    from: timeOfDaySchema.nullish(),
    to: timeOfDaySchema.nullish(),
    reason: z.string().max(500).nullish(),
  })
  .strict()
  .refine((value) => Boolean(value.from) === Boolean(value.to), {
    message: 'An exception gives both `from` and `to`, or neither (which means the whole day).',
    path: ['from'],
  })
  .refine((value) => value.type !== 'open' || (value.from && value.to), {
    message: 'An "open" exception must give `from` and `to`.',
    path: ['from'],
  });

const scheduleBody = {
  name: z.string().min(1).max(200).optional(),
  timezone: timezoneSchema.nullish(),
  rules: z.array(scheduleRuleSchema).max(100).optional(),
  exceptions: z.array(scheduleExceptionSchema).max(500).optional(),
  metadata: metadataSchema.optional(),
};

// --- Resource ---------------------------------------------------------------------------

const resourceBody = {
  name: z.string().min(1).max(200).optional(),
  type: z.string().min(1).max(50).optional(),
  /** Logical id of a location declared in this config. */
  location: idSchema.nullish(),
  /** Logical id of a schedule declared in this config. */
  schedule: idSchema.nullish(),
  capacity: z.number().int().positive().max(100000).optional(),
  attributes: z.record(z.unknown()).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  tenantId: z.string().min(1).max(200).nullish(),
  metadata: metadataSchema.optional(),
};

// --- Resource group ---------------------------------------------------------------------

const resourceGroupBody = {
  name: z.string().min(1).max(200).optional(),
  /** Logical ids, in the order the allocation strategy should consider them. */
  resources: z.array(idSchema).max(500).optional(),
  selector: z.record(z.unknown()).nullish(),
  allocationStrategy: z
    .enum(['least_busy', 'round_robin', 'first_available', 'priority'])
    .optional(),
  metadata: metadataSchema.optional(),
};

// --- Policy -----------------------------------------------------------------------------

const refundTierSchema = z
  .object({
    before: durationSchema,
    refundPercent: z.number().min(0).max(100).optional(),
    /** Retained fee, in the minor unit of the currency (cents for EUR). */
    fee: z.number().int().min(0).optional(),
  })
  .strict();

const policyBody = {
  name: z.string().min(1).max(200).optional(),
  cancellation: z.array(refundTierSchema).max(20).optional(),
  reschedule: z.array(refundTierSchema).max(20).optional(),
  deposit: z
    .object({
      type: z.enum(['percent', 'fixed']),
      value: z.number().min(0),
      due: z.enum(['at_booking']).optional(),
    })
    .strict()
    .nullish(),
  paymentTiming: z.enum(['at_booking', 'before_start', 'after_service', 'none']).optional(),
  paymentDeadline: z.string().max(50).nullish(),
  noShow: z
    .object({
      chargePercent: z.number().min(0).max(100).optional(),
      graceMinutes: z.number().int().min(0).max(1440).optional(),
      /** Lets the scheduler apply the no-show by itself. */
      autoMark: z.boolean().optional(),
      markAfter: z.string().max(50).optional(),
    })
    .strict()
    .nullish(),
  /** `"10m"` or a number of seconds. Between 30 s and 24 h. */
  holdDuration: z.union([durationSchema, z.number().int().min(30).max(86400)]).optional(),
  maxActiveBookingsPerCustomer: z.number().int().positive().nullish(),
  requireCustomerConfirmation: z.boolean().optional(),
  requireProviderConfirmation: z.boolean().optional(),
  /** Moves a confirmed booking to `in_progress` at its start, with no check-in. */
  autoStart: z.boolean().optional(),
  autoComplete: z.boolean().optional(),
  maxReschedules: z.number().int().min(0).max(100).nullish(),
  metadata: metadataSchema.optional(),
};

// --- Service ----------------------------------------------------------------------------

const requirementSchema = z
  .object({
    /** Logical id of a resource; mutually exclusive with `group`. */
    resource: idSchema.optional(),
    /** Logical id of a resource group; mutually exclusive with `resource`. */
    group: idSchema.optional(),
    quantity: z.number().int().positive().max(1000).optional(),
    /**
     * `per_unit` takes `quantity` units of the resource, `whole` takes it entirely: the
     * instructor of a yoga class is one person whatever the class size (migration 0009).
     */
    consumes: z.enum(['per_unit', 'whole']).optional(),
    role: z.string().min(1).max(50).nullish(),
  })
  .strict()
  .refine((value) => Boolean(value.resource) !== Boolean(value.group), {
    message: 'A requirement names exactly one of `resource` or `group`.',
  });

/**
 * `pricingRules`, mirroring `@bookrail/shared`'s `pricingRuleSchema` field for field.
 *
 * It is a **second declaration on purpose**, and the only one in this package. `bookrail` ships
 * with three runtime dependencies and none of them is a workspace package carrying dependencies
 * of its own, which `packages/cli/test/binary.test.ts` asserts, so it cannot import
 * `@bookrail/shared`, which needs Zod and `@bookrail/webhook-signature`. `API_VERSION` in
 * `src/version.ts` is duplicated for the same reason and with the same discipline: a duplicate
 * is acceptable only when something compares the two. Here that something is
 * `packages/cli/test/config.test.ts`, which runs the conformance corpus exported by
 * `@bookrail/shared` (a development dependency, so a test may import it) through this schema
 * and requires the same verdict on every case.
 *
 * The one thing to know when writing a rule in a config file: `when.resourceId` is a **real**
 * `res_...` identifier, not a logical id of this file. `push` does not resolve references
 * inside pricing rules, so a rule about a resource the config declares has to name the id the
 * resource already has remotely (`bookrail pull` shows it).
 */
const pricingRuleSchema = z
  .object({
    when: z
      .object({
        days: z
          .array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
          .min(1)
          .max(7)
          .refine((days) => new Set(days).size === days.length, 'days must not repeat a weekday.')
          .optional(),
        timeFrom: z
          .string()
          .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'timeFrom must be a local time such as 18:00.')
          .optional(),
        timeTo: z
          .string()
          .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'timeTo must be a local time such as 22:00.')
          .optional(),
        dateFrom: localDateSchema('dateFrom').optional(),
        dateTo: localDateSchema('dateTo').optional(),
        resourceId: z
          .string()
          .regex(/^res_[0-9a-f]{32}$/, 'resourceId must be a resource identifier such as res_...')
          .optional(),
        durationMin: z.number().int().positive().max(525600).optional(),
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
        if ((value.timeFrom === undefined) !== (value.timeTo === undefined)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [value.timeFrom === undefined ? 'timeFrom' : 'timeTo'],
            message: 'timeFrom and timeTo go together: give both or neither.',
          });
        }
        if (value.timeFrom !== undefined && value.timeFrom === value.timeTo) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['timeTo'],
            message:
              'timeTo must differ from timeFrom: [from, from) is empty and would never match. Omit both for the whole day.',
          });
        }
        if (
          value.dateFrom !== undefined &&
          value.dateTo !== undefined &&
          value.dateFrom > value.dateTo
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['dateTo'],
            message: 'dateTo must not be before dateFrom.',
          });
        }
      }),
    price: z.number().int().min(0).max(2147483647).optional(),
    priceAdd: z.number().int().min(-2147483647).max(2147483647).optional(),
    priceMultiplier: z
      .number()
      .positive()
      .max(1000)
      .refine((value) => {
        const text = String(value);
        if (text.includes('e') || text.includes('E')) return false;
        const dot = text.indexOf('.');
        return dot < 0 || text.length - dot - 1 <= 4;
      }, 'priceMultiplier takes at most four decimals.')
      .optional(),
    label: z.string().min(1).max(60).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const effects = (['price', 'priceAdd', 'priceMultiplier'] as const).filter(
      (key) => value[key] !== undefined,
    );
    if (effects.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A rule states exactly one of price, priceAdd or priceMultiplier; this one states ' +
          (effects.length === 0 ? 'none' : effects.join(' and ')) +
          '.',
      });
    }
  });

const serviceBody = {
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullish(),
  /** Exactly one of `duration`, `durationOptions`, `durationRange`, in minutes. */
  duration: z.number().int().positive().max(525600).optional(),
  durationOptions: z.array(z.number().int().positive().max(525600)).min(1).max(20).optional(),
  durationRange: z
    .object({ min: z.number().int().positive(), max: z.number().int().positive() })
    .strict()
    .optional(),
  capacityPerBooking: z.number().int().positive().max(100000).optional(),
  bufferBefore: z.number().int().min(0).max(1440).optional(),
  bufferAfter: z.number().int().min(0).max(1440).optional(),
  slotInterval: z.number().int().positive().max(1440).optional(),
  alignTo: z.enum(['hour', 'half_hour', 'schedule_start']).optional(),
  price: z
    .object({ amount: z.number().int().min(0), currency: currencySchema })
    .strict()
    .nullish(),
  /** Evaluated in order for every slot; the first match wins and replaces `price`. */
  pricingRules: z.array(pricingRuleSchema).max(100).optional(),
  /** Logical id of a policy declared in this config. */
  policy: idSchema.nullish(),
  /**
   * Minutes and days, not duration strings: the availability engine reads the columns
   * `min_notice_minutes` and `max_advance_days` directly.
   */
  bookingWindow: z
    .object({
      minNoticeMinutes: z.number().int().min(0).max(525600).optional(),
      maxAdvanceDays: z.number().int().min(0).max(3650).optional(),
    })
    .strict()
    .nullish(),
  allowRecurring: z.boolean().optional(),
  allowMultiDay: z.boolean().optional(),
  /** Buffers of two bookings on the same resource may overlap each other. */
  bufferSharing: z.boolean().optional(),
  /** One booking may take capacity from several resources of the same group. */
  allowSplit: z.boolean().optional(),
  requirements: z.array(requirementSchema).max(20).optional(),
  tenantId: z.string().min(1).max(200).nullish(),
  metadata: metadataSchema.optional(),
};

// --- Collections --------------------------------------------------------------------------

function collection<T extends z.ZodRawShape>(body: T) {
  const withId = z.object({ id: idSchema, ...body }).strict();
  const withoutId = z.object(body).strict();
  return z.union([z.array(withId), z.record(idSchema, withoutId)]).optional();
}

export const configSchema = z
  .object({
    /** Free-form label, echoed by `push` and `diff`. Never sent to the API. */
    project: z.string().min(1).max(200).optional(),
    locations: collection(locationBody),
    schedules: collection(scheduleBody),
    resources: collection(resourceBody),
    resourceGroups: collection(resourceGroupBody),
    policies: collection(policyBody),
    services: collection(serviceBody),
  })
  .strict();

export type BookrailConfigInput = z.input<typeof configSchema>;
export type BookrailConfig = z.output<typeof configSchema>;

export const ENTITY_KINDS = [
  'locations',
  'schedules',
  'resources',
  'resourceGroups',
  'policies',
  'services',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** The schema of one entry of each collection, for `bookrail schema <entity>`. */
export const entrySchemas = {
  locations: z.object({ id: idSchema, ...locationBody }).strict(),
  schedules: z.object({ id: idSchema, ...scheduleBody }).strict(),
  resources: z.object({ id: idSchema, ...resourceBody }).strict(),
  resourceGroups: z.object({ id: idSchema, ...resourceGroupBody }).strict(),
  policies: z.object({ id: idSchema, ...policyBody }).strict(),
  services: z.object({ id: idSchema, ...serviceBody }).strict(),
} as const;
