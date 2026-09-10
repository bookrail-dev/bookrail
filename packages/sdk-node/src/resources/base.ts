/** What every resource namespace shares: the transport, and how to build a path. */
import type { BookrailCore } from '../core.js';

export abstract class Resource {
  /**
   * The transport. Deliberately **not enumerable**: `Object.entries(bookrail.bookings)` should
   * show the nested namespaces a caller can use, not the machinery underneath, and nothing
   * that walks the client (a debugger, a `console.log`, the surface test of this package)
   * should have to know to skip it.
   */
  declare protected readonly core: BookrailCore;

  constructor(core: BookrailCore) {
    Object.defineProperty(this, 'core', { value: core, enumerable: false, writable: false });
  }
}

/** Escapes a path segment. An id with a slash in it must not become two segments. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}
