/**
 * The exact bytes of `src/generated/openapi.ts`, produced without writing them.
 *
 * A module of its own, with no side effects, for a reason discovered the hard
 * way: if the generator ran at import time, the freshness test would regenerate the file
 * before comparing it with itself and could never fail.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { format, resolveConfig } from 'prettier';

const here = dirname(fileURLToPath(import.meta.url));

/** The specification this package is generated from: the one `@bookrail/api` renders. */
export const SPEC_PATH = join(here, '..', '..', 'api', 'openapi', 'openapi.json');

/** Where the generated types are versioned. */
export const GENERATED_PATH = join(here, '..', 'src', 'generated', 'openapi.ts');

const BANNER = `/**
 * Generated from \`packages/api/openapi/openapi.json\` by \`pnpm --filter @bookrail/node generate\`.
 *
 * Do not edit by hand: \`test/generated.test.ts\` fails when this file and the specification
 * disagree. Every public type of this package is derived from what is below (\`src/types.ts\`),
 * so a change to a Zod schema of the server reaches the SDK by regeneration, never by hand.
 */
`;

export async function renderGenerated(): Promise<string> {
  const ast = await openapiTS(pathToFileURL(SPEC_PATH), {
    // Literal unions, never a TypeScript `enum`: an `enum` is a runtime value, and this file
    // must erase to nothing.
    enum: false,
    // `format: date-time` stays `string`. The wire carries ISO 8601 text and so does the SDK:
    // a `Date` here would be a lie about what `JSON.parse` returned.
    defaultNonNullable: false,
    // `{}` in a schema means "any object", not "an object with no properties".
    emptyObjectsUnknown: true,
    excludeDeprecated: false,
  });
  const source = `${BANNER}${astToString(ast)}`;
  // The repository's own Prettier options, resolved from `.prettierrc.json`, and not the
  // defaults: the generated file is checked by `pnpm format:check` like every other file, so
  // it has to come out of the generator already in the house style.
  const options = (await resolveConfig(GENERATED_PATH)) ?? {};
  return format(source, { ...options, parser: 'typescript' });
}
