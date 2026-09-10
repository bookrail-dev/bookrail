import { Resource, segment } from './base.js';
import type { RequestOptions, BookrailCore } from '../core.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type {
  Deleted,
  Schedule,
  ScheduleCreateParams,
  ScheduleException,
  ScheduleExceptionCreateParams,
  ScheduleListParams,
  ScheduleUpdateParams,
} from '../types.js';

/** The exceptions of one schedule. Nested because the operations are, in the specification. */
export class ScheduleExceptionsResource extends Resource {
  create(
    scheduleId: string,
    params: ScheduleExceptionCreateParams,
    options?: RequestOptions,
  ): BookrailPromise<ScheduleException> {
    return this.core.request<ScheduleException>({
      method: 'POST',
      path: `/v1/schedules/${segment(scheduleId)}/exceptions`,
      body: params,
      options,
    });
  }

  del(scheduleId: string, exceptionId: string, options?: RequestOptions): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'DELETE',
      path: `/v1/schedules/${segment(scheduleId)}/exceptions/${segment(exceptionId)}`,
      options,
    });
  }
}

/** Opening hours: the weekly rules of a schedule, and the timezone they are read in. */
export class SchedulesResource extends Resource {
  /** `bookrail.schedules.exceptions.create(...)`, `…exceptions.del(...)`. */
  readonly exceptions: ScheduleExceptionsResource;

  constructor(core: BookrailCore) {
    super(core);
    this.exceptions = new ScheduleExceptionsResource(core);
  }

  create(params: ScheduleCreateParams, options?: RequestOptions): BookrailPromise<Schedule> {
    return this.core.request<Schedule>({
      method: 'POST',
      path: '/v1/schedules',
      body: params,
      options,
    });
  }

  list(params?: ScheduleListParams, options?: RequestOptions): PagePromise<Schedule> {
    return paginate<Schedule>(this.core, {
      method: 'GET',
      path: '/v1/schedules',
      query: params,
      options,
    });
  }

  retrieve(id: string, options?: RequestOptions): BookrailPromise<Schedule> {
    return this.core.request<Schedule>({
      method: 'GET',
      path: `/v1/schedules/${segment(id)}`,
      options,
    });
  }

  update(
    id: string,
    params: ScheduleUpdateParams,
    options?: RequestOptions,
  ): BookrailPromise<Schedule> {
    return this.core.request<Schedule>({
      method: 'PATCH',
      path: `/v1/schedules/${segment(id)}`,
      body: params,
      options,
    });
  }

  del(id: string, options?: RequestOptions): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'DELETE',
      path: `/v1/schedules/${segment(id)}`,
      options,
    });
  }
}
