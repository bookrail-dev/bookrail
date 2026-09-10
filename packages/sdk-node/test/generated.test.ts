/**
 * The generated types are fresh, the constants agree with the manifest and the specification,
 * and `src/types.ts` describes no data of its own.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GENERATED_PATH, renderGenerated } from '../scripts/render.js';
import { API_VERSION, SDK_VERSION, USER_AGENT } from '../src/version.js';
import { spec } from './operations.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('src/generated/openapi.ts', () => {
  it('is what the generator produces from the current specification', async () => {
    const onDisk = await readFile(GENERATED_PATH, 'utf8');
    const fresh = await renderGenerated();
    expect(
      onDisk === fresh,
      'src/generated/openapi.ts is stale: run `pnpm --filter @bookrail/node generate`.',
    ).toBe(true);
  }, 120_000);

  it('is deterministic', async () => {
    const [first, second] = await Promise.all([renderGenerated(), renderGenerated()]);
    expect(first).toBe(second);
  }, 120_000);

  it('declares an operation for every operationId of the specification', async () => {
    const source = await readFile(GENERATED_PATH, 'utf8');
    for (const methods of Object.values(spec.paths)) {
      for (const operation of Object.values(methods)) {
        // Either quote character: the generator hands its output to Prettier with the
        // repository's own options, and which quote a property key gets is Prettier's business,
        // not something this test should pin down.
        const declared = new RegExp(`['"]${operation.operationId.replace(/\./g, '\\.')}['"]: \\{`);
        expect(declared.test(source), operation.operationId).toBe(true);
      }
    }
  });
});

describe('the constants', () => {
  it('SDK_VERSION is the version of package.json', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(manifest.version);
    expect(USER_AGENT).toBe(`bookrail-node/${manifest.version}`);
  });

  it('API_VERSION is the version the specification declares', () => {
    expect(API_VERSION).toBe(spec.info.version);
  });
});

describe('src/types.ts', () => {
  it('derives every type from the generated document and describes none itself', async () => {
    const source = await readFile(join(packageRoot, 'src', 'types.ts'), 'utf8');
    const declarations = source
      .split('\n')
      .filter((line) => /^export type /.test(line) || /^type /.test(line));
    expect(declarations.length).toBeGreaterThan(50);
    for (const line of declarations) {
      const right = line.slice(line.indexOf('=') + 1).trim();
      const derived =
        right.startsWith('components[') ||
        right.startsWith('operations[') ||
        right.startsWith('BodyOf<') ||
        right.startsWith('QueryOf<') ||
        right.startsWith('PathOf<') ||
        right.startsWith('ResultOf<') ||
        right.startsWith('ItemOf<') ||
        // The five projections themselves, which are conditional types over a type parameter.
        right.startsWith('Op extends') ||
        right.startsWith('L extends') ||
        right.startsWith('200 |');
      expect(derived, `not derived from the specification: ${line}`).toBe(true);
    }
    // Nothing that looks like a hand-written object shape.
    expect(/=\s*\{/.test(source)).toBe(false);
    expect(source.includes('export interface ')).toBe(false);
  });
});
