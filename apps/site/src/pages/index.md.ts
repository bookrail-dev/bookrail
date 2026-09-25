/**
 * The markdown twin of the homepage, for agents: the same sections in text, built from the same
 * data as the page (`src/data/home.ts`), so the two cannot say different things.
 */
import type { APIRoute } from 'astro';
import {
  ATTEMPTS,
  BOOKING_CODES,
  DIFF,
  EXPLAIN,
  LADDER,
  MCP_TOOL_COUNT,
  OPEN_SOURCE,
  SAMPLES,
  STRIPE,
  TEMPLATES,
  TEST_ENVIRONMENT_NOTE,
  explainSummary,
  priceStrip,
} from '../data/home';
import { DESCRIPTION, GITHUB_DISCUSSIONS, GITHUB_REPO, HEADLINE, TAGLINE } from '../data/site';

export function homeMarkdown(): string {
  const lines: string[] = [
    '# Bookrail',
    '',
    `**${HEADLINE.join(' ')}**`,
    '',
    `${TAGLINE} ${DESCRIPTION}`,
    '',
    '- [Get API keys](/signup): a test key and a live key, by email, on the Free plan.',
    '- [Read the docs](/docs/): the quickstart, the concepts, the API, the CLI and the MCP server.',
    '',
    '## What it does today',
    '',
    `- **Availability** ([concepts](/docs/concepts/)): slots or continuous ranges, computed across schedules, exceptions, blocks and bookings, with time zones and DST handled. \`explain\` names the booking, hold or block behind every instant it refuses.`,
    `- **Bookings without double booking** ([edge cases](/docs/edge-cases/)): hold a slot for a few minutes, then book it, or book it directly. Capacity is enforced by Postgres, so two requests for the last unit get one ${String(BOOKING_CODES.created)} and one ${String(BOOKING_CODES.conflict)}.`,
    `- **Policies and lifecycle** ([policies](/docs/guides/policies/)): confirm, check in, complete, cancel, no-show and reschedule through one transition matrix. A paid booking that is cancelled is refunded by the policy frozen into it at the sale.`,
    `- **Payments on your own Stripe** ([Stripe](/docs/guides/stripe/)): a deposit or the full price, charged on your own Stripe account through Stripe Connect. \`${STRIPE.command}\`: ${STRIPE.summary}`,
    `- **Webhooks and events** ([webhooks](/docs/guides/webhooks/)): every change is an event in an ordered log. Deliveries are signed with HMAC and retried after ${LADDER.join(', ')}: ${String(ATTEMPTS)} attempts in all.`,
    `- **CLI and config as code** ([configuration](/docs/configuration/)): \`bookrail.config.ts\`, with \`push\`, \`pull\` and \`diff\`. \`${DIFF.command}\` after two edits of the padel template: ${DIFF.summary.replace(/^\[\w+\]\s*/, '')}.`,
    `- **MCP server** ([MCP](/docs/mcp/)): ${String(MCP_TOOL_COUNT)} tools for a coding agent. Test by default; irreversible tools answer with a preview until they are confirmed.`,
    `- **Open source** ([open source](/docs/open-source/)): ${OPEN_SOURCE.license}, ${OPEN_SOURCE.repository}.`,
    '',
    '## Why a slot is not available',
    '',
    `What the availability engine answered, at build time, about the synthetic day of the homepage grid: a match of 60 minutes on any of three courts. ${String(EXPLAIN.slots)} slots, ${String(EXPLAIN.instants)} instants refused (${explainSummary()}).`,
    '',
    '| Instant | Code | Resource | Why |',
    '| --- | --- | --- | --- |',
    ...EXPLAIN.rows.map(
      (row) => `| ${row.local} | \`${row.code}\` | ${row.resource} | ${row.message} |`,
    ),
    '',
    '## Code',
    '',
    'The same calls as the [quickstart](/docs/quickstart/).',
    '',
  ];
  for (const sample of SAMPLES) {
    lines.push(
      `### ${sample.label}`,
      '',
      `\`\`\`${sample.lang === 'json' ? '' : sample.lang}`,
      sample.code,
      '```',
      '',
      `[Read the docs for ${sample.name}](${sample.docs})`,
      '',
    );
  }
  lines.push(
    '## Templates',
    '',
    '`npx bookrail init --template <name>` writes a `bookrail.config.ts` for a vertical.',
    '',
    ...TEMPLATES.map((template) => `- \`${template.name}\`: ${template.summary}`),
    '',
    '## For coding agents',
    '',
    `A CLI with \`--json\` everywhere, an MCP server with ${String(MCP_TOOL_COUNT)} tools, every documentation page as markdown at the same URL with \`.md\` on the end, and an OpenAPI document at [/openapi.json](/openapi.json). See [For AI agents](/docs/for-ai-agents/).`,
    '',
    '## Pricing',
    '',
    'Free until it counts. Pay as you grow.',
    '',
    ...priceStrip().map((price) => `- ${price.figure}: ${price.label}.`),
    `- The test environment: ${TEST_ENVIRONMENT_NOTE.toLowerCase()}. Prices exclude VAT.`,
    '',
    'The whole table is on [/pricing](/pricing.md).',
    '',
    '## Community',
    '',
    `Questions and proposals on [GitHub Discussions](${GITHUB_DISCUSSIONS}). The repository is [${OPEN_SOURCE.repository}](${GITHUB_REPO}).`,
    '',
  );
  return lines.join('\n');
}

export const GET: APIRoute = () =>
  new Response(homeMarkdown(), { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
