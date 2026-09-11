/** Every operation of the registry has a method, and every method is on an operation. */
import { describe, expect, it } from 'vitest';
import Bookrail from '../src/index.js';
import { resolveMethod, sdkPath } from './methods.js';
import { OPERATIONS } from './operations.js';

const bookrail = new Bookrail('sk_test_0123456789abcdef');

describe('the surface of the client', () => {
  /**
   * Every operation the specification offers this package, which is all of them but the three
   * sign up ones: they are marked `x-bookrail-sdk: false` because a client is constructed with
   * a key and those three are how a key comes into being, so `test/operations.ts` filters them
   * out. The number below is therefore still what it was before they existed.
   */
  it('covers all 67 operations the specification offers this package', () => {
    expect(OPERATIONS).toHaveLength(67);
    const missing: string[] = [];
    for (const operation of OPERATIONS) {
      const path = sdkPath(operation.operationId);
      if (typeof resolveMethod(bookrail, path) !== 'function') {
        missing.push(`${operation.operationId} → bookrail.${path.join('.')}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('names the namespaces in camelCase and keeps the verbs of the registry', () => {
    expect(sdkPath('resource_groups.list')).toEqual(['resourceGroups', 'list']);
    expect(sdkPath('resources.blocks.list')).toEqual(['resources', 'blocks', 'list']);
    expect(sdkPath('schedules.exceptions.delete')).toEqual(['schedules', 'exceptions', 'del']);
    expect(sdkPath('webhooks.deliveries.retry')).toEqual(['webhooks', 'deliveries', 'retry']);
    expect(sdkPath('bookings.check_in')).toEqual(['bookings', 'checkIn']);
    expect(sdkPath('availability.search')).toEqual(['availability', 'list']);
  });

  it('has no HTTP method beyond the registry, apart from constructEvent', () => {
    const declared = new Set(
      OPERATIONS.map((operation) => sdkPath(operation.operationId).join('.')),
    );
    // Everything that is not an operation of the API, and why it is here.
    const allowed = new Set(['webhooks.constructEvent']);
    const extra: string[] = [];
    const methodsOf = (instance: object, prefix: string[]): void => {
      const proto = Object.getPrototypeOf(instance) as object;
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor') continue;
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (typeof descriptor?.value !== 'function') continue;
        const path = [...prefix, key].join('.');
        if (!declared.has(path) && !allowed.has(path)) extra.push(path);
      }
      for (const [key, value] of Object.entries(instance)) {
        if (typeof value === 'object' && value !== null) methodsOf(value, [...prefix, key]);
      }
    };
    for (const [key, value] of Object.entries(bookrail)) {
      if (typeof value === 'object' && value !== null) methodsOf(value, [key]);
    }
    // `transition` is the private helper the six booking actions share.
    expect(extra.filter((path) => path !== 'bookings.transition')).toEqual([]);
  });
});
