import { Resource } from './base.js';
import type { RequestOptions } from '../core.js';
import type { BookrailPromise } from '../response.js';
import type { Project } from '../types.js';

/** `GET /v1/project`: who this key is. */
export class ProjectResource extends Resource {
  /** The project of the calling key, its environment, and the attributes of the key itself. */
  retrieve(options?: RequestOptions): BookrailPromise<Project> {
    return this.core.request<Project>({ method: 'GET', path: '/v1/project', options });
  }
}
