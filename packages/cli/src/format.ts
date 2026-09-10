/**
 * Presentation of the values the operational commands print: instants, money, durations.
 *
 * The API answers in UTC, always, and carries the time zone alongside it for presentation. A
 * person reading a padel schedule in Rome does not think in UTC, so every table that shows an
 * instant shows it twice: the UTC form, which is what goes back into the next command, and the
 * local form in the time zone of the answer, which is what the person recognises. `--json`
 * carries only the UTC form the API sent, untouched.
 */

/** `2026-09-08T07:00:00Z` -> `2026-09-08 09:00` in `timezone`, or the raw value if unusable. */
export function localTime(iso: string | null | undefined, timezone: string | null): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (timezone === null || timezone === '') return iso;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    // `hour12: false` yields `24` for midnight in some ICU versions; `00` is the same instant
    // and the only form a reader expects.
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
  } catch {
    return iso;
  }
}

/** `{ amount: 2500, currency: "EUR" }` -> `25.00 EUR`. Amounts are minor units everywhere. */
export function money(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const price = value as { amount?: unknown; currency?: unknown };
  if (typeof price.amount !== 'number' || typeof price.currency !== 'string') return '';
  return `${(price.amount / 100).toFixed(2)} ${price.currency}`;
}

/**
 * `{ index: 0, label: "Weekend" }` -> `#0 Weekend`, `null` -> `base`.
 *
 * The flat price is shown as `base` rather than as an empty cell: a column of blanks reads as
 * "this feature is not working", and the point of the column is to say which rule priced each
 * slot, of which "none, the service price" is a real answer.
 */
export function priceRule(value: unknown): string {
  if (value === null || value === undefined) return 'base';
  if (typeof value !== 'object') return '';
  const rule = value as { index?: unknown; label?: unknown };
  if (typeof rule.index !== 'number') return '';
  const label = typeof rule.label === 'string' && rule.label !== '' ? ` ${rule.label}` : '';
  return `#${String(rule.index)}${label}`;
}

/** The resource ids of one `resource_options` entry, as one cell. */
export function resourcesOf(option: unknown): string {
  if (typeof option !== 'object' || option === null) return '';
  const resources = (option as { resources?: unknown }).resources;
  if (!Array.isArray(resources)) return '';
  return resources
    .map((entry) => {
      const allocation = entry as { resource_id?: unknown; role?: unknown };
      const id = typeof allocation.resource_id === 'string' ? allocation.resource_id : '';
      return typeof allocation.role === 'string' && allocation.role !== ''
        ? `${id} (${allocation.role})`
        : id;
    })
    .join(' + ');
}

/** The shape of a service's duration, as `bookrail services list` shows it in one column. */
export function durationShape(row: Record<string, unknown>): string {
  const fixed = row.duration;
  if (typeof fixed === 'number') return `${fixed}m`;
  const options = row.duration_options;
  if (Array.isArray(options) && options.length > 0) return `${options.join('/')}m`;
  const range = row.duration_range;
  if (typeof range === 'object' && range !== null) {
    const bounds = range as { min?: unknown; max?: unknown };
    if (typeof bounds.min === 'number' && typeof bounds.max === 'number') {
      return `${bounds.min}-${bounds.max}m`;
    }
  }
  return '';
}

/** Seconds until `iso`, as `9m 58s`. Empty when the instant is absent or already past. */
export function countdown(iso: unknown, now = Date.now()): string {
  if (typeof iso !== 'string') return '';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '';
  const seconds = Math.round((target - now) / 1000);
  if (seconds <= 0) return 'expired';
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
}

export function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
