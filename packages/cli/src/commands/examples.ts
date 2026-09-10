import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { renderTable, type CommandResult } from '../output.js';
import { renderConfigFile } from '../render.js';
import { TEMPLATES, TEMPLATE_NAMES } from '../templates/index.js';

const TYPESCRIPT_FRAMEWORKS = new Set(['nextjs', 'nuxt', 'sveltekit', 'expo', 'ts', 'node']);

/**
 * A complete, runnable model of one vertical: the configuration plus the calls that follow it.
 *
 * An agent should not have to guess the order of operations. The example is therefore the whole
 * loop (describe, push, ask for availability, hold, book, read back) with the id of the service
 * the template actually declares.
 */
export function examples(
  ctx: Context,
  vertical: string | undefined,
  options: { framework?: string },
): CommandResult {
  if (vertical === undefined) {
    return {
      data: {
        verticals: TEMPLATE_NAMES.map((name) => ({
          name,
          summary: TEMPLATES[name]?.summary,
          vertical: TEMPLATES[name]?.vertical,
        })),
      },
      human: [
        `${ctx.presenter.badge()} examples available`,
        '',
        renderTable(
          ['vertical', 'what it models'],
          TEMPLATE_NAMES.map((name) => [name, TEMPLATES[name]?.summary ?? '']),
        ),
        '',
        'Run `bookrail examples <vertical>` for the full model and the calls.',
      ].join('\n'),
      nextSteps: ['Run `bookrail examples padel` for a complete example.'],
    };
  }

  const template = TEMPLATES[vertical];
  if (!template) {
    throw new CliError('unknown_template', `No example for "${vertical}".`, {
      fix: `Choose one of: ${TEMPLATE_NAMES.join(', ')}.`,
    });
  }

  const serviceId = firstServiceId(template.config);
  const useTypeScript = TYPESCRIPT_FRAMEWORKS.has((options.framework ?? '').toLowerCase());
  const calls = useTypeScript ? typescriptCalls(serviceId) : curlCalls(serviceId);
  const config = renderConfigFile(template.config, {
    header: [`Template: ${template.name} (${template.vertical}).`, ...template.notes],
  });

  return {
    data: {
      vertical: template.name,
      summary: template.summary,
      source_vertical: template.vertical,
      notes: template.notes,
      config_file: config,
      config: template.config,
      service_id_placeholder: serviceId,
      calls,
    },
    human: [
      `# ${template.name}: ${template.summary}`,
      `# Vertical: ${template.vertical}`,
      '',
      '## bookrail.config.ts',
      '',
      config,
      '## Then',
      '',
      calls,
    ].join('\n'),
    nextSteps: [
      `Run \`bookrail init --template ${template.name}\` to write this config.`,
      'Run `bookrail push --dry-run`, then `bookrail push`.',
    ],
  };
}

function firstServiceId(config: { services?: unknown }): string {
  const services = config.services;
  if (Array.isArray(services) && services.length > 0) {
    const first = services[0] as { id?: string };
    if (typeof first.id === 'string') return first.id;
  }
  if (services && typeof services === 'object') {
    const keys = Object.keys(services as Record<string, unknown>);
    if (keys[0] !== undefined) return keys[0];
  }
  return 'my_service';
}

function curlCalls(serviceId: string): string {
  return [
    '```bash',
    '# 1. Describe the model and apply it.',
    'bookrail push --dry-run',
    'bookrail push',
    '',
    '# 2. Read the id the API gave the service.',
    `bookrail services list --json   # look for metadata.config_id == "${serviceId}"`,
    '',
    '# 3. Ask for availability (or use `bookrail availability`).',
    'curl -X POST "$BOOKRAIL_API_URL/v1/availability" \\',
    '  -H "authorization: Bearer $BOOKRAIL_SECRET_KEY" \\',
    '  -H "bookrail-version: 2026-09-01" \\',
    '  -H "content-type: application/json" \\',
    '  -d \'{"service_id":"svc_...","from":"2026-09-08T00:00:00+02:00","to":"2026-09-15T00:00:00+02:00"}\'',
    '',
    '# 4. Hold a slot for ten minutes, then turn it into a booking.',
    'curl -X POST "$BOOKRAIL_API_URL/v1/holds" \\',
    '  -H "authorization: Bearer $BOOKRAIL_SECRET_KEY" \\',
    '  -H "content-type: application/json" \\',
    '  -d \'{"service_id":"svc_...","start":"2026-09-08T07:00:00Z","ttl":"10m"}\'',
    '',
    'curl -X POST "$BOOKRAIL_API_URL/v1/bookings" \\',
    '  -H "authorization: Bearer $BOOKRAIL_SECRET_KEY" \\',
    '  -H "content-type: application/json" \\',
    '  -H "idempotency-key: order-4711" \\',
    '  -d \'{"service_id":"svc_...","start":"2026-09-08T07:00:00Z","hold_id":"hold_...",',
    '       "customer":{"email":"ada@example.com","name":"Ada"}}\'',
    '```',
  ].join('\n');
}

function typescriptCalls(serviceId: string): string {
  return [
    '```ts',
    "import { bookrail } from './bookrail';",
    '',
    `// The service declared as "${serviceId}" in bookrail.config.ts; read its svc_ id once`,
    '// with `bookrail services list --json` and keep it in an environment variable.',
    'const serviceId = process.env.BOOKRAIL_SERVICE_ID!;',
    '',
    "const availability = await bookrail<{ slots: { start: string }[] }>('/v1/availability', {",
    "  method: 'POST',",
    '  body: {',
    '    service_id: serviceId,',
    "    from: '2026-09-08T00:00:00+02:00',",
    "    to: '2026-09-15T00:00:00+02:00',",
    '  },',
    '});',
    '',
    'const slot = availability.slots[0];',
    '',
    "const hold = await bookrail<{ id: string }>('/v1/holds', {",
    "  method: 'POST',",
    "  body: { service_id: serviceId, start: slot.start, ttl: '10m' },",
    '});',
    '',
    "const booking = await bookrail('/v1/bookings', {",
    "  method: 'POST',",
    '  idempotencyKey: orderId,',
    '  body: {',
    '    service_id: serviceId,',
    '    start: slot.start,',
    '    hold_id: hold.id,',
    "    customer: { email: 'ada@example.com', name: 'Ada' },",
    '  },',
    '});',
    '```',
  ].join('\n');
}
