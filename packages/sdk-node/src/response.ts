/**
 * What a call returns, and how to get at the envelope around it.
 *
 * Every method returns the object (`bookings.create(...)` is a `Promise<Booking>`, not a
 * `Promise<{data: Booking}>`) because the object is what the caller wanted. The transport
 * facts (status, headers, `Bookrail-Request-Id`, `Idempotent-Replayed`) are one call away,
 * with `.withResponse()`, and nowhere in the way of the ninety-nine per cent of code that
 * does not need them.
 *
 * The obvious alternative, a mutable `bookrail.lastResponse`, was not taken: it is
 * a race as soon as two calls are in flight, which is the normal state of a server.
 */

/** The transport facts of one HTTP exchange. */
export interface ResponseInfo {
  readonly status: number;
  /** Every response header, names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  /** `Bookrail-Request-Id`. Quote it to support. */
  readonly requestId: string | undefined;
  /**
   * `true` when the API replayed a stored answer for this `Idempotency-Key`: the same key
   * within 24 hours gives the first response back, with no second effect. On a POST that the
   * SDK retried, this is how a caller tells "we booked" from "we booked, twice, and you are
   * seeing the first one".
   */
  readonly idempotentReplayed: boolean;
  /** How many extra attempts the SDK made before this response. `0` when the first worked. */
  readonly retries: number;
}

export interface WithResponse<T> {
  readonly data: T;
  readonly response: ResponseInfo;
}

/**
 * A `Promise<T>` that can also hand over the envelope.
 *
 * ```ts
 * const booking = await bookrail.bookings.create(params);
 * const { data, response } = await bookrail.bookings.create(params).withResponse();
 * ```
 */
export class BookrailPromise<T> implements Promise<T> {
  readonly #inner: Promise<WithResponse<T>>;

  constructor(inner: Promise<WithResponse<T>>) {
    this.#inner = inner;
  }

  /** The object **and** the HTTP exchange that produced it. */
  withResponse(): Promise<WithResponse<T>> {
    return this.#inner;
  }

  protected get envelope(): Promise<WithResponse<T>> {
    return this.#inner;
  }

  then<A = T, B = never>(
    onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.#inner.then((envelope) => envelope.data).then(onFulfilled, onRejected);
  }

  catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.then(undefined, onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.then().finally(onFinally);
  }

  get [Symbol.toStringTag](): string {
    return 'BookrailPromise';
  }
}
