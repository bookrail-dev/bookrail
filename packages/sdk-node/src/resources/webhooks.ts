/**
 * Webhook endpoints and their delivery log, plus the one function of this package that is not
 * an HTTP call: verifying a delivery that arrived.
 *
 * This is the **only** module of the SDK that imports `@bookrail/webhook-signature`, and
 * therefore the only path that reaches `node:crypto`. Everything else runs on the global
 * `fetch` and the Web Crypto API, so it works unchanged where `node:` does not exist.
 */
import { verifySignature, DEFAULT_SIGNATURE_TOLERANCE_SECONDS } from '@bookrail/webhook-signature';
import { Resource, segment } from './base.js';
import type { RequestOptions, BookrailCore } from '../core.js';
import { BookrailSignatureVerificationError, BookrailError } from '../errors.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type {
  Deleted,
  Event,
  Webhook,
  WebhookCreateParams,
  WebhookCreated,
  WebhookDelivery,
  WebhookDeliveryListParams,
  WebhookListParams,
  WebhookUpdateParams,
} from '../types.js';

/** The delivery log of one endpoint. */
export class WebhookDeliveriesResource extends Resource {
  /** Newest first: the one list of the API that is not oldest first. */
  list(
    webhookId: string,
    params?: WebhookDeliveryListParams,
    options?: RequestOptions,
  ): PagePromise<WebhookDelivery> {
    return paginate<WebhookDelivery>(this.core, {
      method: 'GET',
      path: `/v1/webhooks/${segment(webhookId)}/deliveries`,
      query: params,
      options,
    });
  }

  /** Queues a delivery again. Answers the row, `pending`, with its next attempt. */
  retry(
    webhookId: string,
    deliveryId: string,
    options?: RequestOptions,
  ): BookrailPromise<WebhookDelivery> {
    return this.core.request<WebhookDelivery>({
      method: 'POST',
      path: `/v1/webhooks/${segment(webhookId)}/deliveries/${segment(deliveryId)}/retry`,
      body: {},
      options,
    });
  }
}

export class WebhooksResource extends Resource {
  /** `bookrail.webhooks.deliveries.list(...)`, `…deliveries.retry(...)`. */
  readonly deliveries: WebhookDeliveriesResource;

  constructor(core: BookrailCore) {
    super(core);
    this.deliveries = new WebhookDeliveriesResource(core);
  }

  /**
   * Registers an endpoint. The `secret` is in this answer and **in no other**.
   *
   * Not even a replay of the same `Idempotency-Key` returns it: on a replay the `secret` field
   * is simply absent, which is why the specification declares it optional. Store it when you
   * see it.
   */
  create(params: WebhookCreateParams, options?: RequestOptions): BookrailPromise<WebhookCreated> {
    return this.core.request<WebhookCreated>({
      method: 'POST',
      path: '/v1/webhooks',
      body: params,
      options,
    });
  }

  list(params?: WebhookListParams, options?: RequestOptions): PagePromise<Webhook> {
    return paginate<Webhook>(this.core, {
      method: 'GET',
      path: '/v1/webhooks',
      query: params,
      options,
    });
  }

  retrieve(id: string, options?: RequestOptions): BookrailPromise<Webhook> {
    return this.core.request<Webhook>({
      method: 'GET',
      path: `/v1/webhooks/${segment(id)}`,
      options,
    });
  }

  update(
    id: string,
    params: WebhookUpdateParams,
    options?: RequestOptions,
  ): BookrailPromise<Webhook> {
    return this.core.request<Webhook>({
      method: 'PATCH',
      path: `/v1/webhooks/${segment(id)}`,
      body: params,
      options,
    });
  }

  del(id: string, options?: RequestOptions): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'DELETE',
      path: `/v1/webhooks/${segment(id)}`,
      options,
    });
  }

  /**
   * Delivers a synthetic `webhook.test` now, and answers what the endpoint replied.
   *
   * Synchronous on the server: this call waits for the receiver, up to ten seconds.
   */
  test(id: string, options?: RequestOptions): BookrailPromise<WebhookDelivery> {
    return this.core.request<WebhookDelivery>({
      method: 'POST',
      path: `/v1/webhooks/${segment(id)}/test`,
      body: {},
      options,
    });
  }

  /**
   * Verifies a delivery and gives back the typed event.
   *
   * ```ts
   * const event = bookrail.webhooks.constructEvent(rawBody, request.headers['bookrail-signature'], secret);
   * ```
   *
   * `payload` must be the **raw bytes** that arrived, never a re-serialised object: two JSON
   * encoders disagree about key order and whitespace, and a re-encoded body will not verify.
   *
   * Throws {@link BookrailSignatureVerificationError} when the signature is wrong, the header
   * is malformed or absent, or the timestamp is outside `toleranceSeconds` (five minutes by
   * default). A body that verifies but is not JSON is a {@link BookrailError}: a signed payload
   * that we cannot parse is our bug, not a forgery.
   */
  constructEvent(
    payload: string | Uint8Array,
    signatureHeader: string | null | undefined,
    secret: string,
    toleranceSeconds: number = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  ): Event {
    const body = typeof payload === 'string' ? payload : new TextDecoder('utf-8').decode(payload);
    const header = signatureHeader ?? null;
    if (!verifySignature(body, header, secret, toleranceSeconds)) {
      throw new BookrailSignatureVerificationError(
        'The Bookrail-Signature header does not match this payload and secret, or its timestamp is outside the tolerance.',
        body,
        header,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (cause) {
      throw new BookrailError('internal', 'The delivery verified but its body is not JSON.', {
        code: 'unexpected_response',
        cause,
      });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new BookrailError(
        'internal',
        'The delivery verified but its body is not a JSON object.',
        { code: 'unexpected_response' },
      );
    }
    return parsed as Event;
  }
}
