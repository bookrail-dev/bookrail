import { Resource, segment } from './base.js';
import type { RequestOptions } from '../core.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type {
  Deleted,
  Policy,
  PolicyCreateParams,
  PolicyListParams,
  PolicyUpdateParams,
} from '../types.js';

/** Booking policies: hold duration, booking window, cancellation, no-show, customer limits. */
export class PoliciesResource extends Resource {
  create(params: PolicyCreateParams, options?: RequestOptions): BookrailPromise<Policy> {
    return this.core.request<Policy>({
      method: 'POST',
      path: '/v1/policies',
      body: params,
      options,
    });
  }

  list(params?: PolicyListParams, options?: RequestOptions): PagePromise<Policy> {
    return paginate<Policy>(this.core, {
      method: 'GET',
      path: '/v1/policies',
      query: params,
      options,
    });
  }

  retrieve(id: string, options?: RequestOptions): BookrailPromise<Policy> {
    return this.core.request<Policy>({
      method: 'GET',
      path: `/v1/policies/${segment(id)}`,
      options,
    });
  }

  update(
    id: string,
    params: PolicyUpdateParams,
    options?: RequestOptions,
  ): BookrailPromise<Policy> {
    return this.core.request<Policy>({
      method: 'PATCH',
      path: `/v1/policies/${segment(id)}`,
      body: params,
      options,
    });
  }

  del(id: string, options?: RequestOptions): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'DELETE',
      path: `/v1/policies/${segment(id)}`,
      options,
    });
  }
}
