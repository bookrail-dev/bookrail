/**
 * The operation registry, read from the specification, and the way back from a request to
 * the operation that served it.
 *
 * Coverage is measured on the **server** side (on `METHOD path` as the API saw it) and not by
 * asking the SDK what it thinks it called. A method that builds the wrong path would otherwise
 * report itself as covering the operation it meant to call.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

interface Spec {
  info: { version: string };
  paths: Record<string, Record<string, { operationId: string }>>;
}

export const SPEC_PATH = join(here, '..', '..', 'api', 'openapi', 'openapi.json');

export const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as Spec;

export interface Operation {
  operationId: string;
  method: string;
  template: string;
  match: RegExp;
}

export const OPERATIONS: readonly Operation[] = Object.entries(spec.paths).flatMap(
  ([template, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      operationId: operation.operationId,
      method: method.toUpperCase(),
      template,
      match: new RegExp(
        `^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`,
      ),
    })),
);

/** The operation a `METHOD path` belongs to, or `null` when it is not in the registry. */
export function operationFor(method: string, path: string): string | null {
  for (const operation of OPERATIONS) {
    if (operation.method === method.toUpperCase() && operation.match.test(path)) {
      return operation.operationId;
    }
  }
  return null;
}
