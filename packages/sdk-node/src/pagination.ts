/**
 * Cursor pagination, in the two shapes a caller wants it.
 *
 * ```ts
 * const page = await bookrail.bookings.list({ limit: 10 });   // one page
 * for await (const b of bookrail.bookings.list({ limit: 10 })) // every page
 * ```
 *
 * The API paginates by cursor and never by offset: the cursor is the `id` of the last element
 * of a page, and a list carries `has_more` but no total. `limit` is per page, not a total:
 * iterating a list of 25 with `limit: 10` makes exactly three requests and yields twenty-five
 * objects.
 */
import type { CallSpec, BookrailCore } from './core.js';
import { BookrailError } from './errors.js';
import { BookrailPromise, type ResponseInfo, type WithResponse } from './response.js';

/** The envelope every list endpoint answers with. */
export interface ListEnvelope<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

function cursorOf<T>(items: readonly T[]): string {
  const last = items[items.length - 1];
  const id = (last as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string') {
    throw new BookrailError(
      'internal',
      'A list page cannot be advanced: its last element has no string `id` to use as a cursor.',
      { code: 'unexpected_response' },
    );
  }
  return id;
}

/** One page of a cursored list, and the way to the next. */
export class Page<T> implements AsyncIterable<T> {
  /** The objects of this page, in the order the API returned them. */
  readonly data: readonly T[];
  /** Whether the API has more beyond this page. */
  readonly has_more: boolean;
  /** The HTTP exchange that produced this page. */
  readonly response: ResponseInfo;

  readonly #next: (cursor: string) => PagePromise<T>;

  constructor(
    envelope: ListEnvelope<T>,
    response: ResponseInfo,
    next: (cursor: string) => PagePromise<T>,
  ) {
    this.data = envelope.data;
    this.has_more = envelope.has_more;
    this.response = response;
    this.#next = next;
  }

  /** `true` when {@link nextPage} will return something. */
  hasNextPage(): boolean {
    return this.has_more && this.data.length > 0;
  }

  /**
   * The page after this one.
   *
   * Rejects when there is none: `has_more` already told the caller, and returning an empty page
   * would make "no more results" and "a page that happens to be empty" the same value.
   */
  nextPage(): PagePromise<T> {
    if (!this.hasNextPage()) {
      return new PagePromise<T>(
        Promise.reject(
          new BookrailError('internal', 'This is the last page: has_more is false.', {
            code: 'no_more_pages',
          }),
        ),
      );
    }
    let cursor: string;
    try {
      cursor = cursorOf(this.data);
    } catch (error) {
      // A rejected promise, never a synchronous throw: `nextPage()` is awaited, and a caller
      // who writes `page.nextPage().catch(…)` must be able to catch every failure of it.
      return new PagePromise<T>(Promise.reject(error));
    }
    return this.#next(cursor);
  }

  /** Every object of this page and of the pages after it. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return walk(this);
  }
}

/** Yields the objects of a page and of every page after it. */
async function* walk<T>(first: Page<T>): AsyncGenerator<T> {
  let page = first;
  for (;;) {
    for (const item of page.data) yield item;
    if (!page.hasNextPage()) return;
    page = await page.nextPage();
  }
}

/** A `Promise<Page<T>>` that is also an `AsyncIterable<T>` over every page. */
export class PagePromise<T> extends BookrailPromise<Page<T>> implements AsyncIterable<T> {
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    const page = await this;
    yield* page;
  }

  override get [Symbol.toStringTag](): string {
    return 'PagePromise';
  }
}

/**
 * Runs a list call and wraps the answer in a {@link Page}.
 *
 * The follow-up request is the same call with `starting_after` replaced, so filters, `expand[]`
 * and `limit` carry across pages without the caller repeating them.
 */
export function paginate<T>(core: BookrailCore, spec: CallSpec): PagePromise<T> {
  const run = (cursor: string | undefined): Promise<WithResponse<Page<T>>> => {
    const query: Record<string, unknown> = { ...(spec.query ?? {}) };
    if (cursor !== undefined) query['starting_after'] = cursor;
    return core.perform<ListEnvelope<T>>({ ...spec, query }).then((envelope) => {
      const body = envelope.data;
      if (
        typeof body !== 'object' ||
        body === null ||
        !Array.isArray((body as { data?: unknown }).data)
      ) {
        throw new BookrailError(
          'internal',
          `${spec.method} ${spec.path} did not answer with a list envelope.`,
          { code: 'unexpected_response', status: envelope.response.status },
        );
      }
      const page = new Page<T>(body, envelope.response, (next) => new PagePromise<T>(run(next)));
      return { data: page, response: envelope.response };
    });
  };
  return new PagePromise<T>(run(undefined));
}
