import { Resource, segment } from './base.js';
import type { RequestOptions } from '../core.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type {
  Deleted,
  ResourceGroup,
  ResourceGroupCreateParams,
  ResourceGroupListParams,
  ResourceGroupUpdateParams,
} from '../types.js';

/** Named sets of resources, so a service requirement can ask for "one of these". */
export class ResourceGroupsResource extends Resource {
  create(
    params: ResourceGroupCreateParams,
    options?: RequestOptions,
  ): BookrailPromise<ResourceGroup> {
    return this.core.request<ResourceGroup>({
      method: 'POST',
      path: '/v1/resource_groups',
      body: params,
      options,
    });
  }

  list(params?: ResourceGroupListParams, options?: RequestOptions): PagePromise<ResourceGroup> {
    return paginate<ResourceGroup>(this.core, {
      method: 'GET',
      path: '/v1/resource_groups',
      query: params,
      options,
    });
  }

  retrieve(id: string, options?: RequestOptions): BookrailPromise<ResourceGroup> {
    return this.core.request<ResourceGroup>({
      method: 'GET',
      path: `/v1/resource_groups/${segment(id)}`,
      options,
    });
  }

  update(
    id: string,
    params: ResourceGroupUpdateParams,
    options?: RequestOptions,
  ): BookrailPromise<ResourceGroup> {
    return this.core.request<ResourceGroup>({
      method: 'PATCH',
      path: `/v1/resource_groups/${segment(id)}`,
      body: params,
      options,
    });
  }

  del(id: string, options?: RequestOptions): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'DELETE',
      path: `/v1/resource_groups/${segment(id)}`,
      options,
    });
  }
}
