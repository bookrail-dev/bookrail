/**
 * The one rule that turns an `operationId` into the name of an SDK method.
 *
 * The identifiers are a **path** (`resources.blocks.list`, not `listResourceBlocks`) precisely
 * so that this could be mechanical instead of a convention someone has to remember. Namespaces
 * become `camelCase` because they are ours; the data keeps the API's own `snake_case` because
 * it is the API's.
 */

/** `get` is `retrieve`, `delete` is `del`, and `availability.search` reads as a list. */
const VERBS: Record<string, string> = {
  get: 'retrieve',
  delete: 'del',
  no_show: 'noShow',
  check_in: 'checkIn',
  search: 'list',
};

function camel(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** `bookings.no_show` → `['bookings', 'noShow']`, `openapi.get` → `['openapi', 'retrieve']`. */
export function sdkPath(operationId: string): string[] {
  const parts = operationId.split('.');
  const verb = parts[parts.length - 1] as string;
  const namespaces = parts.slice(0, -1).map(camel);
  return [...namespaces, VERBS[verb] ?? camel(verb)];
}

export function resolveMethod(root: object, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const step of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[step];
  }
  return current;
}
