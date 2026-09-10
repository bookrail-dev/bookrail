import { Resource, segment } from './base.js';
import type { RequestOptions } from '../core.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type { Event, EventListParams } from '../types.js';

/** The log of everything that happened. Read only, and read only in the database too. */
export class EventsResource extends Resource {
  /**
   * The event log, on the `(txid, seq)` cursor.
   *
   * `type` is repeatable: `{ type: ['booking.created', 'booking.cancelled'] }` is the union of
   * the two, and goes on the wire as `?type[]=…&type[]=…`. An array value always becomes a
   * repeated `name[]` parameter, which is the only form the API accepts.
   */
  list(params?: EventListParams, options?: RequestOptions): PagePromise<Event> {
    return paginate<Event>(this.core, {
      method: 'GET',
      path: '/v1/events',
      query: params,
      options,
    });
  }

  retrieve(id: string, options?: RequestOptions): BookrailPromise<Event> {
    return this.core.request<Event>({ method: 'GET', path: `/v1/events/${segment(id)}`, options });
  }
}
