/**
 * The markdown twin of `/pricing`, for agents and for «Copy as Markdown».
 *
 * Built from the same data as the page, so the two cannot say different things: the prices from
 * `src/data/pricing.ts`, the limits from `PLANS` through it.
 */
import type { APIRoute } from 'astro';
import { PLANS } from '@bookrail/shared';
import {
  MATRIX,
  PRICED_PLANS,
  cardFeatures,
  pricingLede,
  cardPrice,
  euro,
  freeLimitSentence,
  freeVolumeEur,
  thousands,
} from '../data/pricing';

function cell(value: string, note?: string): string {
  return note === undefined ? value : `${value} (${note})`;
}

export function pricingMarkdown(): string {
  const free = PLANS.free.bookingsIncluded ?? 0;
  const lines: string[] = [
    '# Pricing',
    '',
    `Free until it counts. ${pricingLede()} You pay for bookings that happen, not for seats, resources or locations.`,
    '',
    '## Plans',
    '',
  ];
  for (const plan of PRICED_PLANS) {
    const price = cardPrice(plan);
    lines.push(
      `### ${plan.name}${plan.recommended ? ' (recommended)' : ''}`,
      '',
      plan.description,
      '',
      `Price: ${price.amount}${price.per === undefined ? '' : ` ${price.per}`}${price.note === undefined ? '' : `, ${price.note}`}.`,
      '',
      ...cardFeatures(plan).map((feature) => `- ${cell(feature.text, feature.note)}`),
      '',
    );
    if (plan.id === 'free') lines.push(freeLimitSentence(), '');
  }
  lines.push('## Compare plans', '');
  lines.push(`| | ${PRICED_PLANS.map((plan) => plan.name).join(' | ')} |`);
  lines.push(`|---|${PRICED_PLANS.map(() => '---').join('|')}|`);
  for (const section of MATRIX) {
    for (const row of section.rows) {
      const cells = PRICED_PLANS.map((plan) => {
        const value = row.cells[plan.id];
        return cell(value.value, value.note);
      });
      lines.push(`| ${row.label} | ${cells.join(' | ')} |`);
    }
  }
  lines.push(
    '',
    '## Definitions',
    '',
    `- **A booking** is a live booking that reaches \`confirmed\` in a calendar month, in UTC, counted once. Cancellations, holds, no-shows and reschedules do not count again. Bookings in the test environment never count.`,
    `- **The limit of Free:** once the confirmed live bookings of the month, together with the live bookings still \`pending\`, reach ${thousands(free)}, a new live booking is refused with \`402 plan_limit_reached\` until the next month in UTC or a paying plan. Payments that would take the month past ${euro(freeVolumeEur())} are refused the same way.`,
    '- **Orchestrated payments** are the price of the service, not a fee on the money: payments are charged on your own Stripe account and the money goes there.',
    '- **Warnings** at 80% and at 100% of the included bookings: an email to the owner address, once per month and threshold, and a `plan.usage_warning` event.',
    '- **Usage** is in the dashboard (https://bookrail.dev/dashboard/), in `GET /v1/project`, with `bookrail whoami`, and in the `Bookrail-Plan-Usage` header of every response to a live key.',
    '- **Billing:** prices are in euro, VAT excluded, and the paid plans are for businesses (the checkout asks for a billing address and, where Stripe supports one, a VAT number or tax id). Italian companies pay Italian VAT, companies elsewhere in the EU are invoiced under the reverse charge, and outside the EU no VAT is added. Every plan renews on the first day of the month, in UTC, the first month pro rata; bookings past the quota and orchestrated payments go on the invoice of the first of the next month. Moving up applies at once, pro rata; moving down or cancelling applies from the first of the next month, with no partial refund. A failed payment keeps the plan for fourteen days, then the account goes back to Free, with nothing deleted. Terms: https://bookrail.dev/terms and https://bookrail.dev/dpa.',
    '- **Upgrading** to Pro or Scale: https://bookrail.dev/dashboard/?upgrade=pro or https://bookrail.dev/dashboard/?upgrade=scale, which opens the checkout after sign in. Enterprise: hello@bookrail.dev.',
    '',
  );
  return lines.join('\n');
}

export const GET: APIRoute = () =>
  new Response(pricingMarkdown(), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
