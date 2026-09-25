/**
 * The plan table of `src/plans.ts`, against the pricing table it transcribes.
 *
 * The numbers of the plans are written twice in the working copy: once in the pricing document
 * that states them to people, and once here, where the code reads them. Two copies of a number
 * drift apart the first time somebody edits one of them, so this test reads the document and
 * compares the rows the code depends on, cell by cell.
 *
 * The document is found by the shape of its name rather than named outright, so that this file
 * is not itself a citation of it. In a checkout that does not contain it (the public repository
 * publishes the code and not the internal documents) there is nothing to compare against, and
 * only the properties of the table that do not depend on the document are checked.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PAID_PLAN_IDS,
  PLAN_IDS,
  PLAN_PRICES,
  PLANS,
  perMilleOf,
  planMonthOf,
  planOf,
  reachedThresholds,
  type PlanId,
} from '../src/plans.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function pricingDocument(): string | null {
  const name = readdirSync(REPO_ROOT).find((entry) => /^[0-9]{2}-pricing\.md$/.test(entry));
  return name === undefined ? null : readFileSync(join(REPO_ROOT, name), 'utf8');
}

/** The four cells of a row of the plan table, in the order Free, Pro, Scale, Enterprise. */
function row(document: string, label: string): string[] {
  const line = document.split('\n').find((candidate) => candidate.startsWith(`| ${label} |`));
  if (line === undefined) throw new Error(`The pricing table has no row "${label}".`);
  const cells = line
    .split('|')
    .slice(2, -1)
    .map((cell) => cell.trim());
  expect(cells).toHaveLength(4);
  return cells;
}

/** `1.000` → 1000, `50.000` → 50000. The document writes thousands with a dot. */
function italianInteger(cell: string): number {
  const match = /([0-9]{1,3}(?:\.[0-9]{3})*)/.exec(cell);
  if (match?.[1] === undefined) throw new Error(`No number in "${cell}".`);
  return Number(match[1].replace(/\./g, ''));
}

const UNBOUNDED = /^(negoziato|illimitati)$/i;

const ORDER: readonly PlanId[] = ['free', 'pro', 'scale', 'enterprise'];

describe('the plan table', () => {
  it('has exactly the four plans, in the order of the pricing table', () => {
    expect([...PLAN_IDS]).toEqual(ORDER);
    expect(Object.keys(PLANS).sort()).toEqual([...ORDER].sort());
  });

  it('lets only the free plan block, and gives it a finite quantity of both kinds', () => {
    for (const id of PLAN_IDS) expect(PLANS[id].blocksAtLimit).toBe(id === 'free');
    expect(PLANS.free.bookingsIncluded).not.toBeNull();
    expect(PLANS.free.paymentVolumeIncluded).not.toBeNull();
  });

  it('gives every plan a rate limit whose burst is at least its rate', () => {
    for (const id of PLAN_IDS) {
      const { rate, burst } = PLANS[id].rateLimit;
      expect(Number.isSafeInteger(rate) && rate > 0).toBe(true);
      expect(burst).toBeGreaterThanOrEqual(rate);
    }
  });

  it('agrees with the pricing document, row by row', () => {
    const document = pricingDocument();
    if (document === null) {
      // The public repository: the table above is the only statement of the plans there is.
      expect(PLANS.free.bookingsIncluded).toBe(1000);
      return;
    }

    const bookings = row(document, 'Prenotazioni incluse/mese');
    const extra = row(document, 'Prenotazione aggiuntiva');
    const volume = row(document, 'Pagamenti orchestrati');
    const projects = row(document, 'Progetti');
    const members = row(document, 'Membri del team');
    const rateLimit = row(document, 'Rate limit');

    ORDER.forEach((id, index) => {
      const plan = PLANS[id];
      const cell = (cells: string[]): string => cells[index] ?? '';

      expect(plan.bookingsIncluded, `${id}: bookings`).toBe(
        UNBOUNDED.test(cell(bookings)) ? null : italianInteger(cell(bookings)),
      );
      expect(plan.blocksAtLimit, `${id}: blocks`).toBe(/blocco/i.test(cell(extra)));
      // "Fino a 1.000 €/mese" is a cap in euro; a percentage is a price on the volume, which is
      // billed and never capped.
      expect(plan.paymentVolumeIncluded, `${id}: volume`).toBe(
        /€/.test(cell(volume)) ? italianInteger(cell(volume)) * 100 : null,
      );
      expect(plan.projects, `${id}: projects`).toBe(
        UNBOUNDED.test(cell(projects)) ? null : italianInteger(cell(projects)),
      );
      expect(plan.members, `${id}: members`).toBe(
        UNBOUNDED.test(cell(members)) ? null : italianInteger(cell(members)),
      );
      // A negotiated rate limit has the scale plan's numbers until a contract says otherwise.
      expect(plan.rateLimit.rate, `${id}: rate`).toBe(
        UNBOUNDED.test(cell(rateLimit))
          ? PLANS.scale.rateLimit.rate
          : italianInteger(cell(rateLimit)),
      );
    });
  });
});

/** `29 €/mese` → 2900, `0,03 €` → 3, `0,4% del volume` → 4 per mille. */
function euroCents(cell: string): number {
  const match = /([0-9]{1,3}(?:\.[0-9]{3})*)(?:,([0-9]{1,2}))?\s*€/.exec(cell);
  if (match?.[1] === undefined) throw new Error(`No amount in euro in "${cell}".`);
  const whole = Number(match[1].replace(/\./g, ''));
  const cents = Number((match[2] ?? '0').padEnd(2, '0'));
  return whole * 100 + cents;
}

function perMille(cell: string): number {
  const match = /([0-9]+)(?:,([0-9]))?\s*%/.exec(cell);
  if (match?.[1] === undefined) throw new Error(`No percentage in "${cell}".`);
  return Number(match[1]) * 10 + Number(match[2] ?? '0');
}

describe('the prices of the paid plans', () => {
  it('are whole numbers: cents, and per mille of the volume', () => {
    for (const id of PAID_PLAN_IDS) {
      const price = PLAN_PRICES[id];
      for (const value of [price.monthly, price.extraBooking, price.paymentsPerMille]) {
        expect(Number.isSafeInteger(value) && value > 0).toBe(true);
      }
    }
  });

  it('agree with the pricing document', () => {
    const document = pricingDocument();
    if (document === null) {
      expect(PLAN_PRICES.pro.monthly).toBe(2900);
      return;
    }
    const base = row(document, 'Prezzo base');
    const extra = row(document, 'Prenotazione aggiuntiva');
    const volume = row(document, 'Pagamenti orchestrati');
    for (const id of PAID_PLAN_IDS) {
      const index = ORDER.indexOf(id);
      expect(PLAN_PRICES[id].monthly, `${id}: base`).toBe(euroCents(base[index] ?? ''));
      expect(PLAN_PRICES[id].extraBooking, `${id}: extra`).toBe(euroCents(extra[index] ?? ''));
      expect(PLAN_PRICES[id].paymentsPerMille, `${id}: payments`).toBe(
        perMille(volume[index] ?? ''),
      );
    }
  });

  it('rounds a per mille amount half up to the cent, in integers', () => {
    expect(perMilleOf(123_450, 4)).toBe(494); // 493.8
    expect(perMilleOf(125, 4)).toBe(1); // 0.5, half up
    expect(perMilleOf(124, 4)).toBe(0); // 0.496
    expect(perMilleOf(100_000, 3)).toBe(300);
    expect(perMilleOf(0, 4)).toBe(0);
    expect(perMilleOf(-5000, 4)).toBe(0);
    expect(() => perMilleOf(1.5, 4)).toThrow();
  });
});

describe('the helpers', () => {
  it('names the UTC month of an instant', () => {
    expect(planMonthOf(Date.UTC(2026, 8, 30, 23, 59, 59, 999))).toBe('2026-09');
    expect(planMonthOf(Date.UTC(2026, 9, 1))).toBe('2026-10');
    expect(planMonthOf(Date.UTC(2031, 0, 1))).toBe('2031-01');
  });

  it('falls back to the free plan for a value it does not know', () => {
    expect(planOf('pro')).toBe('pro');
    expect(planOf('gold')).toBe('free');
    expect(planOf(null)).toBe('free');
  });

  it('reaches a threshold exactly at its percentage, in whole numbers', () => {
    expect(reachedThresholds(799, 1000)).toEqual([]);
    expect(reachedThresholds(800, 1000)).toEqual([80]);
    expect(reachedThresholds(999, 1000)).toEqual([80]);
    expect(reachedThresholds(1000, 1000)).toEqual([80, 100]);
    expect(reachedThresholds(4, 5)).toEqual([80]);
    expect(reachedThresholds(10, null)).toEqual([]);
  });
});
