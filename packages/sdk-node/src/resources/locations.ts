import { Resource, segment } from './base.js';
import type { RequestOptions } from '../core.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type {
  Deleted,
  Location,
  LocationCreateParams,
  LocationListParams,
  LocationUpdateParams,
} from '../types.js';

/** Where resources are: the place, its address, and the timezone its opening hours are read in. */
export class LocationsResource extends Resource {
  create(params: LocationCreateParams, options?: RequestOptions): BookrailPromise<Location> {
    return this.core.request<Location>({
      method: 'POST',
      path: '/v1/locations',
      body: params,
      options,
    });
  }

  list(params?: LocationListParams, options?: RequestOptions): PagePromise<Location> {
    return paginate<Location>(this.core, {
      method: 'GET',
      path: '/v1/locations',
      query: params,
      options,
    });
  }

  retrieve(id: string, options?: RequestOptions): BookrailPromise<Location> {
    return this.core.request<Location>({
      method: 'GET',
      path: `/v1/locations/${segment(id)}`,
      options,
    });
  }

  update(
    id: string,
    params: LocationUpdateParams,
    options?: RequestOptions,
  ): BookrailPromise<Location> {
    return this.core.request<Location>({
      method: 'PATCH',
      path: `/v1/locations/${segment(id)}`,
      body: params,
      options,
    });
  }

  del(id: string, options?: RequestOptions): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'DELETE',
      path: `/v1/locations/${segment(id)}`,
      options,
    });
  }
}
