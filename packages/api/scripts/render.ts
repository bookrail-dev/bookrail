/**
 * The exact bytes `openapi/openapi.json` must contain.
 *
 * Separate from `openapi.ts`, which runs on import, so that the freshness test can render the
 * document **without** rewriting the file it is about to compare against. The first version of
 * this had them in one module, and importing it from the test regenerated the file first, so the
 * staleness check could never fail: the check checked itself.
 *
 * It lives under `scripts/` rather than under `src/` because it imports Prettier, which is a
 * development tool: nothing in the built server may depend on it.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { buildOpenApiDocument } from '../src/openapi/generate.js';

const here = resolve(fileURLToPath(import.meta.url), '..');

export const OPENAPI_PATH = resolve(here, '..', 'openapi', 'openapi.json');

/** The document, formatted with the repository's own Prettier configuration. */
export async function renderOpenApiFile(): Promise<string> {
  const document = buildOpenApiDocument();
  const options = (await prettier.resolveConfig(OPENAPI_PATH)) ?? {};
  return prettier.format(JSON.stringify(document, null, 2), { ...options, parser: 'json' });
}
