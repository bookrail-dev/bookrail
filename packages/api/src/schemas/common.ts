import { decodeId, ID_PREFIXES, type ObjectKind } from '@bookrail/shared';
import { z } from '../zod.js';

/** The public shape of a prefixed identifier: `loc_` plus the 32 hex digits of its UUID. */
export function idPattern(kind: ObjectKind): string {
  return `^${ID_PREFIXES[kind]}_[0-9a-f]{32}$`;
}

/** A prefixed identifier as it appears **in a response**, e.g. `loc_0198...`. */
export function objectId(kind: ObjectKind) {
  return z
    .string()
    .regex(new RegExp(idPattern(kind)))
    .openapi({
      description: `Identifier of a ${kind}, prefixed with \`${ID_PREFIXES[kind]}_\`.`,
      example: `${ID_PREFIXES[kind]}_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c`,
    });
}

/** Accepts the public prefixed identifier and yields the bare UUID stored in the database. */
export function refId(kind: ObjectKind) {
  return z
    .string()
    .transform((value, ctx) => {
      const decoded = decodeId(kind, value);
      if (!decoded) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected a ${kind} identifier of the form ${ID_PREFIXES[kind]}_....`,
        });
        return z.NEVER;
      }
      return decoded;
    })
    .openapi({
      type: 'string',
      pattern: idPattern(kind),
      description: `Identifier of a ${kind}, prefixed with \`${ID_PREFIXES[kind]}_\`.`,
      example: `${ID_PREFIXES[kind]}_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c`,
    });
}

export const metadataSchema = z.record(z.unknown()).openapi({
  description: 'Free-form key/value pairs stored with the object and returned untouched.',
});

export const timezoneSchema = z
  .string()
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Must be a valid IANA time zone, for example Europe/Rome.' },
  )
  .openapi({
    type: 'string',
    description: 'IANA time zone name.',
    example: 'Europe/Rome',
  });

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Must be a three letter ISO 4217 currency code.')
  .openapi({ description: 'Three letter ISO 4217 currency code.', example: 'EUR' });

export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Must be a time of day such as 09:00 or 09:00:00.')
  .openapi({
    description: 'Local time of day, `HH:MM` or `HH:MM:SS`.',
    example: '09:00',
  });

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a calendar date such as 2026-09-08.')
  .openapi({ format: 'date', description: 'Calendar date, `YYYY-MM-DD`.', example: '2026-09-08' });

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Any ISO 8601 instant with an explicit offset: the API accepts any offset on input. */
export const instantSchema = z
  .string()
  .regex(
    ISO_INSTANT_RE,
    'Must be an ISO 8601 instant with an explicit offset, e.g. 2026-09-08T07:00:00Z.',
  )
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()), { message: 'Not a valid instant.' })
  .openapi({
    type: 'string',
    format: 'date-time',
    description:
      'ISO 8601 instant with an explicit offset. Any offset is accepted on input; every instant is returned in UTC.',
    example: '2026-09-08T07:00:00Z',
  });

/** An instant **in a response**: always UTC, always with the `Z` designator. */
export const instantOutSchema = z.string().datetime({ offset: true }).openapi({
  description: 'ISO 8601 instant in UTC.',
  example: '2026-09-08T07:00:00Z',
});

export const nameSchema = z.string().min(1).max(200);

/** Rejects `{}` so that PATCH with nothing to change is a client error, not a silent no-op. */
export function nonEmptyPatch<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
      message: 'Provide at least one field to update.',
    });
}
