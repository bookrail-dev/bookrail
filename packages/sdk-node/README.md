# `@bookrail/node`

The Bookrail SDK for TypeScript and JavaScript. Types generated from the OpenAPI specification
of the API, one hand-written idiomatic layer on top: retries with backoff, automatic idempotency
on every POST, cursor pagination as an async iterator, typed errors, and webhook signature
verification.

- **One runtime dependency**: `@bookrail/webhook-signature`, which itself has none.
- **ESM only.** There is no CommonJS build. `require('@bookrail/node')` will not work; use
  `import`, or `await import()` from CommonJS.
- Node 20.10 or newer, Deno, Bun, Cloudflare Workers, Vercel edge. Only
  `webhooks.constructEvent` needs `node:crypto`; everything else runs on the global `fetch` and
  the Web Crypto API.

```bash
npm install @bookrail/node
```

## Quick start

```ts
import Bookrail from '@bookrail/node';

const bookrail = new Bookrail(process.env.BOOKRAIL_SECRET_KEY!);

const { slots } = await bookrail.availability.list({
  service_id: 'svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c',
  from: '2026-09-08T00:00:00+02:00',
  to: '2026-09-15T00:00:00+02:00',
  timezone: 'Europe/Rome',
});

const booking = await bookrail.bookings.create(
  {
    service_id: 'svc_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c',
    start: slots[0].start,
    customer: { email: 'anna@example.com', name: 'Anna' },
  },
  { idempotencyKey: order.id },
);

await bookrail.bookings.confirm(booking.id);
```

### The field names are the API's

Data is `snake_case` (`service_id`, `duration_minutes`), because that is what the API sends and
receives. A renaming layer would be one more place to get it wrong, would make the API reference
unusable next to the SDK, and would have to be reinvented in every other language. Methods and
namespaces are `camelCase` (`bookrail.resourceGroups.list()`), because those are ours.

Every instant is ISO 8601 with an explicit offset in, and UTC out. A bare date (`2026-09-11`) is
not an instant: midnight is not the same moment in every time zone, and the API refuses it.

## Configuration

```ts
const bookrail = new Bookrail(process.env.BOOKRAIL_SECRET_KEY!, {
  baseUrl: 'https://api.bookrail.dev', // default
  apiVersion: '2026-09-01',            // default: the version the specification declares
  timeoutMs: 30_000,                   // per attempt
  maxRetries: 2,                       // extra attempts after the first
  fetch: myFetch,                      // injectable
  actor: 'sdk',                        // default; pass `undefined` to send no Bookrail-Actor
});
```

The key must start with `sk_test_` or `sk_live_`; anything else throws **synchronously** at
construction. `bookrail.environment` is `'test'` or `'live'`, decided by that prefix and by
nothing else. Publishable `pk_` keys belong to the browser SDK, which does not exist yet.

`actor` is sent as `Bookrail-Actor` and recorded as `actor.via` on every event the request
writes, so a booking made by this SDK can be told from one made by the CLI or the dashboard at
equal API key.

## Every call takes request options

```ts
await bookrail.bookings.create(params, {
  idempotencyKey: 'order-4711',
  timeoutMs: 5_000,
  maxRetries: 0,
  expand: ['customer', 'allocations.resource'],
  signal: controller.signal,
  headers: { 'X-Trace-Id': traceId },
});
```

## Retries and idempotency

Every `POST` carries an `Idempotency-Key`. If you do not pass one, the SDK generates a UUID and
sends **the same one** on every retry of that call. That is what makes retrying a POST safe:
the API replays the first response instead of booking again.

Retried: `429`, every `5xx`, connection failures, timeouts, and the two `409` codes that mean
"come back in a moment" (`idempotency_key_in_progress`, `serialization_failure`). Never retried:
any other `4xx`, and an abort through your own `AbortSignal`.

The backoff is 0.5 s, 1 s, 2 s, 4 s, 8 s, capped, with ±25 % jitter. A `Retry-After` header wins,
in seconds or as an HTTP date; longer than a minute and the call fails instead of blocking.

```ts
const { data, response } = await bookrail.bookings.create(params).withResponse();
response.status;             // 201
response.requestId;          // 'req_…', quote it to support
response.idempotentReplayed; // true when the API replayed a stored answer
response.retries;            // how many extra attempts it took
```

## Pagination

```ts
const page = await bookrail.bookings.list({ status: 'confirmed', limit: 50 });
page.data;            // this page
page.has_more;
await page.nextPage();

// or every page, following the cursor for you
for await (const booking of bookrail.bookings.list({ status: 'confirmed' })) {
  console.log(booking.id);
}
```

`limit` is per page, not a total. The cursor is the `id` of the last object of a page; filters
and `expand` travel with it.

## Errors

```ts
import { BookrailConflictError, BookrailError } from '@bookrail/node';

try {
  await bookrail.bookings.create(params);
} catch (error) {
  if (error instanceof BookrailConflictError) {
    // the slot went while you were deciding
  } else if (error instanceof BookrailError) {
    error.type;      // 'conflict' | 'invalid_request' | 'not_found' | …
    error.code;      // 'slot_unavailable'
    error.param;     // the field it is about, when there is one
    error.fix;       // what to do next, when the API had one thing to say
    error.docUrl;
    error.requestId;
    error.status;
    error.headers;
  }
}
```

One class per family: `BookrailInvalidRequestError`, `BookrailAuthenticationError`,
`BookrailPermissionError`, `BookrailNotFoundError`, `BookrailConflictError`,
`BookrailRateLimitError`, `BookrailPolicyViolationError`, `BookrailPaymentRequiredError`,
`BookrailInternalError`, plus `BookrailConnectionError` (network, timeout, abort) and
`BookrailSignatureVerificationError`.

**`rate_limited`.** Every API key has a ceiling: 20 requests a second with bursts of 40 on a
`sk_test_` key, 100 a second with bursts of 500 on a `sk_live_` one. Every response carries
`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (whole seconds), so you can pace
yourself before you run out, and a refusal is a `429 rate_limited` with `Retry-After`. **This
client already waits for you**: a `429` is retried after the `Retry-After` the server sent, up to
`maxRetries` times, so you only see `BookrailRateLimitError` when the retries are spent or when
you asked for none. Its `fix` says what to do, and `error.headers['retry-after']` says when.

## Webhooks

```ts
import Bookrail, { BookrailSignatureVerificationError } from '@bookrail/node';

app.post('/hooks/bookrail', express.raw({ type: 'application/json' }), (request, response) => {
  let event;
  try {
    event = bookrail.webhooks.constructEvent(
      request.body,                                 // the RAW bytes, never a re-encoded object
      request.headers['bookrail-signature'],
      process.env.BOOKRAIL_WEBHOOK_SECRET!,
    );
  } catch (error) {
    if (error instanceof BookrailSignatureVerificationError) return response.sendStatus(400);
    throw error;
  }

  if (event.type === 'booking.created') { /* … */ }
  response.sendStatus(200);
});
```

Pass the body exactly as it arrived. Two JSON encoders disagree about key order and whitespace,
so a body that was parsed and re-encoded will not verify. Deduplicate on `Bookrail-Event-Id`:
delivery is at-least-once.

`constructEvent` is the only part of this package that reaches `node:crypto`, through
`@bookrail/webhook-signature`. Everything else runs where Node built-ins do not exist.

## What is in the box

`project`, `availability`, `locations`, `resources` (with `resources.blocks`), `resourceGroups`,
`schedules` (with `schedules.exceptions`), `services`, `policies`, `customers`, `holds`,
`bookings`, `events`, `webhooks` (with `webhooks.deliveries`), `stripe`, and `openapi`. One method per
operation of the API: `create`, `list`, `retrieve`, `update`, `del`, plus the actions
(`bookings.confirm`, `bookings.noShow`, `resources.block`, `webhooks.test`, …).

`del`, not `delete`: `delete` is legal as a method name in JavaScript but reads as the operator
at a glance, and `del` is what the Node SDKs of this shape have called it for a decade.

## Stripe

`bookrail.stripe.connect()` returns a link a **person** opens to authorise their own Stripe
account; nothing is connected until they do. `bookrail.stripe.retrieve()` says whether one is,
which account it is, and the platform publishable key to initialise Stripe.js with, together
with `{ stripeAccount: account_id }`. `bookrail.stripe.disconnect()` revokes it. No method takes
a Stripe key, because Bookrail never receives one.

## Payments

```ts
const booking = await bookrail.bookings.create({
  service_id: 'svc_...',
  start: '2026-10-05T09:00:00+02:00',
  payment: { mode: 'deposit' }, // 'none' | 'deposit' | 'full'
});
// booking.status === 'pending' and booking.payment_intent carries what a front end needs:
//   loadStripe(publishable_key, { stripeAccount }) and then the client_secret.

const payment = await bookrail.payments.retrieve(booking.payment_intent!.payment_id);
for await (const row of bookrail.payments.list({ booking_id: booking.id })) { /* ... */ }
```

The `client_secret` is returned **once** and is stored nowhere: an idempotent replay answers the
same booking with `client_secret: null`, and `payments.retrieve` reads it back from Stripe. The
booking is cancelled automatically at `payment_expires_at` if nobody pays.

`payments` has two methods and no third: a payment is created by `bookings.create`, and a refund
by `bookings.cancel`, which follows the policy the customer agreed to.

## Not here yet

A CommonJS build, opt-in telemetry, structured logging, and `@bookrail/browser` with publishable
keys. In payments: a deferred balance, saved cards, charging a no-show, asking for a refund
through the API rather than through a cancellation, and rescheduling a booking that has money on
it (`422 reschedule_not_supported`).

## Documentation

- [Quickstart](https://bookrail.dev/docs/quickstart/), timed against the production API.
- [Concepts](https://bookrail.dev/docs/concepts/): the data model, with figures.
- [API reference](https://bookrail.dev/docs/api/reference/): 73 operations, generated from
  the executable contract, `packages/api/openapi/openapi.json`, which this package's types are
  generated from too.
- [Idempotency](https://bookrail.dev/docs/guides/idempotency/) and
  [Webhooks](https://bookrail.dev/docs/guides/webhooks/).

## Status

Early access. The API is live at `https://api.bookrail.dev`, **keys are self service**
(`npx bookrail signup`, or [bookrail.dev/signup](https://bookrail.dev/signup), hands you a test
key and a live key on the free plan, and [bookrail.dev/dashboard](https://bookrail.dev/dashboard/)
makes and revokes more), and this package is on npm as
[`@bookrail/node`](https://www.npmjs.com/package/@bookrail/node), Apache 2.0, with its source in
[github.com/bookrail-dev/bookrail](https://github.com/bookrail-dev/bookrail) under
`packages/sdk-node`.

## Licence

Apache-2.0.
