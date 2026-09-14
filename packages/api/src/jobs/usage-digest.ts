/**
 * The daily usage digest: one plain text message, every morning, whatever happened.
 *
 * ## Why it exists
 *
 * Bookrail has been public since 10 September 2026 and anybody can get a test key since the
 * 11th. On 14 September 2026 the only way to find out whether a single person outside this
 * company had used it was to open a shell on the server, read Postgres by hand and grep the access
 * log of nginx. That reading is this file: the same three questions, asked on a schedule, sent
 * to the mailbox the founder already reads.
 *
 * ## The three rules that shape it
 *
 * **It is sent even when nothing happened.** A day with no message must mean "the job is
 * broken", never "there was nothing to say". A digest that stayed quiet on a quiet day would be
 * indistinguishable from a worker that died in the night, and the whole point of it is to be
 * the thing that notices.
 *
 * **It carries no secret and no stranger's address.** Never a key, a hash, a prefix, a token or
 * an `ip_hash`; and an address only where an account exists (`usage_digest_signups` returns
 * `NULL` for anything that did not reach `claimed`, migration 0022). What arrives in a mailbox
 * stays in a mailbox for years, so the question is not whether the founder may see it but
 * whether it needs to leave the database at all.
 *
 * **It is built by a pure function.** {@link buildUsageDigest} takes the data and the instant
 * and returns a subject and a body, with no database, no clock and no Redis in it, so every
 * shape of day (empty, one row, many rows, no counters at all) is a test with a fixed
 * expectation rather than a fixture somebody has to produce.
 *
 * ## Where each number comes from
 *
 *   * sign ups and new accounts: the last 25 hours, from `usage_digest_signups` and
 *     `usage_digest_accounts`. Twenty five and not twenty four so that the hour the clocks give
 *     back in October falls inside a digest rather than between two of them
 *     ({@link DIGEST_SIGNUP_WINDOW_HOURS});
 *   * keys: the last 7 days, from `usage_digest_keys`. A week and not a day because a key used
 *     once on Tuesday is the news, and a digest that only ever showed yesterday would report it
 *     once and then behave as if it had never happened;
 *   * requests: whole UTC days out of Redis, yesterday in detail and the seven days as totals.
 *     UTC and not Europe/Rome because the counter is written by the API on the request path,
 *     where turning an instant into a local day would mean a time zone conversion per request
 *     for a report that is read once (`src/usage-counters.ts`).
 */
import { sql, type Database } from '@bookrail/db';
import type { Logger } from '@bookrail/shared';
import type { Mailer, MailMessage } from '../mail/index.js';
import {
  previousUtcDay,
  readUsageDays,
  utcDay,
  type UsageRedis,
  type UsageRow,
} from '../usage-counters.js';

/** The widest line the message may contain. Plain text, read in a terminal or a phone. */
export const DIGEST_WIDTH = 78;

/**
 * How far back the sign up and account sections look. Twenty five hours, not twenty four.
 *
 * The extra hour is a deliberate overlap, and it exists because the cron is in a local time
 * zone. Two runs of `0 7 * * *` in Europe/Rome are 25 hours apart on the Sunday the clocks go
 * back (25 October 2026 is the next one): with a window of exactly 24 hours the hour between
 * 05:00Z and 06:00Z of that day would fall into no digest at all, for ever, and a sign up made
 * in it would never be reported. With 25 the same hour is reported twice, once a year, which is
 * the cheaper mistake by a wide margin. The footer says so, so that a duplicate is read as a
 * duplicate.
 *
 * It does **not** repair a run that never happened: pg-boss does not catch up a missed cron
 * (`shouldSendIt` wants the tick within a minute), so a worker that was down at seven loses that
 * day's sign ups and accounts from every digest. The keys and the request counts survive, since
 * their windows are seven and nine days. That limit is declared rather than fixed: repairing it
 * means remembering when the last digest went out, which is a row in a table, and this feature
 * deliberately keeps no table of its own.
 */
export const DIGEST_SIGNUP_WINDOW_HOURS = 25;

/** How far back the key section looks. */
export const DIGEST_KEY_WINDOW_DAYS = 7;

/** How many whole UTC days of request counters the digest totals. */
export const DIGEST_REQUEST_DAYS = 7;

/** The time zone the header is written in. The founder's, and the one the cron uses. */
export const DIGEST_TIMEZONE = 'Europe/Rome';

/**
 * The most rows any one section prints. The rest become one line saying how many.
 *
 * The sign up endpoint is limited by the reverse proxy to five requests a minute **per address**,
 * so one caller can write 7 200 rows in a day and several callers multiply that. Printing them
 * all would turn the one message that is supposed to notice trouble into several hundred
 * kilobytes of text in which the useful number (how many, of what status) is buried, and a body
 * that big is also the kind of message an SMTP server refuses. A digest that stops arriving on
 * the day something happens is the exact failure this digest exists to prevent.
 *
 * The counts in the headings and in the subject stay the **true** ones: what is capped is how
 * much of the list is printed, never what is counted.
 */
export const DIGEST_MAX_ROWS = 50;

export interface DigestSignup {
  createdAt: Date;
  client: string;
  status: string;
  /** Present only for a sign up that became an account. `null` for every other status. */
  email: string | null;
  accountName: string;
  projectName: string;
}

export interface DigestAccount {
  name: string;
  origin: string;
  ownerEmail: string | null;
  createdAt: Date;
  projects: number;
}

export interface DigestKey {
  accountName: string;
  accountOrigin: string;
  projectId: string;
  projectName: string;
  environment: string;
  kind: string;
  lastUsedAt: Date;
  createdAt: Date;
}

/** One project's requests on the reported day. */
export interface DigestRequestRow extends UsageRow {
  /** Resolved from the keys section, or `null` when no key of that project was used. */
  projectName: string | null;
}

export interface DigestRequests {
  /** The last whole UTC day, which is the one reported project by project. */
  day: string;
  rows: DigestRequestRow[];
  /** The seven days, oldest first: the total of every project on each. */
  week: { day: string; requests: number }[];
}

export interface UsageDigestData {
  signups: DigestSignup[];
  accounts: DigestAccount[];
  keys: DigestKey[];
  /** `null` when no counter could be read at all. {@link requestsUnavailable} says why. */
  requests: DigestRequests | null;
  /** The reason there are no counts, printed as it is. Absent when there are. */
  requestsUnavailable?: string;
  /** The machine that sent it, so two deployments cannot be confused for one. */
  host: string;
  timezone: string;
  signupWindowHours: number;
  keyWindowDays: number;
}

/** What the two phrases of an unreadable counter are, so the tests name them once. */
export const REQUESTS_NO_REDIS = 'request counts unavailable: no Redis';
export const REQUESTS_READ_FAILED = 'request counts unavailable: Redis could not be read';

// --- the pure builder -------------------------------------------------------------------

/**
 * The message, from the data and the instant it is being sent at.
 *
 * No clock, no database, no Redis, no environment: everything that varies is an argument, and
 * the body is a deterministic function of the two. That is what lets the tests assert on the
 * whole text rather than on the presence of a word in it.
 */
export function buildUsageDigest(
  data: UsageDigestData,
  now: Date,
): { subject: string; text: string } {
  const tz = data.timezone;
  const requests = data.requests;
  const dayTotal =
    requests === null ? null : requests.rows.reduce((sum, row) => sum + row.requests, 0);

  const lines: string[] = [];
  lines.push(`Bookrail usage digest, ${longDate(now, tz)}, ${clock(now, tz)} ${tz}`);
  const from = new Date(now.getTime() - data.signupWindowHours * 3_600_000);
  lines.push(
    `Window: ${shortDate(from, tz)} ${clock(from, tz)} to ${shortDate(now, tz)} ` +
      `${clock(now, tz)} for sign ups and accounts, last ${String(data.keyWindowDays)} days`,
    'for keys, whole UTC days for requests.',
  );

  // --- sign ups
  lines.push(
    '',
    `Sign ups in the last ${String(data.signupWindowHours)} hours: ${String(data.signups.length)}`,
  );
  const signups = capped(data.signups);
  lines.push(
    ...table(
      signups.shown.map((row) => [
        stamp(row.createdAt),
        row.client,
        row.status,
        row.email ?? '(address withheld)',
        `${row.accountName} / ${row.projectName}`,
      ]),
      // The address column has no cap: an address is what the founder writes back to, and half
      // an address is worse than none. It is the last column of the wrapped set, so a long one
      // pushes the names onto a continuation line instead of losing its own tail.
      [17, 10, 12, null, 40],
    ),
    ...more(signups),
  );

  // --- accounts
  lines.push(
    '',
    `New accounts in the last ${String(data.signupWindowHours)} hours: ${String(data.accounts.length)}`,
  );
  const accounts = capped(data.accounts);
  lines.push(
    ...table(
      accounts.shown.map((row) => [
        row.name,
        row.origin,
        row.ownerEmail ?? '(no address)',
        plural(row.projects, 'project'),
      ]),
      [24, 10, null, 12],
    ),
    ...more(accounts),
  );

  // --- keys
  lines.push(
    '',
    `Keys used in the last ${String(data.keyWindowDays)} days: ${String(data.keys.length)}`,
  );
  const keys = capped(data.keys);
  if (data.keys.length > 0) {
    lines.push(
      ...table(
        [
          ['last used', 'env', 'account (origin)', 'project', 'key'],
          ...keys.shown.map((row) => [
            stamp(row.lastUsedAt),
            row.environment,
            `${row.accountName} (${row.accountOrigin})`,
            row.projectName,
            row.kind,
          ]),
        ],
        [17, 5, 30, 24, 12],
      ),
      ...more(keys),
    );
  }

  // --- requests
  lines.push('');
  if (requests === null || dayTotal === null) {
    lines.push(`Requests by project: ${data.requestsUnavailable ?? REQUESTS_NO_REDIS}`);
  } else {
    const err4xx = requests.rows.reduce((sum, row) => sum + row.err4xx, 0);
    const err5xx = requests.rows.reduce((sum, row) => sum + row.err5xx, 0);
    lines.push(
      `Requests by project, ${requests.day} UTC: ${plural(requests.rows.length, 'project')}, ` +
        `${plural(dayTotal, 'request')}, ${String(err4xx)} 4xx, ${String(err5xx)} 5xx`,
    );
    if (requests.rows.length > 0) {
      const busiest = capped([...requests.rows].sort((a, b) => b.requests - a.requests));
      lines.push(
        ...table(
          [
            ['project', 'env', 'requests', '4xx', '5xx'],
            ...busiest.shown.map((row) => [
              row.projectName ?? row.projectId,
              row.environment,
              String(row.requests),
              String(row.err4xx),
              String(row.err5xx),
            ]),
          ],
          [30, 5, 8, 5, 5],
          [false, false, true, true, true],
        ),
        ...more(busiest),
      );
    }
    const weekTotal = requests.week.reduce((sum, entry) => sum + entry.requests, 0);
    lines.push(
      `Last ${plural(requests.week.length, 'day')}: ${plural(weekTotal, 'request')} ` +
        `(a day: ${requests.week.map((entry) => String(entry.requests)).join(', ')})`,
    );
  }

  // --- footer
  lines.push(
    '',
    'The window overlaps the previous digest by one hour, so a row can appear twice',
    'on the Sunday the clocks change.',
    `Sent by the Bookrail worker on ${data.host}.`,
    'Request counters live in Redis for 9 days; everything else is read through',
    'usage_digest_* (migration 0022).',
  );

  const subject =
    `Bookrail usage, ${subjectDate(now, tz)}: ` +
    `${plural(data.signups.length, 'sign up')}, ` +
    `${plural(data.keys.length, 'key')} used, ` +
    `${dayTotal === null ? 'requests unavailable' : plural(dayTotal, 'request')}`;

  return { subject, text: `${lines.map((line) => clip(line)).join('\n')}\n` };
}

// --- the collector ----------------------------------------------------------------------

export interface UsageDigestDeps {
  db: Database;
  logger: Logger;
}

export interface UsageDigestOptions {
  /** The one address the digest goes to. */
  to: string;
  /** The machine name that appears in the footer. */
  host: string;
  /** The client that holds the request counters, or nothing at all. */
  usageRedis?: UsageRedis | undefined;
  timezone?: string;
  /** The instant the digest is for. A test passes one; the job passes none. */
  now?: Date;
  signupWindowHours?: number;
  keyWindowDays?: number;
  requestDays?: number;
}

interface SignupRow extends Record<string, unknown> {
  created_at: Date;
  client: string;
  status: string;
  email: string | null;
  account_name: string;
  project_name: string;
}

interface KeyRow extends Record<string, unknown> {
  account_name: string;
  account_origin: string;
  project_id: string;
  project_name: string;
  environment: string;
  kind: string;
  last_used_at: Date;
  created_at: Date;
}

interface AccountRow extends Record<string, unknown> {
  name: string;
  origin: string;
  owner_email: string | null;
  created_at: Date;
  projects: number;
}

/**
 * Asks the three functions and Redis, and returns what the builder needs.
 *
 * Redis is allowed to fail on its own: an unreadable counter turns into a sentence in the
 * message, not into a missing message. The three database reads are not: if Postgres cannot
 * answer, there is nothing worth sending and the caller logs the failure.
 */
export async function collectUsageDigest(
  deps: UsageDigestDeps,
  options: UsageDigestOptions,
): Promise<UsageDigestData> {
  const now = options.now ?? new Date();
  const signupWindowHours = options.signupWindowHours ?? DIGEST_SIGNUP_WINDOW_HOURS;
  const keyWindowDays = options.keyWindowDays ?? DIGEST_KEY_WINDOW_DAYS;
  const requestDays = options.requestDays ?? DIGEST_REQUEST_DAYS;

  const since = new Date(now.getTime() - signupWindowHours * 3_600_000);
  const keysSince = new Date(now.getTime() - keyWindowDays * 24 * 3_600_000);

  const signups = await deps.db.execute<SignupRow>(
    sql`SELECT * FROM usage_digest_signups(${since})`,
  );
  const accounts = await deps.db.execute<AccountRow>(
    sql`SELECT * FROM usage_digest_accounts(${since})`,
  );
  const keys = await deps.db.execute<KeyRow>(sql`SELECT * FROM usage_digest_keys(${keysSince})`);

  const keyRows: DigestKey[] = keys.rows.map((row) => ({
    accountName: row.account_name,
    accountOrigin: row.account_origin,
    projectId: row.project_id,
    projectName: row.project_name,
    environment: row.environment,
    kind: row.kind,
    lastUsedAt: new Date(row.last_used_at),
    createdAt: new Date(row.created_at),
  }));

  const data: UsageDigestData = {
    signups: signups.rows.map((row) => ({
      createdAt: new Date(row.created_at),
      client: row.client,
      status: row.status,
      email: row.email,
      accountName: row.account_name,
      projectName: row.project_name,
    })),
    accounts: accounts.rows.map((row) => ({
      name: row.name,
      origin: row.origin,
      ownerEmail: row.owner_email,
      createdAt: new Date(row.created_at),
      projects: Number(row.projects),
    })),
    keys: keyRows,
    requests: null,
    host: options.host,
    timezone: options.timezone ?? DIGEST_TIMEZONE,
    signupWindowHours,
    keyWindowDays,
  };

  if (options.usageRedis === undefined) {
    data.requestsUnavailable = REQUESTS_NO_REDIS;
    return data;
  }

  /**
   * The project names come from the key rows, not from a fourth function.
   *
   * A project that made a request in the window necessarily has a key whose `last_used_at` is
   * inside the seven days, because that column is written by the same authentication that let
   * the request in. So the join is free, and a project whose name cannot be found that way is
   * printed by its identifier rather than guessed at.
   */
  const names = new Map(keyRows.map((row) => [row.projectId, row.projectName]));
  // The last **whole** UTC day: today's counters are still being written, and a report whose
  // last column grows while you read it is a report nobody can compare with yesterday's.
  const day = previousUtcDay(utcDay(now.getTime()));

  // The seven days, oldest first, read in **one** pass of the keyspace: `MATCH` is a filter
  // applied after the scan, so asking seven times for `usage:<one day>:*` was seven full walks
  // of a keyspace that also holds `avail:*` and `rl:key:*`. One walk of `usage:*` and the day
  // taken off the key answers the same question for a seventh of the round trips.
  const wanted: string[] = [];
  for (let back = requestDays - 1; back >= 0; back -= 1) wanted.push(previousUtcDay(day, back));

  try {
    const counted = await readUsageDays(options.usageRedis, wanted);
    const week = wanted.map((each) => ({
      day: each,
      requests: (counted.get(each) ?? []).reduce((sum, row) => sum + row.requests, 0),
    }));
    const rows: DigestRequestRow[] = (counted.get(day) ?? []).map((row) => ({
      ...row,
      projectName: names.get(row.projectId) ?? null,
    }));
    data.requests = { day, rows, week };
  } catch (error) {
    deps.logger.warn('usage_digest_counters_unreadable', {
      error: error instanceof Error ? error.message : String(error),
    });
    data.requestsUnavailable = REQUESTS_READ_FAILED;
  }
  return data;
}

export interface UsageDigestResult {
  sent: boolean;
  subject: string;
  message: MailMessage;
}

/**
 * Collects, builds and sends. One message, one attempt.
 *
 * A mail server that is down is a `warn` and nothing else: there is no retry inside the day,
 * because the next morning asks the same three questions about a window that has moved by a
 * day and the missing morning is visible in the message that does arrive. A queue of unsent
 * digests would be a second thing to operate for a report whose value is that it needs none.
 */
export async function runUsageDigest(
  deps: UsageDigestDeps & { mailer: Mailer },
  options: UsageDigestOptions,
): Promise<UsageDigestResult> {
  const now = options.now ?? new Date();
  const data = await collectUsageDigest(deps, { ...options, now });
  const { subject, text } = buildUsageDigest(data, now);
  const message: MailMessage = { to: options.to, subject, text };

  try {
    await deps.mailer.send(message);
    deps.logger.info('usage_digest_sent', {
      to: options.to,
      signups: data.signups.length,
      accounts: data.accounts.length,
      keys: data.keys.length,
      requests:
        data.requests === null ? null : data.requests.rows.reduce((s, r) => s + r.requests, 0),
    });
    return { sent: true, subject, message };
  } catch (error) {
    deps.logger.warn('usage_digest_send_failed', {
      to: options.to,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: false, subject, message };
  }
}

// --- formatting -------------------------------------------------------------------------

/** `2026-09-13 18:02Z`: the UTC instant, to the minute, which is all a digest needs. */
function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/**
 * The pieces of a date in a time zone, assembled by hand rather than by a locale pattern.
 *
 * `Intl` is used for the hard part (what the day, the month and the weekday are in Europe/Rome
 * at a given instant) and not for the easy one (the order they go in and the punctuation
 * between them). A locale pattern would put a comma after the weekday in one release of ICU and
 * not in another, and abbreviate September as `Sept` or `Sep` depending on the same, which
 * would make the text of this message a property of the machine that sent it. Every separator
 * below is written here.
 */
function parts(
  at: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const found: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone, ...options }).formatToParts(at)) {
    found[part.type] = part.value;
  }
  return found;
}

/** `Monday 14 September 2026`. */
function longDate(at: Date, timeZone: string): string {
  const p = parts(at, timeZone, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return `${p.weekday ?? ''} ${p.day ?? ''} ${p.month ?? ''} ${p.year ?? ''}`;
}

/** `14 September 2026`, for the subject. */
function subjectDate(at: Date, timeZone: string): string {
  const p = parts(at, timeZone, { day: 'numeric', month: 'long', year: 'numeric' });
  return `${p.day ?? ''} ${p.month ?? ''} ${p.year ?? ''}`;
}

/** `13 Sep`, for the window. Three letters, always, whatever ICU thinks of September. */
function shortDate(at: Date, timeZone: string): string {
  const p = parts(at, timeZone, { day: 'numeric', month: 'short' });
  return `${p.day ?? ''} ${(p.month ?? '').slice(0, 3)}`;
}

/** `07:00`, twenty-four hour. */
function clock(at: Date, timeZone: string): string {
  const p = parts(at, timeZone, { hour: '2-digit', minute: '2-digit', hour12: false });
  // `hourCycle` h23 would be the tidy way to say this, but `hour12: false` on some ICU builds
  // still yields `24` for midnight, so the one value that would be wrong is fixed here.
  const hour = p.hour === '24' ? '00' : (p.hour ?? '');
  return `${hour}:${p.minute ?? ''}`;
}

/** `1 project`, `2 projects`. English, and never a bare number with a guessed noun. */
export function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** What one section prints, and how many rows it left out. */
interface Capped<T> {
  shown: readonly T[];
  hidden: number;
}

/** The first {@link DIGEST_MAX_ROWS} rows, and the count of the ones that did not fit. */
function capped<T>(rows: readonly T[], max = DIGEST_MAX_ROWS): Capped<T> {
  return { shown: rows.slice(0, max), hidden: Math.max(0, rows.length - max) };
}

/** The one line that stands for everything a section did not print, or nothing. */
function more<T>(section: Capped<T>): string[] {
  return section.hidden === 0 ? [] : [`  ... and ${String(section.hidden)} more`];
}

/**
 * A line no wider than the message.
 *
 * Cut rather than wrapped, and the cut is **marked**: three dots say that something is missing,
 * so nobody reads a shortened name as a whole one. Nothing that reaches this function can be an
 * address: `table` wraps the address column instead of handing it here (see below).
 */
export function clip(line: string, width = DIGEST_WIDTH): string {
  return line.length <= width ? line : `${line.slice(0, width - 3)}...`;
}

/**
 * The width of a column, or `null` for "as wide as it needs to be".
 *
 * `null` is how a column says that its content must not be shortened. There is exactly one such
 * column in this message and it is the address: an address is the thing the founder writes back
 * to, and a silently shortened one is a wrong answer that reads like a right one. Everything
 * else here is a name, where a marked cut costs nothing.
 */
type ColumnCap = number | null;

/**
 * Columns as wide as their contents, up to a cap, with the last one unpadded.
 *
 * The widths are computed from the rows rather than fixed, so a quiet day (which is most days,
 * and the day this has to be readable on) has no oceans of spaces in it, and a busy one still
 * lines up.
 *
 * **Two different things happen to content that does not fit, and the difference is the point.**
 * A cell wider than its cap is shortened and gets three dots, exactly like {@link clip}, so the
 * reader can see that something was removed. A cell in an uncapped column (the address) is never
 * shortened: if the whole row then exceeds the width of the message, the row is **wrapped** and
 * the columns after the uncapped one continue on an indented line of their own. A long address
 * therefore costs a second line, never its own tail.
 */
export function table(
  rows: readonly (readonly string[])[],
  caps: readonly ColumnCap[],
  alignRight: readonly boolean[] = [],
  indent = '  ',
): string[] {
  if (rows.length === 0) return [];
  const columns = Math.max(...rows.map((row) => row.length));
  const longestOf = (index: number): number =>
    Math.max(...rows.map((row) => (row[index] ?? '').length));

  // Capped columns first: their width is decided by their own content.
  const widths: number[] = [];
  for (let index = 0; index < columns; index += 1) {
    const cap = caps[index];
    widths.push(cap === null || cap === undefined ? 0 : Math.min(longestOf(index), cap));
  }

  // Then the uncapped ones, which are padded only as far as the line can afford. Padding is
  // alignment, not truncation: a value wider than its padding still goes out whole, on a
  // continuation line of its own. Without this budget a single 63 character address would pad
  // the column for every row of the section and push even the short rows over the edge.
  const separators = 2 * Math.max(0, columns - 1);
  const fixed = widths.reduce((sum, width) => sum + width, 0);
  for (let index = 0; index < columns; index += 1) {
    if (caps[index] !== null) continue;
    const budget = DIGEST_WIDTH - indent.length - separators - fixed;
    widths[index] = Math.max(0, Math.min(longestOf(index), budget));
  }

  const uncapped = new Set<number>();
  for (let index = 0; index < columns; index += 1) if (caps[index] === null) uncapped.add(index);

  const render = (cell: string, index: number, last: boolean): string => {
    const width = widths[index] ?? cell.length;
    const value = !uncapped.has(index) && cell.length > width ? shorten(cell, width) : cell;
    // A right aligned column is padded even when it is the last one: a column of numbers that
    // lost its alignment on the final column would be the one column nobody can read down. A
    // left aligned last column is not padded, so no line ends in spaces.
    if (alignRight[index] === true) return value.padStart(width);
    return last ? value : value.padEnd(Math.max(width, value.length));
  };

  const out: string[] = [];
  for (const row of rows) {
    const whole = `${indent}${row.map((cell, index) => render(cell, index, index === row.length - 1)).join('  ')}`;
    if (whole.length <= DIGEST_WIDTH || uncapped.size === 0) {
      out.push(clip(whole));
      continue;
    }
    // Too wide, and the row carries something that must not be shortened. The row is split:
    // everything that may be shortened stays on the first line (and is shortened there, with
    // the three dots that say so), and each protected value gets an indented line to itself,
    // where an address of any realistic length fits whole.
    const kept = row.filter((_cell, index) => !uncapped.has(index));
    const keptCaps = row
      .map((_cell, index) => index)
      .filter((index) => !uncapped.has(index))
      .map((index) => widths[index] ?? 0);
    const head = kept
      .map((cell, position) =>
        position === kept.length - 1
          ? shortenTo(cell, keptCaps[position] ?? cell.length)
          : shortenTo(cell, keptCaps[position] ?? cell.length).padEnd(keptCaps[position] ?? 0),
      )
      .join('  ');
    out.push(clip(`${indent}${head}`.trimEnd()));
    for (const index of uncapped) {
      const value = row[index];
      if (value === undefined || value === '') continue;
      out.push(clip(`${indent}    ${value}`));
    }
  }
  return out;
}

/** `a.very.long.name` at width 10 becomes `a.very....`: shortened, and saying so. */
function shorten(cell: string, width: number): string {
  return width <= 3 ? cell.slice(0, width) : `${cell.slice(0, width - 3)}...`;
}

/** The same, but a no-op when the cell already fits. */
function shortenTo(cell: string, width: number): string {
  return cell.length <= width ? cell : shorten(cell, width);
}
