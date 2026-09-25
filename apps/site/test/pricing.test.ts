/**
 * The pricing page against the three places its numbers come from.
 *
 * A number on a pricing page is a promise. This file keeps it one: the prices in
 * `src/data/pricing.ts`, the limits in `PLANS` of `@bookrail/shared` (the table the API
 * enforces), the published table of the internal pricing document, and the built page all have
 * to say the same thing, cell by cell. Changing a price in one place and not in the others fails
 * here.
 *
 * The pricing document is found by the shape of its name rather than named outright, so this file
 * is not itself a citation of it. In a checkout that does not contain it (the public repository)
 * the comparison with the document is skipped and the rest still runs.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLANS, PLAN_IDS, type PlanId } from '@bookrail/shared';
import {
  MATRIX,
  MATRIX_ROW_KEYS,
  PRICED_PLANS,
  REGION,
  TEST_ENVIRONMENT,
  freeVolumeEur,
  pricingLede,
  type MatrixRowKey,
  type PricedPlan,
} from '../src/data/pricing.js';
import { distRoot, repoRoot } from './helpers.js';

function pricingDocument(): string | null {
  const name = readdirSync(repoRoot).find((entry) => /^[0-9]{2}-pricing\.md$/.test(entry));
  return name === undefined ? null : readFileSync(join(repoRoot, name), 'utf8');
}

const DOCUMENT = pricingDocument();

/** The rows of the published table: from its heading to the next heading. */
function publishedTable(document: string): Map<string, string[]> {
  const start = document.indexOf('### Pubblicata su bookrail.dev/pricing');
  if (start === -1) throw new Error('The pricing document has no published table.');
  const end = document.indexOf('\n### ', start + 1);
  const rows = new Map<string, string[]>();
  for (const line of document.slice(start, end).split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| |') || line.startsWith('|---')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [label, ...values] = cells;
    expect(values, label).toHaveLength(4);
    rows.set(label ?? '', values);
  }
  return rows;
}

/** The label of each published row in the document, which is in Italian. */
const DOCUMENT_LABELS: Record<MatrixRowKey, string> = {
  base_price: 'Prezzo base',
  bookings_included: 'Prenotazioni incluse/mese',
  extra_booking: 'Prenotazione aggiuntiva',
  payments: 'Pagamenti orchestrati',
  projects: 'Progetti',
  rate_limit: 'Rate limit',
  test_environment: 'Ambiente test',
  region: 'Regione',
  support: 'Supporto',
};

/** Rows that describe what does not exist today, and must never reach the page. */
const NOT_PUBLISHED = [
  'Membri del team',
  'Log richieste',
  'Eventi/webhook retention',
  'Notifiche gestite (email)',
  'Notifiche SMS/WhatsApp',
  'Portale hostato',
  'Regione a regime',
  'SLA',
  'SSO SAML, audit log esteso',
  'DPA, SOC 2 report',
];

/** `1.000` → 1000, `20.000` → 20000, `0,03` → 0.03. The document writes numbers in Italian. */
function italianNumber(cell: string): number {
  const match = /([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]+)?)/.exec(cell);
  if (match?.[1] === undefined) throw new Error(`No number in "${cell}".`);
  return Number(match[1].replace(/\./g, '').replace(',', '.'));
}

const NEGOTIATED = /^negoziato$/i;
const UNLIMITED = /^illimitati$/i;

function plan(id: PlanId): PricedPlan {
  const found = PRICED_PLANS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No priced plan ${id}.`);
  return found;
}

describe('the data of the pricing page', () => {
  it('prices the four plans of the code, in their order, and recommends Pro alone', () => {
    expect(PRICED_PLANS.map((candidate) => candidate.id)).toEqual([...PLAN_IDS]);
    expect(PRICED_PLANS.filter((candidate) => candidate.recommended).map((p) => p.id)).toEqual([
      'pro',
    ]);
  });

  it('leaves the paid plans to the checkout hook, and sends nobody to an email to upgrade', () => {
    expect(plan('free').action).toMatchObject({ kind: 'signup', href: '/signup' });
    expect(plan('pro').action).toMatchObject({ kind: 'upgrade', plan: 'pro' });
    expect(plan('scale').action).toMatchObject({ kind: 'upgrade', plan: 'scale' });
    expect(plan('enterprise').action).toMatchObject({
      kind: 'contact',
      href: 'mailto:hello@bookrail.dev',
    });
    for (const candidate of PRICED_PLANS) {
      if (candidate.id !== 'enterprise') {
        expect(JSON.stringify(candidate.action), candidate.id).not.toContain('mailto:');
      }
    }
  });

  it('takes every enforced limit from PLANS, and publishes only the rows that are true', () => {
    expect(MATRIX.flatMap((section) => section.rows.map((row) => row.key))).toEqual([
      ...MATRIX_ROW_KEYS,
    ]);
    const cell = (key: MatrixRowKey, id: PlanId): string => {
      const row = MATRIX.flatMap((section) => section.rows).find(
        (candidate) => candidate.key === key,
      );
      return row?.cells[id].value ?? '';
    };
    expect(cell('bookings_included', 'free')).toBe(
      `${(PLANS.free.bookingsIncluded ?? 0).toLocaleString('en-US')} / month`,
    );
    expect(cell('payments', 'free')).toBe(
      `Up to €${freeVolumeEur().toLocaleString('en-US')} / month`,
    );
    expect(cell('rate_limit', 'scale')).toBe(`${String(PLANS.scale.rateLimit.rate)} req/s`);
    expect(cell('projects', 'free')).toBe(String(PLANS.free.projects));
    expect(cell('projects', 'pro')).toBe('Unlimited');
  });
});

describe.skipIf(DOCUMENT === null)('the sentence of the fourth principle', () => {
  it('is the sentence the page prints, with the numbers the data gives', () => {
    const line =
      (DOCUMENT ?? '').split('\n').find((candidate) => candidate.startsWith('4. ')) ?? '';
    const english = /«(Free up to [^»]+)»/.exec(line)?.[1];
    expect(english, 'no English sentence in the fourth principle').toBeDefined();
    expect(pricingLede()).toBe(english);
  });
});

describe.skipIf(DOCUMENT === null)('the data against the published table of the document', () => {
  const rows = DOCUMENT === null ? new Map<string, string[]>() : publishedTable(DOCUMENT);
  const row = (key: MatrixRowKey): string[] => {
    const cells = rows.get(DOCUMENT_LABELS[key]);
    if (cells === undefined) throw new Error(`The published table has no row "${key}".`);
    return cells;
  };

  it('has exactly the published rows, and none of the rows that are not true today', () => {
    expect([...rows.keys()]).toEqual(MATRIX_ROW_KEYS.map((key) => DOCUMENT_LABELS[key]));
    for (const label of NOT_PUBLISHED) expect([...rows.keys()], label).not.toContain(label);
  });

  it('agrees on the prices, cell by cell', () => {
    PLAN_IDS.forEach((id, index) => {
      const priced = plan(id);
      const base = row('base_price')[index] ?? '';
      if (priced.price.kind === 'monthly') {
        expect(italianNumber(base), `${id}: base`).toBe(priced.price.eur);
      } else {
        expect(base, id).toMatch(/anno/);
        expect(italianNumber(base), `${id}: base`).toBe(priced.price.fromEurPerYear);
      }

      const extra = row('extra_booking')[index] ?? '';
      if (priced.extraBooking.kind === 'blocked') expect(extra, id).toMatch(/blocco/i);
      else if (priced.extraBooking.kind === 'negotiated') expect(extra, id).toMatch(NEGOTIATED);
      else expect(italianNumber(extra), `${id}: extra`).toBe(priced.extraBooking.eur);

      const payments = row('payments')[index] ?? '';
      if (priced.payments.kind === 'included') {
        expect(payments, id).toMatch(/€\/mese/);
        expect(italianNumber(payments), `${id}: payments`).toBe(freeVolumeEur());
      } else if (priced.payments.kind === 'negotiated') {
        expect(payments, id).toMatch(NEGOTIATED);
      } else {
        expect(payments, id).toMatch(/%/);
        expect(italianNumber(payments), `${id}: payments`).toBe(priced.payments.percent);
      }

      const support = row('support')[index] ?? '';
      if (priced.support.kind === 'community')
        expect(support, id).toBe('Community (GitHub issues)');
      else if (priced.support.kind === 'dedicated') expect(support, id).toBe('Dedicato');
      else {
        expect(support, id).toMatch(/^Email, entro/);
        expect(italianNumber(support), `${id}: support`).toBe(priced.support.businessDays);
      }
    });
  });

  it('agrees with PLANS on the limits, cell by cell', () => {
    PLAN_IDS.forEach((id, index) => {
      const limits = PLANS[id];
      const bookings = row('bookings_included')[index] ?? '';
      expect(NEGOTIATED.test(bookings) ? null : italianNumber(bookings), `${id}: bookings`).toBe(
        limits.bookingsIncluded,
      );
      const projects = row('projects')[index] ?? '';
      expect(UNLIMITED.test(projects) ? null : italianNumber(projects), `${id}: projects`).toBe(
        limits.projects,
      );
      const rate = row('rate_limit')[index] ?? '';
      if (id === 'enterprise') expect(rate, id).toMatch(NEGOTIATED);
      else expect(italianNumber(rate), `${id}: rate`).toBe(limits.rateLimit.rate);
      expect(row('test_environment')[index], id).toBe('Gratis, mai contato');
      expect(row('region')[index], id).toBe(REGION);
    });
    expect(TEST_ENVIRONMENT).toBe('Free, never counted');
  });
});

const PAGE_PATH = join(distRoot, 'pricing', 'index.html');

describe('the built pricing page', () => {
  const html = existsSync(PAGE_PATH) ? readFileSync(PAGE_PATH, 'utf8') : '';

  it('is built', () => {
    expect(existsSync(PAGE_PATH), `${PAGE_PATH} was not built`).toBe(true);
  });

  /** The text of the element that carries a data attribute, tags stripped. */
  function textOf(attribute: string): string[] {
    const found: string[] = [];
    const re = new RegExp(`<([a-z0-9]+)[^>]*${attribute}[^>]*>([\\s\\S]*?)</\\1>`, 'g');
    for (const match of html.matchAll(re)) {
      found.push(
        (match[2] ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    }
    return found;
  }

  it('prints every cell of the matrix as the data says it', () => {
    for (const section of MATRIX) {
      for (const row of section.rows) {
        for (const id of PLAN_IDS) {
          const cell = row.cells[id];
          const printed = textOf(`data-cell="${row.key}:${id}"`);
          expect(printed, `${row.key}:${id}`).toHaveLength(1);
          expect(printed[0], `${row.key}:${id}`).toBe(
            cell.note === undefined ? cell.value : `${cell.value} ${cell.note}`,
          );
        }
      }
    }
  });

  it('sends Pro and Scale to the checkout of the dashboard, and nobody to a mailbox', () => {
    for (const id of ['pro', 'scale'] as const) {
      const hooks = [...html.matchAll(new RegExp(`<a[^>]*data-upgrade-plan="${id}"[^>]*>`, 'g'))];
      // The card and the header of the comparison table.
      expect(hooks.length, id).toBe(2);
      for (const hook of hooks) expect(hook[0], id).toContain(`href="/dashboard/?upgrade=${id}"`);
    }
    expect(html).not.toMatch(/<button[^>]*data-upgrade-plan/);
    const mailtos = [...html.matchAll(/href="mailto:([^"]+)"/g)].map((match) => match[1]);
    for (const address of mailtos) expect(address).toMatch(/^hello@bookrail\.dev/);
    expect(html).not.toMatch(/mailto:[^"]*upgrade/i);
  });

  it('prints the sentence of the fourth principle under the title, read from the data', () => {
    const lede = textOf('data-lede');
    expect(lede).toHaveLength(1);
    expect(lede[0]?.startsWith(pricingLede()), lede[0]).toBe(true);
    // The sentence the founder corrected: the free plan does not go on at a price per booking.
    expect(html).not.toMatch(/Free up to [0-9,]+ [a-z ]*bookings a month, then/);
  });

  /**
   * The complete list of rows the comparison table may have. A row added to the data that is
   * not on this list fails here, whatever it says: the list is the published table of the
   * pricing document, and a new row has to go through the document first.
   */
  const ALLOWED_ROWS = [
    'Base price',
    'Confirmed live bookings included',
    'Each booking past the quota',
    'Orchestrated payments',
    'Projects',
    'Rate limit per live key',
    'Test environment',
    'Region',
    'Support',
  ];

  it('has exactly the rows that may be published, and no other', () => {
    const labels = [...html.matchAll(/<span class="row-label[^"]*"[^>]*>([\s\S]*?)<button/g)].map(
      (match) =>
        (match[1] ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
    );
    expect(labels).toEqual(ALLOWED_ROWS);
    const keys = [...new Set([...html.matchAll(/data-cell="([a-z_]+):/g)].map((m) => m[1]))];
    expect(keys).toEqual([...MATRIX_ROW_KEYS]);
  });

  it('publishes nothing that does not exist today, in the table, the cards or the text', () => {
    const text = html.replace(/<[^>]+>/g, ' ');
    for (const word of [
      'SLA',
      'SOC 2',
      'SSO',
      'SAML',
      'team member',
      'Team member',
      'US region',
      'retention',
      'Retention',
      'SMS',
      'WhatsApp',
      'portal',
      'Portal',
      'notification',
      'Notification',
      'audit log',
      'uptime',
    ]) {
      expect(text, word).not.toContain(word);
    }
  });
});
