/**
 * Renders a plain JavaScript value as TypeScript source.
 *
 * `init` and `pull` both write a `bookrail.config.ts`, and both need the file to be readable
 * by a human and diffable by git: `JSON.stringify` would quote every key and produce a file
 * nobody edits by hand. The output follows the repository's Prettier settings (single quotes,
 * trailing commas, two spaces) so that `prettier --check` passes on a generated file.
 */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function renderValue(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);

  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inline = value.every((item) => isScalar(item));
    if (inline) {
      const body = value.map((item) => renderValue(item)).join(', ');
      if (body.length + pad.length <= 90) return `[${body}]`;
    }
    const items = value.map((item) => `${padInner}${renderValue(item, indent + 1)},`);
    return `[\n${items.join('\n')}\n${pad}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== undefined,
  );
  if (entries.length === 0) return '{}';
  const inline = entries.every(([, item]) => isScalar(item));
  if (inline) {
    const body = entries.map(([key, item]) => `${renderKey(key)}: ${renderValue(item)}`).join(', ');
    if (body.length + pad.length <= 88) return `{ ${body} }`;
  }
  const lines = entries.map(
    ([key, item]) => `${padInner}${renderKey(key)}: ${renderValue(item, indent + 1)},`,
  );
  return `{\n${lines.join('\n')}\n${pad}}`;
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function renderKey(key: string): string {
  return BARE_KEY.test(key) ? key : quote(key);
}

function quote(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  return `'${escaped}'`;
}

export interface ConfigFileOptions {
  /** Lines placed above the export, each already a full comment line. */
  header?: string[];
}

export function renderConfigFile(config: unknown, options: ConfigFileOptions = {}): string {
  const header = (options.header ?? [])
    .map((line) => (line === '' ? '//' : `// ${line}`))
    .join('\n');
  return [
    "import { defineConfig } from 'bookrail';",
    '',
    ...(header === '' ? [] : [header, '']),
    `export default defineConfig(${renderValue(config, 0)});`,
    '',
  ].join('\n');
}
