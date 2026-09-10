import { Resource, segment } from './base.js';
import type { RequestOptions } from '../core.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type {
  Customer,
  CustomerCreateParams,
  CustomerListParams,
  CustomerUpdateParams,
  Deleted,
} from '../types.js';

/** The people a booking is for, keyed on your own `external_id` when you have one. */
export class CustomersResource extends Resource {
  /**
   * Creates a customer, or updates the one that already carries the same `external_id`.
   *
   * The API answers `201` for a creation and `200` for that upsert; both give a `Customer`, and
   * `.withResponse()` is where the difference is visible.
   */
  create(params: CustomerCreateParams, options?: RequestOptions): BookrailPromise<Customer> {
    return this.core.request<Customer>({
      method: 'POST',
      path: '/v1/customers',
      body: params,
      options,
    });
  }

  list(params?: CustomerListParams, options?: RequestOptions): PagePromise<Customer> {
    return paginate<Customer>(this.core, {
      method: 'GET',
      path: '/v1/customers',
      query: params,
      options,
    });
  }

  retrieve(id: string, options?: RequestOptions): BookrailPromise<Customer> {
    return this.core.request<Customer>({
      method: 'GET',
      path: `/v1/customers/${segment(id)}`,
      options,
    });
  }

  update(
    id: string,
    params: CustomerUpdateParams,
    options?: RequestOptions,
  ): BookrailPromise<Customer> {
    return this.core.request<Customer>({
      method: 'PATCH',
      path: `/v1/customers/${segment(id)}`,
      body: params,
      options,
    });
  }

  del(id: string, options?: RequestOptions): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'DELETE',
      path: `/v1/customers/${segment(id)}`,
      options,
    });
  }
}
