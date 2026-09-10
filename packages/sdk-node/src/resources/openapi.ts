import { Resource } from './base.js';
import type { RequestOptions } from '../core.js';
import type { BookrailPromise } from '../response.js';
import type { OpenApiDocument } from '../types.js';

/** `GET /openapi.json`: the contract, served **without** a key. */
export class OpenApiResource extends Resource {
  /**
   * The OpenAPI 3.1 document of the installation this client points at.
   *
   * Sent without `Authorization`, because the endpoint takes none: an agent that has the URL
   * can read the contract before it has a credential.
   */
  retrieve(options?: RequestOptions): BookrailPromise<OpenApiDocument> {
    return this.core.request<OpenApiDocument>({
      method: 'GET',
      path: '/openapi.json',
      anonymous: true,
      options,
    });
  }
}
