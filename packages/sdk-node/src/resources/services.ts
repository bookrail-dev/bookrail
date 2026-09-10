import { Resource, segment } from './base.js';
import type { RequestOptions } from '../core.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type {
  Deleted,
  Service,
  ServiceCreateParams,
  ServiceListParams,
  ServiceUpdateParams,
} from '../types.js';

/** What can be booked: its durations, the resources it requires, its policy and its prices. */
export class ServicesResource extends Resource {
  create(params: ServiceCreateParams, options?: RequestOptions): BookrailPromise<Service> {
    return this.core.request<Service>({
      method: 'POST',
      path: '/v1/services',
      body: params,
      options,
    });
  }

  list(params?: ServiceListParams, options?: RequestOptions): PagePromise<Service> {
    return paginate<Service>(this.core, {
      method: 'GET',
      path: '/v1/services',
      query: params,
      options,
    });
  }

  retrieve(id: string, options?: RequestOptions): BookrailPromise<Service> {
    return this.core.request<Service>({
      method: 'GET',
      path: `/v1/services/${segment(id)}`,
      options,
    });
  }

  update(
    id: string,
    params: ServiceUpdateParams,
    options?: RequestOptions,
  ): BookrailPromise<Service> {
    return this.core.request<Service>({
      method: 'PATCH',
      path: `/v1/services/${segment(id)}`,
      body: params,
      options,
    });
  }

  del(id: string, options?: RequestOptions): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'DELETE',
      path: `/v1/services/${segment(id)}`,
      options,
    });
  }
}
