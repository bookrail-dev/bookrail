/**
 * `pnpm --filter @bookrail/api openapi`: writes `openapi/openapi.json`.
 *
 * The file is generated, versioned in the repository, and proved fresh by `openapi.test.ts`: a
 * change to a schema that is not followed by a run of this script fails the suite with the
 * command to run.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OPENAPI_PATH, renderOpenApiFile } from './render.js';

const rendered = await renderOpenApiFile();
const before = read(OPENAPI_PATH);
mkdirSync(dirname(OPENAPI_PATH), { recursive: true });
writeFileSync(OPENAPI_PATH, rendered, 'utf8');

const document = JSON.parse(rendered) as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
};
const operations = Object.values(document.paths).reduce(
  (total, path) => total + Object.keys(path).length,
  0,
);
console.error(
  `${before === rendered ? 'unchanged' : 'written'}: ${OPENAPI_PATH} (` +
    `${String(Object.keys(document.paths).length)} paths, ${String(operations)} operations, ` +
    `${String(Object.keys(document.components.schemas).length)} schemas)`,
);

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
