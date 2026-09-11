/**
 * Generated from `packages/api/openapi/openapi.json` by `pnpm --filter @bookrail/node generate`.
 *
 * Do not edit by hand: `test/generated.test.ts` fails when this file and the specification
 * disagree. Every public type of this package is derived from what is below (`src/types.ts`),
 * so a change to a Zod schema of the server reaches the SDK by regeneration, never by hand.
 */
export interface paths {
  '/openapi.json': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Fetch this OpenAPI document
     * @description The specification of this API, generated from the same Zod schemas the server validates with. No API key required.
     */
    get: operations['openapi.get'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/availability': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Search availability over a window */
    post: operations['availability.search'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/availability/check': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Check one precise instant
     * @description Feasibility at that instant, not alignment to the grid: a start the search would not offer still gets structured reasons.
     */
    post: operations['availability.check'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/availability/next': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Find the next bookable slot
     * @description Searches in thirty day windows up to a ninety day horizon, stopping at the first window that contains a slot.
     */
    get: operations['availability.next'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/bookings': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List bookings
     * @description `from` and `to` filter on `starts_at`: `from` included, `to` excluded.
     */
    get: operations['bookings.list'];
    put?: never;
    /**
     * Create a booking
     * @description With `hold_id` it converts the hold instead of taking new capacity. `payment.mode` other than `none`, and any `recurrence`, answer `400 not_yet_supported`.
     */
    post: operations['bookings.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/bookings/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Retrieve a booking */
    get: operations['bookings.get'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/bookings/{id}/cancel': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Cancel a booking
     * @description `by` defaults to `customer`. `override_refund_percent` beats every tier, for any `by`. No money moves: the amounts written are expectations.
     */
    post: operations['bookings.cancel'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/bookings/{id}/check_in': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Check a booking in */
    post: operations['bookings.check_in'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/bookings/{id}/complete': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Complete a booking
     * @description Allowed from `starts_at` onwards; before that it is `422 complete_too_early`.
     */
    post: operations['bookings.complete'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/bookings/{id}/confirm': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Confirm a booking */
    post: operations['bookings.confirm'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/bookings/{id}/no_show': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Mark a booking as a no-show
     * @description Allowed from `starts_at + policy_snapshot.no_show.grace_minutes` onwards; before that it is `422 no_show_too_early`.
     */
    post: operations['bookings.no_show'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/bookings/{id}/reschedule': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Reschedule a booking
     * @description Answers with the **new** booking. The old one is one `GET` away through `rescheduled_from_booking_id`. An unavailable slot is a `409` and leaves the old booking intact.
     */
    post: operations['bookings.reschedule'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/customers': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List customers */
    get: operations['customers.list'];
    put?: never;
    /**
     * Create or upsert a customer
     * @description With `external_id` the write is an upsert with merge: `201` when the customer is created, `200` when an existing one is updated.
     */
    post: operations['customers.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/customers/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Retrieve a customer */
    get: operations['customers.get'];
    put?: never;
    post?: never;
    /** Delete a customer */
    delete: operations['customers.delete'];
    options?: never;
    head?: never;
    /** Update a customer */
    patch: operations['customers.update'];
    trace?: never;
  };
  '/v1/events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List events
     * @description Ordered by `(txid, seq)` and behind the visibility horizon, so a consumer that has read up to a cursor never later finds a row it stepped over. An event is readable only once every write transaction that started before it has ended.
     */
    get: operations['events.list'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/events/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Retrieve an event
     * @description Not behind the horizon: the caller already holds the identifier.
     */
    get: operations['events.get'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/holds': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Hold a slot
     * @description Takes the capacity for `ttl`, clamped to thirty minutes by the engine. The answer carries neither `metadata` nor the timestamps: they are read back by `GET /v1/holds/{id}`.
     */
    post: operations['holds.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/holds/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Retrieve a hold */
    get: operations['holds.get'];
    put?: never;
    post?: never;
    /**
     * Release a hold
     * @description Idempotent: releasing an already released or expired hold is a `200`. Only a hold already converted into a booking answers `409 hold_not_active`.
     */
    delete: operations['holds.release'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/locations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List locations */
    get: operations['locations.list'];
    put?: never;
    /** Create a location */
    post: operations['locations.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/locations/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Retrieve a location */
    get: operations['locations.get'];
    put?: never;
    post?: never;
    /** Delete a location */
    delete: operations['locations.delete'];
    options?: never;
    head?: never;
    /**
     * Update a location
     * @description Changing `timezone` moves the open timeline of every resource that has no zone of its own, so it can emit `booking.orphaned`.
     */
    patch: operations['locations.update'];
    trace?: never;
  };
  '/v1/policies': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List policies */
    get: operations['policies.list'];
    put?: never;
    /** Create a policy */
    post: operations['policies.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/policies/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Retrieve a policy */
    get: operations['policies.get'];
    put?: never;
    post?: never;
    /** Delete a policy */
    delete: operations['policies.delete'];
    options?: never;
    head?: never;
    /** Update a policy */
    patch: operations['policies.update'];
    trace?: never;
  };
  '/v1/project': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Retrieve the calling project
     * @description Answers "who am I": the project the API key belongs to, and the attributes of the key itself. The key is the selector, so there is no identifier to pass.
     */
    get: operations['project.get'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/resource_groups': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List resource groups */
    get: operations['resource_groups.list'];
    put?: never;
    /** Create a resource group */
    post: operations['resource_groups.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/resource_groups/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Retrieve a resource group */
    get: operations['resource_groups.get'];
    put?: never;
    post?: never;
    /** Delete a resource group */
    delete: operations['resource_groups.delete'];
    options?: never;
    head?: never;
    /**
     * Update a resource group
     * @description `resource_ids` replaces the whole membership; omitting it leaves it untouched.
     */
    patch: operations['resource_groups.update'];
    trace?: never;
  };
  '/v1/resources': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List resources */
    get: operations['resources.list'];
    put?: never;
    /** Create a resource */
    post: operations['resources.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/resources/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Retrieve a resource */
    get: operations['resources.get'];
    put?: never;
    post?: never;
    /**
     * Delete a resource
     * @description Soft delete: bookings and occupancies keep referring to the resource.
     */
    delete: operations['resources.delete'];
    options?: never;
    head?: never;
    /**
     * Update a resource
     * @description Touching `capacity`, `status`, `schedule_id` or `location_id` can emit `booking.orphaned` for future bookings the new configuration no longer supports.
     */
    patch: operations['resources.update'];
    trace?: never;
  };
  '/v1/resources/{id}/block': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Block a period of a resource
     * @description Takes the whole capacity of the resource, so a period that is already booked or held answers `409 slot_unavailable`.
     */
    post: operations['resources.block'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/resources/{id}/blocks': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List the blocks of a resource
     * @description Ordered by start, cursored on `(lower(period), id)`. With neither `from` nor `to`, answers the blocks that have not finished yet.
     */
    get: operations['resources.blocks.list'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/resources/{id}/unblock': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Remove a block */
    post: operations['resources.unblock'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/schedules': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List schedules */
    get: operations['schedules.list'];
    put?: never;
    /** Create a schedule */
    post: operations['schedules.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/schedules/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Retrieve a schedule */
    get: operations['schedules.get'];
    put?: never;
    post?: never;
    /** Delete a schedule */
    delete: operations['schedules.delete'];
    options?: never;
    head?: never;
    /**
     * Update a schedule
     * @description `rules` replaces the whole set. Touching `rules` or `timezone` can emit `booking.orphaned`.
     */
    patch: operations['schedules.update'];
    trace?: never;
  };
  '/v1/schedules/{id}/exceptions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Add a calendar exception */
    post: operations['schedules.exceptions.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/schedules/{id}/exceptions/{eid}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** Remove a calendar exception */
    delete: operations['schedules.exceptions.delete'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/services': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List services */
    get: operations['services.list'];
    put?: never;
    /** Create a service */
    post: operations['services.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/services/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Retrieve a service */
    get: operations['services.get'];
    put?: never;
    post?: never;
    /**
     * Delete a service
     * @description Soft delete: past bookings keep pointing at the service they were made for.
     */
    delete: operations['services.delete'];
    options?: never;
    head?: never;
    /**
     * Update a service
     * @description `requirements` replaces the whole set; omitting it leaves it untouched.
     */
    patch: operations['services.update'];
    trace?: never;
  };
  '/v1/signups': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Ask for a test key
     * @description Sends a confirmation link to the address. The answer is the same whether or not that address already has an account: the collision is reported at confirmation time, to whoever can read the mailbox. No API key.
     */
    post: operations['signups.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/signups/confirm': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Confirm a sign up and create the key
     * @description Creates the account, the project and one test key, in one transaction. For `client: "web"` the key is in the response, once. For `client: "cli"` it waits for the terminal to claim it. No API key.
     */
    post: operations['signups.confirm'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/signups/{id}/claim': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Collect the key of a confirmed sign up
     * @description What a waiting terminal polls. Answers `pending` until the link is opened, then the key, once. No API key.
     */
    post: operations['signups.claim'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/webhooks': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List webhook endpoints */
    get: operations['webhooks.list'];
    put?: never;
    /**
     * Register a webhook endpoint
     * @description The only response that ever carries `secret`. An idempotent replay of the same key answers **without** it.
     */
    post: operations['webhooks.create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/webhooks/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Retrieve a webhook endpoint */
    get: operations['webhooks.get'];
    put?: never;
    post?: never;
    /**
     * Delete a webhook endpoint
     * @description Takes the endpoint’s deliveries with it. To stop the traffic and keep the history, set `status: "disabled"`.
     */
    delete: operations['webhooks.delete'];
    options?: never;
    head?: never;
    /**
     * Update a webhook endpoint
     * @description `status` accepts `active` and `disabled` only: `failing` is an observation of the delivery worker, not a state a customer declares.
     */
    patch: operations['webhooks.update'];
    trace?: never;
  };
  '/v1/webhooks/{id}/deliveries': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List the deliveries of an endpoint
     * @description Newest first, unlike every other list: a delivery log answers "what just happened".
     */
    get: operations['webhooks.deliveries.list'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/webhooks/{id}/deliveries/{did}/retry': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Replay a delivery
     * @description Puts the delivery back at the front of the queue with `attempt` reset and a fresh ladder. Allowed for thirty days after it was created.
     */
    post: operations['webhooks.deliveries.retry'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/webhooks/{id}/test': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Send a test delivery
     * @description Delivers synchronously and answers with the delivery, HTTP status and body included. No retry ladder.
     */
    post: operations['webhooks.test'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    ApiKey: {
      /**
       * @description Identifier of a api_key, prefixed with `key_`.
       * @example key_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'api_key';
      /** @enum {string} */
      kind: 'secret' | 'publishable';
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /** @description Stored, not yet enforced. An empty list means no restriction. */
      scopes: string[];
      /** @description Optional tenant this object belongs to, for multi-tenant customers. */
      tenant_id: string | null;
    };
    Availability: {
      /** @enum {string} */
      object: 'availability';
      /**
       * @description Identifier of a service, prefixed with `svc_`.
       * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      service_id: string;
      timezone: string;
      /** @enum {string} */
      granularity: 'slots' | 'ranges';
      slots: components['schemas']['AvailabilitySlot'][];
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      next_available: string | null;
      reason?: components['schemas']['AvailabilityReason'];
      /** @description Present only with `explain: true`. */
      explain?: components['schemas']['ExplainEntry'][];
      /** @description Present only with `explain: true`. What the engine had to ignore to answer, with no instant of its own: today only `pricing_rule_ignored`, a stored pricing rule the strict schema refuses. */
      explain_notes?: components['schemas']['ExplainNote'][];
      /** @description Present only with `explain: true`. */
      explain_truncated?: boolean;
    };
    AvailabilityCheck: {
      /** @enum {string} */
      object: 'availability_check';
      /**
       * @description Identifier of a service, prefixed with `svc_`.
       * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      service_id: string;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      start: string;
      duration_minutes: number | null;
      available: boolean;
      available_capacity: number;
      /** @description Amount in the minor unit of the currency (cents for EUR). */
      price: {
        amount: number;
        currency: string;
      } | null;
      /** @description Which `service.pricing_rules` entry produced `price`, if any. */
      price_rule: {
        /** @description Position in `service.pricing_rules`. */
        index: number;
        /** @description The rule label, when it has one. */
        label: string | null;
      } | null;
      resource_options: components['schemas']['ResourceOption'][];
      /** @description Present only when `available` is false. */
      reasons?: components['schemas']['ExplainReason'][];
      reason?: components['schemas']['AvailabilityReason'];
    };
    AvailabilityNext: {
      /** @enum {string} */
      object: 'availability_next';
      /**
       * @description Identifier of a service, prefixed with `svc_`.
       * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      service_id: string;
      timezone: string;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      next_available: string | null;
      slot: components['schemas']['AvailabilitySlot'] & (Record<string, unknown> | null);
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      searched_through: string;
    };
    /** @description Present when the window is well formed but no slot can exist for a reason that covers all of it, e.g. `customer_limit_reached`. */
    AvailabilityReason: {
      code: string;
      message: string;
    };
    AvailabilitySlot: {
      /** @enum {string} */
      object: 'availability_slot';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      start: string;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      end: string;
      /** @description `null` for a `ranges` entry. */
      duration_minutes: number | null;
      available_capacity: number;
      /** @description Amount in the minor unit of the currency (cents for EUR). */
      price: {
        amount: number;
        currency: string;
      } | null;
      /** @description Which `service.pricing_rules` entry produced `price`. `null` when the flat service price applied. For a `ranges` entry it is the rule of the shortest booking starting at `start`. */
      price_rule: {
        /** @description Position in `service.pricing_rules`. */
        index: number;
        /** @description The rule label, when it has one. */
        label: string | null;
      } | null;
      resource_options: components['schemas']['ResourceOption'][];
      /** @description `ranges` only: shortest bookable length inside the interval. */
      min_duration_minutes?: number;
      /** @description `ranges` only: longest bookable length; may exceed `end - start`. */
      max_duration_minutes?: number;
    };
    Booking: {
      /**
       * @description Identifier of a booking, prefixed with `bk_`.
       * @example bk_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'booking';
      /** @enum {string} */
      status:
        | 'held'
        | 'pending'
        | 'confirmed'
        | 'in_progress'
        | 'completed'
        | 'cancelled'
        | 'no_show'
        | 'rescheduled';
      /**
       * @description Identifier of a service, prefixed with `svc_`.
       * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      service_id: string;
      /**
       * @description Identifier of a customer, prefixed with `cus_`.
       * @example cus_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      customer_id: string | null;
      /**
       * @description Identifier of a hold, prefixed with `hold_`.
       * @example hold_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      hold_id: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      start: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      end: string | null;
      duration_minutes: number;
      timezone: string;
      quantity: number;
      /** @description Amount in the minor unit of the currency (cents for EUR). */
      price: {
        amount: number;
        currency: string;
      } | null;
      /** @description Which `service.pricing_rules` entry priced this booking, frozen at creation. `null` when the flat service price applied. */
      price_rule: {
        /** @description Position in `service.pricing_rules`. */
        index: number;
        /** @description The rule label, when it has one. */
        label: string | null;
      } | null;
      amount_paid: number;
      amount_due: number;
      amount_refunded: number;
      /** @description The policy frozen at creation, as stored. `null` when the service had none. */
      policy_snapshot: {
        [key: string]: unknown;
      } | null;
      /** @enum {string} */
      source: 'api' | 'widget' | 'portal' | 'import';
      notes: string | null;
      /** @enum {string|null} */
      cancelled_by: 'customer' | 'provider' | 'system' | null;
      cancellation_reason: string | null;
      refund_percent: number | null;
      refund_amount_expected: number | null;
      no_show_charge_expected: number | null;
      reschedule_fee_expected: number | null;
      reschedule_count: number;
      /**
       * @description Identifier of a booking, prefixed with `bk_`.
       * @example bk_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      rescheduled_from_booking_id: string | null;
      /**
       * @description Identifier of a booking, prefixed with `bk_`.
       * @example bk_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      rescheduled_to_booking_id: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      confirmed_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      checked_in_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      cancelled_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      completed_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      no_show_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      rescheduled_at: string | null;
      /** @enum {string|null} */
      next_transition: 'start' | 'complete' | 'no_show' | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      next_transition_at: string | null;
      allocations: components['schemas']['BookingAllocation'][];
      /** @description Optional tenant this object belongs to, for multi-tenant customers. */
      tenant_id: string | null;
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
      customer?: components['schemas']['Customer'] & (Record<string, unknown> | null);
    };
    BookingAllocation: {
      /** @enum {string} */
      object: 'booking_allocation';
      /**
       * @description Identifier of a resource, prefixed with `res_`.
       * @example res_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      resource_id: string;
      role: string | null;
      capacity_used: number;
      /**
       * @description Present on a booking allocation, absent on the allocations of a hold.
       * @example ball_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id?: string;
      resource?: components['schemas']['Resource'] & (Record<string, unknown> | null);
    };
    BookingList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['Booking'][];
      has_more: boolean;
    };
    /**
     * @description Which Bookrail tool the caller is, recorded as `actor.via` on every event the request writes. A closed list: an unknown value is a 400. Absent means the request declared no tool.
     * @enum {string}
     */
    BookrailActor: 'mcp' | 'cli' | 'sdk' | 'dashboard';
    /**
     * @description The dated API version to speak. Defaults to `2026-09-01`; an unsupported value is a 400.
     * @example 2026-09-01
     */
    BookrailVersion: string;
    Customer: {
      /**
       * @description Identifier of a customer, prefixed with `cus_`.
       * @example cus_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'customer';
      external_id: string | null;
      email: string | null;
      phone: string | null;
      name: string | null;
      timezone: string | null;
      locale: string | null;
      /** @description Optional tenant this object belongs to, for multi-tenant customers. */
      tenant_id: string | null;
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
    };
    CustomerList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['Customer'][];
      has_more: boolean;
    };
    Deleted: {
      id: string;
      /** @description The kind of object that was deleted. */
      object: string;
      /** @enum {boolean} */
      deleted: true;
    };
    Error: {
      error: {
        /** @enum {string} */
        type:
          | 'invalid_request'
          | 'authentication'
          | 'permission'
          | 'not_found'
          | 'conflict'
          | 'rate_limit'
          | 'policy_violation'
          | 'payment_required'
          | 'internal';
        /** @description Machine readable code. The set is per operation; each response below lists the ones it can produce. */
        code: string;
        message: string;
        /** @description The field or header the error is about, when there is one. */
        param?: string;
        /** @description What to do next, when there is one thing to do. Present on the errors that are about the state of the deployment rather than about the request. */
        fix?: string;
        doc_url: string;
        request_id: string;
      };
    };
    Event: {
      /**
       * @description Identifier of a event, prefixed with `evt_`.
       * @example evt_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'event';
      type: string;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      occurred_at: string | null;
      api_version: string;
      /** @description Position in the global event sequence. Not a count: a project’s values have arbitrary gaps. */
      seq: number;
      /** @description `{type: "api", id: "key_...", via?: "mcp"|"cli"|"sdk"|"dashboard"}` for an HTTP write, `{type: "system", id: null}` for an automatic transition, `null` when nobody declared one. */
      actor: {
        [key: string]: unknown;
      } | null;
      data: {
        /** @description Snapshot of the object after the change. */
        object: {
          [key: string]: unknown;
        } | null;
        /** @description The fields that changed, or `null` for a creation. */
        previous: {
          [key: string]: unknown;
        } | null;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
    };
    EventList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['Event'][];
      has_more: boolean;
    };
    ExplainEntry: {
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      at: string;
      reasons: components['schemas']['ExplainReason'][];
    };
    ExplainNote: {
      /** @enum {string} */
      code: 'pricing_rule_ignored';
      message: string;
      /** @description Position in `service.pricing_rules` of the rule the note is about. */
      index: number;
    };
    ExplainReason: {
      /** @enum {string} */
      code:
        | 'outside_schedule'
        | 'exception_closed'
        | 'blocked'
        | 'occupied'
        | 'buffer'
        | 'min_notice'
        | 'max_advance'
        | 'capacity'
        | 'customer_limit';
      message: string;
      /**
       * @description Identifier of a resource, prefixed with `res_`.
       * @example res_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      resource_id?: string;
      /** @description Bare identifier of the booking, hold, block or exception responsible; `code` says which. */
      ref_id?: string;
    };
    Hold: {
      /**
       * @description Identifier of a hold, prefixed with `hold_`.
       * @example hold_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'hold';
      /**
       * @description Computed, not copied: a hold whose `expires_at` has passed is `expired` even while its row still says `active`.
       * @enum {string}
       */
      status: 'active' | 'released' | 'expired' | 'converted';
      /**
       * @description Identifier of a service, prefixed with `svc_`.
       * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      service_id: string;
      /**
       * @description Identifier of a customer, prefixed with `cus_`.
       * @example cus_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      customer_id: string | null;
      /**
       * @description Identifier of a booking, prefixed with `bk_`.
       * @example bk_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      booking_id: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      start: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      end: string | null;
      duration_minutes: number;
      quantity: number;
      timezone: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      expires_at: string | null;
      /** @description Always `null` on read: `holds` has no price column. */
      price: {
        amount: number;
        currency: string;
      } | null;
      /** @description Always `null` on read, for the same reason as `price`. */
      price_rule: {
        /** @description Position in `service.pricing_rules`. */
        index: number;
        /** @description The rule label, when it has one. */
        label: string | null;
      } | null;
      allocations: components['schemas']['BookingAllocation'][];
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
    };
    HoldCreated: {
      /**
       * @description Identifier of a hold, prefixed with `hold_`.
       * @example hold_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'hold';
      /** @enum {string} */
      status: 'active' | 'released' | 'expired' | 'converted';
      /**
       * @description Identifier of a service, prefixed with `svc_`.
       * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      service_id: string;
      /**
       * @description Identifier of a customer, prefixed with `cus_`.
       * @example cus_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      customer_id: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      start: string;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      end: string;
      duration_minutes: number;
      quantity: number;
      timezone: string;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      expires_at: string | null;
      /** @description Amount in the minor unit of the currency (cents for EUR). */
      price: {
        amount: number;
        currency: string;
      } | null;
      /** @description Which `service.pricing_rules` entry made this quote. A hold is not a sale: the booking recomputes it at conversion. */
      price_rule: {
        /** @description Position in `service.pricing_rules`. */
        index: number;
        /** @description The rule label, when it has one. */
        label: string | null;
      } | null;
      allocations: components['schemas']['BookingAllocation'][];
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
    };
    /** @description Retry-safety key, 1 to 255 characters. The same key within 24 hours replays the first response, errors included, and never produces a second effect. */
    IdempotencyKey: string;
    Location: {
      /**
       * @description Identifier of a location, prefixed with `loc_`.
       * @example loc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'location';
      name: string;
      timezone: string;
      address: {
        [key: string]: unknown;
      } | null;
      /** @description Optional tenant this object belongs to, for multi-tenant customers. */
      tenant_id: string | null;
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
    };
    LocationList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['Location'][];
      has_more: boolean;
    };
    OpenApiDocument: {
      /** @enum {string} */
      openapi: '3.1.0';
      info: {
        [key: string]: unknown;
      };
      servers: {
        [key: string]: unknown;
      }[];
      tags: {
        [key: string]: unknown;
      }[];
      security: {
        [key: string]: unknown;
      }[];
      paths: {
        [key: string]: unknown;
      };
      components: {
        [key: string]: unknown;
      };
    };
    Policy: {
      /**
       * @description Identifier of a policy, prefixed with `pol_`.
       * @example pol_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'policy';
      name: string;
      /** @description Refund tiers, as stored: `{ before, refund_percent?, fee? }`. An empty list refunds nothing. */
      cancellation: {
        [key: string]: unknown;
      }[];
      /** @description Reschedule fee tiers, as stored. */
      reschedule: {
        [key: string]: unknown;
      }[];
      /** @description Deposit rule, as stored. `null` when unset. */
      deposit: {
        [key: string]: unknown;
      } | null;
      /** @enum {string} */
      payment_timing: 'at_booking' | 'before_start' | 'after_service' | 'none';
      payment_deadline: string | null;
      /** @description No-show rule, as stored. `null` when unset. */
      no_show: {
        [key: string]: unknown;
      } | null;
      hold_duration_seconds: number;
      max_active_bookings_per_customer: number | null;
      require_customer_confirmation: boolean;
      require_provider_confirmation: boolean;
      auto_start: boolean;
      auto_complete: boolean;
      max_reschedules: number | null;
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
    };
    PolicyList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['Policy'][];
      has_more: boolean;
    };
    Project: {
      /**
       * @description Identifier of a project, prefixed with `proj_`.
       * @example proj_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'project';
      name: string;
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      api_version: string;
      default_timezone: string;
      default_currency: string;
      api_key: components['schemas']['ApiKey'];
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string;
    };
    Resource: {
      /**
       * @description Identifier of a resource, prefixed with `res_`.
       * @example res_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'resource';
      name: string;
      type: string;
      /**
       * @description Identifier of a location, prefixed with `loc_`.
       * @example loc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      location_id: string | null;
      /**
       * @description Identifier of a schedule, prefixed with `sch_`.
       * @example sch_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      schedule_id: string | null;
      capacity: number;
      attributes: {
        [key: string]: unknown;
      };
      /** @enum {string} */
      status: 'active' | 'inactive';
      /** @description Optional tenant this object belongs to, for multi-tenant customers. */
      tenant_id: string | null;
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
      schedule?: components['schemas']['Schedule'];
    };
    ResourceBlock: {
      /**
       * @description Identifier of a resource_block, prefixed with `blk_`.
       * @example blk_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'resource_block';
      /**
       * @description Identifier of a resource, prefixed with `res_`.
       * @example res_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      resource_id: string;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      from: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      to: string | null;
      reason: string | null;
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
    };
    ResourceBlockList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['ResourceBlock'][];
      has_more: boolean;
    };
    ResourceGroup: {
      /**
       * @description Identifier of a resource_group, prefixed with `rg_`.
       * @example rg_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'resource_group';
      name: string;
      selector: {
        [key: string]: unknown;
      } | null;
      /** @enum {string} */
      allocation_strategy: 'least_busy' | 'round_robin' | 'first_available' | 'priority';
      resource_ids: string[];
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
      /** @description Present only with `expand[]=resources`. */
      resources?: components['schemas']['Resource'][];
    };
    ResourceGroupList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['ResourceGroup'][];
      has_more: boolean;
    };
    ResourceList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['Resource'][];
      has_more: boolean;
    };
    ResourceOption: {
      resources: {
        /**
         * @description Identifier of a resource, prefixed with `res_`.
         * @example res_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
         */
        resource_id: string;
        role: string | null;
        capacity_used: number;
      }[];
    };
    /** @description Present only with `expand[]=schedule`. `null` when the resource has none. */
    Schedule: {
      /**
       * @description Identifier of a schedule, prefixed with `sch_`.
       * @example sch_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'schedule';
      name: string;
      timezone: string | null;
      rules: components['schemas']['ScheduleRule'][];
      exceptions: components['schemas']['ScheduleException'][];
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
    } | null;
    ScheduleException: {
      /**
       * @description Identifier of a schedule_exception, prefixed with `she_`.
       * @example she_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'schedule_exception';
      /**
       * @description Identifier of a schedule, prefixed with `sch_`.
       * @example sch_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      schedule_id: string;
      date: string;
      /** @enum {string} */
      type: 'closed' | 'open';
      start_time: string | null;
      end_time: string | null;
      reason: string | null;
    };
    ScheduleList: {
      /** @enum {string} */
      object: 'list';
      data: (components['schemas']['Schedule'] & Record<string, unknown>)[];
      has_more: boolean;
    };
    ScheduleRule: {
      /**
       * @description Identifier of a schedule_rule, prefixed with `shr_`.
       * @example shr_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'schedule_rule';
      /**
       * @description Identifier of a schedule, prefixed with `sch_`.
       * @example sch_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      schedule_id: string;
      days_of_week: number[];
      start_time: string | null;
      end_time: string | null;
      valid_from: string | null;
      valid_until: string | null;
    };
    Service: {
      /**
       * @description Identifier of a service, prefixed with `svc_`.
       * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'service';
      name: string;
      description: string | null;
      duration: number | null;
      duration_options: number[] | null;
      duration_range: {
        min: number;
        max: number;
      } | null;
      capacity_per_booking: number;
      buffer_before: number;
      buffer_after: number;
      slot_interval: number | null;
      /** @enum {string|null} */
      align_to: 'hour' | 'half_hour' | 'schedule_start' | null;
      /** @description Amount in the minor unit of the currency (cents for EUR). */
      price: {
        amount: number;
        currency: string;
      } | null;
      /** @description Evaluated in order for every slot and frozen on the booking: the first rule whose `when` matches replaces the flat `price`. Empty means the flat price always applies. */
      pricing_rules: {
        when: {
          days?: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[];
          time_from?: string;
          time_to?: string;
          date_from?: string;
          date_to?: string;
          resource_id?: string;
          duration_min?: number;
        };
        price?: number;
        price_add?: number;
        price_multiplier?: number;
        label?: string;
      }[];
      /**
       * @description Identifier of a policy, prefixed with `pol_`.
       * @example pol_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      policy_id: string | null;
      /** @description `{ min_notice_minutes?, max_advance_days? }`, as stored. */
      booking_window: {
        [key: string]: unknown;
      } | null;
      allow_recurring: boolean;
      allow_multi_day: boolean;
      buffer_sharing: boolean;
      allow_split: boolean;
      requirement_ids: string[];
      /** @description Optional tenant this object belongs to, for multi-tenant customers. */
      tenant_id: string | null;
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
      /** @description Present only with `expand[]=requirements`. */
      requirements?: components['schemas']['ServiceRequirement'][];
    };
    ServiceList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['Service'][];
      has_more: boolean;
    };
    ServiceRequirement: {
      /**
       * @description Identifier of a service_requirement, prefixed with `sreq_`.
       * @example sreq_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'service_requirement';
      /**
       * @description Identifier of a service, prefixed with `svc_`.
       * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      service_id: string;
      /**
       * @description Identifier of a resource, prefixed with `res_`.
       * @example res_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      resource_id: string | null;
      /**
       * @description Identifier of a resource_group, prefixed with `rg_`.
       * @example rg_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      resource_group_id: string | null;
      quantity: number;
      /** @enum {string} */
      consumes: 'per_unit' | 'whole';
      role: string | null;
    };
    Signup: {
      /**
       * @description Identifier of a signup, prefixed with `sgn_`.
       * @example sgn_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'signup';
      /** @enum {string} */
      status: 'pending' | 'confirmed' | 'claimed' | 'email_taken' | 'expired';
      /** @description Echoed back so a client can show where the message went. */
      email?: string;
      /**
       * Format: date-time
       * @description When the confirmation link stops working.
       * @example 2026-09-08T07:00:00Z
       */
      expires_at?: string;
      /** @description Only for `client: "cli"`, and only in the answer that created the sign up: the token the terminal claims its key with. */
      poll_token?: string;
      /**
       * @description Present when the key went to a waiting terminal instead of into this response.
       * @enum {string}
       */
      delivered_to?: 'cli';
      account?: {
        /**
         * @description Identifier of a account, prefixed with `acct_`.
         * @example acct_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
         */
        id: string;
        /** @enum {string} */
        object: 'account';
        name: string;
      };
      project?: {
        /**
         * @description Identifier of a project, prefixed with `proj_`.
         * @example proj_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
         */
        id: string;
        /** @enum {string} */
        object: 'project';
        name: string;
        default_timezone: string;
        default_currency: string;
      };
      api_key?: {
        /**
         * @description Identifier of a api_key, prefixed with `key_`.
         * @example key_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
         */
        id: string;
        /** @enum {string} */
        object: 'api_key';
        /** @enum {string} */
        environment: 'test';
        /** @enum {string} */
        kind: 'secret';
        prefix: string;
      };
      /**
       * @description The test key, in clear text. Shown **once**: in the confirm of a browser, or in the first successful claim of a terminal. It is stored as a SHA-256 hash and cannot be shown again.
       * @example sk_test_...
       */
      secret_key?: string;
    };
    Webhook: {
      /**
       * @description Identifier of a webhook, prefixed with `wh_`.
       * @example wh_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'webhook';
      url: string;
      /** @description Subscribed event types. `["*"]` means everything, future types included. */
      events: string[];
      /** @enum {string} */
      status: 'active' | 'failing' | 'disabled';
      description: string | null;
      /** @description Free-form key/value pairs stored with the object and returned untouched. */
      metadata: {
        [key: string]: unknown;
      };
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
    };
    WebhookCreated: components['schemas']['Webhook'] & {
      /**
       * @description The signing secret, shown **once**, in the answer to the request that created the endpoint. Absent from an idempotent replay, and from every other response.
       * @example whsec_...
       */
      secret?: string;
    };
    WebhookDelivery: {
      /**
       * @description Identifier of a webhook_delivery, prefixed with `whd_`.
       * @example whd_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      id: string;
      /** @enum {string} */
      object: 'webhook_delivery';
      /**
       * @description Identifier of a webhook, prefixed with `wh_`.
       * @example wh_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      webhook_id: string;
      /**
       * @description Identifier of a event, prefixed with `evt_`.
       * @example evt_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
       */
      event_id: string;
      /** @enum {string} */
      status: 'pending' | 'succeeded' | 'failed';
      /** @description Attempts started, not attempts left. */
      attempt: number;
      response_status: number | null;
      response_body: string | null;
      error: string | null;
      duration_ms: number | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      scheduled_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      last_attempt_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      next_attempt_at: string | null;
      /**
       * Format: date-time
       * @description Set only while an attempt is in flight; `next_attempt_at` stays the ladder.
       * @example 2026-09-08T07:00:00Z
       */
      leased_until: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      delivered_at: string | null;
      /**
       * @description The environment of the API key that created the object.
       * @enum {string}
       */
      environment: 'test' | 'live';
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      created_at: string | null;
      /**
       * Format: date-time
       * @description ISO 8601 instant in UTC.
       * @example 2026-09-08T07:00:00Z
       */
      updated_at: string | null;
      /** @description Type of the event this delivery carries. Joined in by the listing and by `/test`; absent from the answer of `/retry`. */
      event_type?: string | null;
    };
    WebhookDeliveryList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['WebhookDelivery'][];
      has_more: boolean;
    };
    WebhookList: {
      /** @enum {string} */
      object: 'list';
      data: components['schemas']['Webhook'][];
      has_more: boolean;
    };
  };
  responses: never;
  parameters: {
    BookrailActor: components['schemas']['BookrailActor'];
    BookrailVersion: components['schemas']['BookrailVersion'];
    IdempotencyKey: components['schemas']['IdempotencyKey'];
  };
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  'openapi.get': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['OpenApiDocument'];
        };
      };
    };
  };
  'availability.search': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /**
           * @description Identifier of a service, prefixed with `svc_`.
           * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          service_id: string;
          /**
           * Format: date-time
           * @description ISO 8601 instant with an explicit offset. Any offset is accepted on input; every instant is returned in UTC.
           * @example 2026-09-08T07:00:00Z
           */
          from: string;
          /**
           * Format: date-time
           * @description ISO 8601 instant with an explicit offset. Any offset is accepted on input; every instant is returned in UTC.
           * @example 2026-09-08T07:00:00Z
           */
          to: string;
          quantity?: number;
          resource_ids?: string[];
          /**
           * @description Identifier of a customer, prefixed with `cus_`.
           * @example cus_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          customer_id?: string;
          /**
           * @description IANA time zone name.
           * @example Europe/Rome
           */
          timezone?: string;
          /** @enum {string} */
          granularity?: 'slots' | 'ranges';
          explain?: boolean;
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Availability'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `invalid_range`, `parameter_invalid`, `parameter_missing`, `range_too_large`, `service_without_duration`, `timezone_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'availability.check': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /**
           * @description Identifier of a service, prefixed with `svc_`.
           * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          service_id: string;
          /**
           * Format: date-time
           * @description ISO 8601 instant with an explicit offset. Any offset is accepted on input; every instant is returned in UTC.
           * @example 2026-09-08T07:00:00Z
           */
          start: string;
          duration_minutes?: number;
          quantity?: number;
          resource_ids?: string[];
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AvailabilityCheck'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `invalid_range`, `parameter_invalid`, `parameter_missing`, `range_too_large`, `service_without_duration`, `timezone_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'availability.next': {
    parameters: {
      query: {
        service_id: string;
        from?: string;
        quantity?: string;
        timezone?: string;
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AvailabilityNext'];
        };
      };
      /** @description Error codes: `invalid_range`, `parameter_invalid`, `parameter_missing`, `range_too_large`, `service_without_duration`, `timezone_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'bookings.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
        customer_id?: string;
        resource_id?: string;
        service_id?: string;
        status?:
          | 'held'
          | 'pending'
          | 'confirmed'
          | 'in_progress'
          | 'completed'
          | 'cancelled'
          | 'no_show'
          | 'rescheduled';
        from?: string;
        to?: string;
        'expand[]'?: ('customer' | 'allocations.resource')[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['BookingList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'bookings.create': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /**
           * @description Identifier of a service, prefixed with `svc_`.
           * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          service_id: string;
          /**
           * Format: date-time
           * @description ISO 8601 instant with an explicit offset. Any offset is accepted on input; every instant is returned in UTC.
           * @example 2026-09-08T07:00:00Z
           */
          start: string;
          duration_minutes?: number;
          quantity?: number;
          resource_ids?: string[];
          /**
           * @description Identifier of a customer, prefixed with `cus_`.
           * @example cus_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          customer_id?: string;
          customer?: {
            external_id?: string | null;
            /** Format: email */
            email?: string | null;
            phone?: string | null;
            name?: string | null;
            /**
             * @description IANA time zone name.
             * @example Europe/Rome
             */
            timezone?: string;
            locale?: string | null;
            tenant_id?: string | null;
            /** @description Free-form key/value pairs stored with the object and returned untouched. */
            metadata?: {
              [key: string]: unknown;
            };
          };
          notes?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
          /** @enum {string} */
          source?: 'api' | 'widget' | 'portal' | 'import';
          /**
           * @description Identifier of a hold, prefixed with `hold_`.
           * @example hold_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          hold_id?: string;
          payment?: {
            /** @enum {string} */
            mode: 'none' | 'deposit' | 'full' | 'entitlement';
            entitlement_id?: string | null;
          } | null;
          recurrence?: {
            [key: string]: unknown;
          } | null;
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Booking'];
        };
      };
      /** @description Error codes: `duration_not_offered`, `hold_mismatch`, `idempotency_key_reused`, `invalid_body`, `not_yet_supported`, `parameter_invalid`, `parameter_missing`, `resource_not_eligible`, `service_without_duration`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `hold_expired`, `hold_not_active`, `idempotency_key_in_progress`, `serialization_failure`, `slot_unavailable`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `customer_limit_reached`, `min_notice_violated`, `outside_booking_window`, `start_not_on_grid`. */
      422: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'bookings.get': {
    parameters: {
      query?: {
        'expand[]'?: ('customer' | 'allocations.resource')[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Booking'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'bookings.cancel': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          reason?: string | null;
          /** @enum {string} */
          by?: 'customer' | 'provider' | 'system';
          override_refund_percent?: number | null;
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Booking'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`, `invalid_transition`, `serialization_failure`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `complete_too_early`, `no_show_too_early`. */
      422: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'bookings.check_in': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': Record<string, unknown>;
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Booking'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`, `invalid_transition`, `serialization_failure`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `complete_too_early`, `no_show_too_early`. */
      422: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'bookings.complete': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': Record<string, unknown>;
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Booking'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`, `invalid_transition`, `serialization_failure`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `complete_too_early`, `no_show_too_early`. */
      422: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'bookings.confirm': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': Record<string, unknown>;
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Booking'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`, `invalid_transition`, `serialization_failure`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `complete_too_early`, `no_show_too_early`. */
      422: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'bookings.no_show': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': Record<string, unknown>;
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Booking'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`, `invalid_transition`, `serialization_failure`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `complete_too_early`, `no_show_too_early`. */
      422: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'bookings.reschedule': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /**
           * Format: date-time
           * @description ISO 8601 instant with an explicit offset. Any offset is accepted on input; every instant is returned in UTC.
           * @example 2026-09-08T07:00:00Z
           */
          start: string;
          resource_ids?: string[];
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Booking'];
        };
      };
      /** @description Error codes: `duration_not_offered`, `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `resource_not_eligible`, `service_without_duration`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`, `invalid_transition`, `serialization_failure`, `slot_unavailable`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `complete_too_early`, `customer_limit_reached`, `max_reschedules_reached`, `min_notice_violated`, `no_show_too_early`, `outside_booking_window`, `start_not_on_grid`. */
      422: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'customers.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
        external_id?: string;
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['CustomerList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'customers.create': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          external_id?: string | null;
          /** Format: email */
          email?: string | null;
          phone?: string | null;
          name?: string | null;
          /**
           * @description IANA time zone name.
           * @example Europe/Rome
           */
          timezone?: string;
          locale?: string | null;
          tenant_id?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Customer'];
        };
      };
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Customer'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'customers.get': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Customer'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'customers.delete': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'customers.update': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          external_id?: string | null;
          /** Format: email */
          email?: string | null;
          phone?: string | null;
          name?: string | null;
          /**
           * @description IANA time zone name.
           * @example Europe/Rome
           */
          timezone?: string;
          locale?: string | null;
          tenant_id?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Customer'];
        };
      };
      /** @description Error codes: `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'events.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
        type?: string | string[];
        object_id?: string;
        from?: string;
        to?: string;
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['EventList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'events.get': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Event'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'holds.create': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /**
           * @description Identifier of a service, prefixed with `svc_`.
           * @example svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          service_id: string;
          /**
           * Format: date-time
           * @description ISO 8601 instant with an explicit offset. Any offset is accepted on input; every instant is returned in UTC.
           * @example 2026-09-08T07:00:00Z
           */
          start: string;
          duration_minutes?: number;
          quantity?: number;
          resource_ids?: string[];
          /**
           * @description Identifier of a customer, prefixed with `cus_`.
           * @example cus_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          customer_id?: string;
          customer?: {
            external_id?: string | null;
            /** Format: email */
            email?: string | null;
            phone?: string | null;
            name?: string | null;
            /**
             * @description IANA time zone name.
             * @example Europe/Rome
             */
            timezone?: string;
            locale?: string | null;
            tenant_id?: string | null;
            /** @description Free-form key/value pairs stored with the object and returned untouched. */
            metadata?: {
              [key: string]: unknown;
            };
          };
          notes?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
          /** @enum {string} */
          source?: 'api' | 'widget' | 'portal' | 'import';
          /**
           * @description How long the hold lives, as a duration string (`10m`, `600s`, `1h`). Clamped to 30 minutes by the engine. Defaults to `policy.hold_duration_seconds`.
           * @example 10m
           */
          ttl?: string;
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['HoldCreated'];
        };
      };
      /** @description Error codes: `duration_not_offered`, `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `resource_not_eligible`, `service_without_duration`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`, `serialization_failure`, `slot_unavailable`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `customer_limit_reached`, `min_notice_violated`, `outside_booking_window`, `start_not_on_grid`. */
      422: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'holds.get': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Hold'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'holds.release': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `hold_not_active`, `serialization_failure`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'locations.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['LocationList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'locations.create': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          /**
           * @description IANA time zone name.
           * @example Europe/Rome
           */
          timezone: string;
          address?: {
            [key: string]: unknown;
          } | null;
          tenant_id?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Location'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'locations.get': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Location'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'locations.delete': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'locations.update': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name?: string;
          /**
           * @description IANA time zone name.
           * @example Europe/Rome
           */
          timezone?: string;
          address?: {
            [key: string]: unknown;
          } | null;
          tenant_id?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Location'];
        };
      };
      /** @description Error codes: `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'policies.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PolicyList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'policies.create': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          cancellation?: {
            /**
             * @description How long before the start the tier applies, as a duration: seconds, minutes, hours or days.
             * @example 24h
             */
            before: string;
            refund_percent?: number;
            fee?: number;
          }[];
          reschedule?: {
            /**
             * @description How long before the start the tier applies, as a duration: seconds, minutes, hours or days.
             * @example 24h
             */
            before: string;
            refund_percent?: number;
            fee?: number;
          }[];
          deposit?: {
            /** @enum {string} */
            type: 'percent' | 'fixed';
            value: number;
            /** @enum {string} */
            due?: 'at_booking';
          } | null;
          /** @enum {string} */
          payment_timing?: 'at_booking' | 'before_start' | 'after_service' | 'none';
          payment_deadline?: string | null;
          no_show?: {
            charge_percent?: number;
            grace_minutes?: number;
            auto_mark?: boolean;
            mark_after?: string;
          } | null;
          hold_duration_seconds?: number;
          max_active_bookings_per_customer?: number | null;
          require_customer_confirmation?: boolean;
          require_provider_confirmation?: boolean;
          auto_start?: boolean;
          auto_complete?: boolean;
          max_reschedules?: number | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Policy'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'policies.get': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Policy'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'policies.delete': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'policies.update': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name?: string;
          cancellation?: {
            /**
             * @description How long before the start the tier applies, as a duration: seconds, minutes, hours or days.
             * @example 24h
             */
            before: string;
            refund_percent?: number;
            fee?: number;
          }[];
          reschedule?: {
            /**
             * @description How long before the start the tier applies, as a duration: seconds, minutes, hours or days.
             * @example 24h
             */
            before: string;
            refund_percent?: number;
            fee?: number;
          }[];
          deposit?: {
            /** @enum {string} */
            type: 'percent' | 'fixed';
            value: number;
            /** @enum {string} */
            due?: 'at_booking';
          } | null;
          /** @enum {string} */
          payment_timing?: 'at_booking' | 'before_start' | 'after_service' | 'none';
          payment_deadline?: string | null;
          no_show?: {
            charge_percent?: number;
            grace_minutes?: number;
            auto_mark?: boolean;
            mark_after?: string;
          } | null;
          hold_duration_seconds?: number;
          max_active_bookings_per_customer?: number | null;
          require_customer_confirmation?: boolean;
          require_provider_confirmation?: boolean;
          auto_start?: boolean;
          auto_complete?: boolean;
          max_reschedules?: number | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Policy'];
        };
      };
      /** @description Error codes: `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'project.get': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Project'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resource_groups.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
        'expand[]'?: 'resources'[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ResourceGroupList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resource_groups.create': {
    parameters: {
      query?: {
        'expand[]'?: 'resources'[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          selector?: {
            [key: string]: unknown;
          } | null;
          /** @enum {string} */
          allocation_strategy?: 'least_busy' | 'round_robin' | 'first_available' | 'priority';
          resource_ids?: string[];
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ResourceGroup'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resource_groups.get': {
    parameters: {
      query?: {
        'expand[]'?: 'resources'[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ResourceGroup'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resource_groups.delete': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resource_groups.update': {
    parameters: {
      query?: {
        'expand[]'?: 'resources'[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name?: string;
          selector?: {
            [key: string]: unknown;
          } | null;
          /** @enum {string} */
          allocation_strategy?: 'least_busy' | 'round_robin' | 'first_available' | 'priority';
          resource_ids?: string[];
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ResourceGroup'];
        };
      };
      /** @description Error codes: `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resources.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
        'expand[]'?: 'schedule'[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ResourceList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resources.create': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          type?: string;
          /**
           * @description Identifier of a location, prefixed with `loc_`.
           * @example loc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          location_id?: string;
          /**
           * @description Identifier of a schedule, prefixed with `sch_`.
           * @example sch_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          schedule_id?: string;
          capacity?: number;
          attributes?: {
            [key: string]: unknown;
          };
          /** @enum {string} */
          status?: 'active' | 'inactive';
          tenant_id?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Resource'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resources.get': {
    parameters: {
      query?: {
        'expand[]'?: 'schedule'[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Resource'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resources.delete': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resources.update': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name?: string;
          type?: string;
          /**
           * @description Identifier of a location, prefixed with `loc_`.
           * @example loc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          location_id?: string;
          /**
           * @description Identifier of a schedule, prefixed with `sch_`.
           * @example sch_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          schedule_id?: string;
          capacity?: number;
          attributes?: {
            [key: string]: unknown;
          };
          /** @enum {string} */
          status?: 'active' | 'inactive';
          tenant_id?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Resource'];
        };
      };
      /** @description Error codes: `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `slot_unavailable`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resources.block': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /**
           * Format: date-time
           * @description ISO 8601 instant with an explicit offset. Any offset is accepted on input; every instant is returned in UTC.
           * @example 2026-09-08T07:00:00Z
           */
          from: string;
          /**
           * Format: date-time
           * @description ISO 8601 instant with an explicit offset. Any offset is accepted on input; every instant is returned in UTC.
           * @example 2026-09-08T07:00:00Z
           */
          to: string;
          reason?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ResourceBlock'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`, `slot_unavailable`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resources.blocks.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
        from?: string;
        to?: string;
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ResourceBlockList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'resources.unblock': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /**
           * @description Identifier of a resource_block, prefixed with `blk_`.
           * @example blk_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          block_id: string;
        };
      };
    };
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'schedules.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ScheduleList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'schedules.create': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          /**
           * @description IANA time zone name.
           * @example Europe/Rome
           */
          timezone?: string;
          rules?: {
            days_of_week: number[];
            /**
             * @description Local time of day, `HH:MM` or `HH:MM:SS`.
             * @example 09:00
             */
            start_time: string;
            /**
             * @description Local time of day, `HH:MM` or `HH:MM:SS`.
             * @example 09:00
             */
            end_time: string;
            /**
             * Format: date
             * @description Calendar date, `YYYY-MM-DD`.
             * @example 2026-09-08
             */
            valid_from?: string | null;
            /**
             * Format: date
             * @description Calendar date, `YYYY-MM-DD`.
             * @example 2026-09-08
             */
            valid_until?: string | null;
          }[];
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Schedule'] & Record<string, unknown>;
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'schedules.get': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Schedule'] & Record<string, unknown>;
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'schedules.delete': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'schedules.update': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name?: string;
          /**
           * @description IANA time zone name.
           * @example Europe/Rome
           */
          timezone?: string;
          rules?: {
            days_of_week: number[];
            /**
             * @description Local time of day, `HH:MM` or `HH:MM:SS`.
             * @example 09:00
             */
            start_time: string;
            /**
             * @description Local time of day, `HH:MM` or `HH:MM:SS`.
             * @example 09:00
             */
            end_time: string;
            /**
             * Format: date
             * @description Calendar date, `YYYY-MM-DD`.
             * @example 2026-09-08
             */
            valid_from?: string | null;
            /**
             * Format: date
             * @description Calendar date, `YYYY-MM-DD`.
             * @example 2026-09-08
             */
            valid_until?: string | null;
          }[];
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Schedule'] & Record<string, unknown>;
        };
      };
      /** @description Error codes: `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'schedules.exceptions.create': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /**
           * Format: date
           * @description Calendar date, `YYYY-MM-DD`.
           * @example 2026-09-08
           */
          date: string;
          /** @enum {string} */
          type: 'closed' | 'open';
          /**
           * @description Local time of day, `HH:MM` or `HH:MM:SS`.
           * @example 09:00
           */
          start_time?: string | null;
          /**
           * @description Local time of day, `HH:MM` or `HH:MM:SS`.
           * @example 09:00
           */
          end_time?: string | null;
          reason?: string | null;
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ScheduleException'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'schedules.exceptions.delete': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
        eid: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'services.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
        'expand[]'?: 'requirements'[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ServiceList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'services.create': {
    parameters: {
      query?: {
        'expand[]'?: 'requirements'[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          description?: string | null;
          duration?: number;
          duration_options?: number[];
          duration_range?: {
            min: number;
            max: number;
          };
          capacity_per_booking?: number;
          buffer_before?: number;
          buffer_after?: number;
          slot_interval?: number | null;
          /** @enum {string|null} */
          align_to?: 'hour' | 'half_hour' | 'schedule_start' | null;
          price?: {
            amount: number;
            /**
             * @description Three letter ISO 4217 currency code.
             * @example EUR
             */
            currency: string;
          } | null;
          pricing_rules?: {
            when: {
              days?: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[];
              time_from?: string;
              time_to?: string;
              date_from?: string;
              date_to?: string;
              resource_id?: string;
              duration_min?: number;
            };
            price?: number;
            price_add?: number;
            price_multiplier?: number;
            label?: string;
          }[];
          /**
           * @description Identifier of a policy, prefixed with `pol_`.
           * @example pol_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          policy_id?: string;
          booking_window?: {
            min_notice_minutes?: number;
            max_advance_days?: number;
          } | null;
          allow_recurring?: boolean;
          allow_multi_day?: boolean;
          buffer_sharing?: boolean;
          allow_split?: boolean;
          requirements?: {
            /**
             * @description Identifier of a resource, prefixed with `res_`.
             * @example res_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
             */
            resource_id?: string;
            /**
             * @description Identifier of a resource_group, prefixed with `rg_`.
             * @example rg_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
             */
            resource_group_id?: string;
            quantity?: number;
            /** @enum {string} */
            consumes?: 'per_unit' | 'whole';
            role?: string | null;
          }[];
          tenant_id?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Service'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'services.get': {
    parameters: {
      query?: {
        'expand[]'?: 'requirements'[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Service'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'services.delete': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'services.update': {
    parameters: {
      query?: {
        'expand[]'?: 'requirements'[];
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name?: string;
          description?: string | null;
          duration?: number;
          duration_options?: number[];
          duration_range?: {
            min: number;
            max: number;
          };
          capacity_per_booking?: number;
          buffer_before?: number;
          buffer_after?: number;
          slot_interval?: number | null;
          /** @enum {string|null} */
          align_to?: 'hour' | 'half_hour' | 'schedule_start' | null;
          price?: {
            amount: number;
            /**
             * @description Three letter ISO 4217 currency code.
             * @example EUR
             */
            currency: string;
          } | null;
          pricing_rules?: {
            when: {
              days?: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[];
              time_from?: string;
              time_to?: string;
              date_from?: string;
              date_to?: string;
              resource_id?: string;
              duration_min?: number;
            };
            price?: number;
            price_add?: number;
            price_multiplier?: number;
            label?: string;
          }[];
          /**
           * @description Identifier of a policy, prefixed with `pol_`.
           * @example pol_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
           */
          policy_id?: string;
          booking_window?: {
            min_notice_minutes?: number;
            max_advance_days?: number;
          } | null;
          allow_recurring?: boolean;
          allow_multi_day?: boolean;
          buffer_sharing?: boolean;
          allow_split?: boolean;
          requirements?: {
            /**
             * @description Identifier of a resource, prefixed with `res_`.
             * @example res_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
             */
            resource_id?: string;
            /**
             * @description Identifier of a resource_group, prefixed with `rg_`.
             * @example rg_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c
             */
            resource_group_id?: string;
            quantity?: number;
            /** @enum {string} */
            consumes?: 'per_unit' | 'whole';
            role?: string | null;
          }[];
          tenant_id?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Service'];
        };
      };
      /** @description Error codes: `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'signups.create': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /**
           * Format: email
           * @example you@example.com
           */
          email: string;
          /**
           * @description Where the request came from. `cli` waits for the key on a poll; `web` is handed it in the confirm response.
           * @enum {string}
           */
          client: 'cli' | 'web';
          account_name?: string;
          project_name?: string;
          /**
           * @description IANA time zone name.
           * @example Europe/Rome
           */
          default_timezone?: string;
          /**
           * @description Three letter ISO 4217 currency code.
           * @example EUR
           */
          default_currency?: string;
        };
      };
    };
    responses: {
      /** @description Success. */
      202: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Signup'];
        };
      };
      /** @description Error codes: `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `signup_rate_limited`. */
      429: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `signup_email_failed`. */
      502: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `signup_disabled`. */
      503: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'signups.confirm': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /** @description The token from the confirmation link, taken out of its `#token=` fragment. */
          token: string;
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Signup'];
        };
      };
      /** @description Error codes: `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `signup_not_found`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `signup_already_confirmed`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `signup_expired`. */
      410: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `signup_disabled`. */
      503: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'signups.claim': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /** @description The `poll_token` returned when the sign up was created. */
          poll_token: string;
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Signup'];
        };
      };
      /** @description Error codes: `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`, `signup_not_found`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `signup_secret_claimed`, `signup_secret_expired`. */
      410: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `signup_disabled`. */
      503: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'webhooks.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WebhookList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'webhooks.create': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          url: string;
          events?: string[];
          description?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Created. */
      201: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WebhookCreated'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `invalid_webhook_url`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'webhooks.get': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Webhook'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'webhooks.delete': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deleted'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'webhooks.update': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          url?: string;
          events?: string[];
          /** @enum {string} */
          status?: 'active' | 'disabled';
          description?: string | null;
          /** @description Free-form key/value pairs stored with the object and returned untouched. */
          metadata?: {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Webhook'];
        };
      };
      /** @description Error codes: `invalid_body`, `invalid_webhook_url`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'webhooks.deliveries.list': {
    parameters: {
      query?: {
        limit?: number;
        starting_after?: string;
        status?: 'pending' | 'succeeded' | 'failed';
        event_id?: string;
      };
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WebhookDeliveryList'];
        };
      };
      /** @description Error codes: `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'webhooks.deliveries.retry': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
        did: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': Record<string, unknown>;
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WebhookDelivery'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `delivery_too_old`, `idempotency_key_in_progress`, `webhook_disabled`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  'webhooks.test': {
    parameters: {
      query?: never;
      header?: {
        'Bookrail-Version'?: components['parameters']['BookrailVersion'];
        'Bookrail-Actor'?: components['parameters']['BookrailActor'];
        'Idempotency-Key'?: components['parameters']['IdempotencyKey'];
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': Record<string, unknown>;
      };
    };
    responses: {
      /** @description Success. */
      200: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          'Idempotent-Replayed'?: string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WebhookDelivery'];
        };
      };
      /** @description Error codes: `idempotency_key_reused`, `invalid_body`, `parameter_invalid`, `parameter_missing`, `unsupported_api_version`. */
      400: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `invalid_api_key`, `invalid_authorization_header`, `missing_api_key`, `revoked_api_key`. */
      401: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `resource_missing`. */
      404: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `idempotency_key_in_progress`, `webhook_disabled`. */
      409: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Error codes: `internal_error`. */
      500: {
        headers: {
          'Bookrail-Request-Id': string;
          'Bookrail-Version': string;
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
}
