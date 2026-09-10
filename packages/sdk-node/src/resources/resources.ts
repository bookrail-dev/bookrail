import { Resource, segment } from './base.js';
import type { RequestOptions, BookrailCore } from '../core.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type {
  Deleted,
  Resource as ResourceObject,
  ResourceBlock,
  ResourceBlockListParams,
  ResourceBlockParams,
  ResourceCreateParams,
  ResourceListParams,
  ResourceUnblockParams,
  ResourceUpdateParams,
} from '../types.js';

/** The closed periods of one resource: holidays, maintenance, anything that is not the schedule. */
export class ResourceBlocksResource extends Resource {
  /**
   * `GET /v1/resources/{id}/blocks`: the blocks, oldest start first.
   *
   * Defaults to the ones that have not ended yet: this is the read that gives back the `blk_…`
   * an `unblock` needs.
   */
  list(
    resourceId: string,
    params?: ResourceBlockListParams,
    options?: RequestOptions,
  ): PagePromise<ResourceBlock> {
    return paginate<ResourceBlock>(this.core, {
      method: 'GET',
      path: `/v1/resources/${segment(resourceId)}/blocks`,
      query: params,
      options,
    });
  }
}

/** The bookable things themselves: a court, a room, a machine, a person, each with a capacity. */
export class ResourcesResource extends Resource {
  /** `bookrail.resources.blocks.list(resourceId)`. */
  readonly blocks: ResourceBlocksResource;

  constructor(core: BookrailCore) {
    super(core);
    this.blocks = new ResourceBlocksResource(core);
  }

  create(params: ResourceCreateParams, options?: RequestOptions): BookrailPromise<ResourceObject> {
    return this.core.request<ResourceObject>({
      method: 'POST',
      path: '/v1/resources',
      body: params,
      options,
    });
  }

  list(params?: ResourceListParams, options?: RequestOptions): PagePromise<ResourceObject> {
    return paginate<ResourceObject>(this.core, {
      method: 'GET',
      path: '/v1/resources',
      query: params,
      options,
    });
  }

  retrieve(id: string, options?: RequestOptions): BookrailPromise<ResourceObject> {
    return this.core.request<ResourceObject>({
      method: 'GET',
      path: `/v1/resources/${segment(id)}`,
      options,
    });
  }

  update(
    id: string,
    params: ResourceUpdateParams,
    options?: RequestOptions,
  ): BookrailPromise<ResourceObject> {
    return this.core.request<ResourceObject>({
      method: 'PATCH',
      path: `/v1/resources/${segment(id)}`,
      body: params,
      options,
    });
  }

  del(id: string, options?: RequestOptions): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'DELETE',
      path: `/v1/resources/${segment(id)}`,
      options,
    });
  }

  /** Closes a period on a resource. Takes the whole capacity, and never over a booking. */
  block(
    id: string,
    params: ResourceBlockParams,
    options?: RequestOptions,
  ): BookrailPromise<ResourceBlock> {
    return this.core.request<ResourceBlock>({
      method: 'POST',
      path: `/v1/resources/${segment(id)}/block`,
      body: params,
      options,
    });
  }

  /** Reopens a period, by the `blk_…` of the block. */
  unblock(
    id: string,
    params: ResourceUnblockParams,
    options?: RequestOptions,
  ): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'POST',
      path: `/v1/resources/${segment(id)}/unblock`,
      body: params,
      options,
    });
  }
}
