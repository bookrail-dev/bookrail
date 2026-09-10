---
title: 'Idempotency'
description: 'How Idempotency-Key works on every POST, why the key is taken rather than checked, what a retry gets back, and how to choose a key.'
sidebar:
  order: 43
---

Every `POST` under `/v1` accepts an `Idempotency-Key` header. Send one and a retry of that
request cannot produce a second booking, whatever happened to the first response.

This is not a convenience. A booking API without it is a booking API that double books every
time a mobile connection drops at the wrong moment, which is often.

## Use it

```bash
curl -s https://api.bookrail.dev/v1/bookings \
  -H "Authorization: Bearer $BOOKRAIL_SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-4711' \
  -d '{"service_id":"svc_...","start":"2026-09-16T06:00:00Z","duration_minutes":60,
       "customer":{"email":"ada@example.com"}}'
```

Send it again and the response is byte for byte the first one, with a header saying so:

```
HTTP/2 201
bookrail-request-id: req_2b119f20e3bc04f555dacee3
bookrail-version: 2026-09-01
idempotent-replayed: true
```

The SDK does it for you. Every `POST` carries a key; if you do not pass one, one is generated
and **the same one** is sent on every retry of that call, which is exactly what makes retrying
a POST safe:

```ts
await bookrail.bookings.create(params, { idempotencyKey: order.id });
```

The CLI carries one on every `POST` too, so `bookrail bookings create` run twice by a nervous
operator does not book twice, as long as the retry is the same command.

## Why it actually holds

The common implementation is "look the key up, and if it is not there, do the work". That has a
race exactly as wide as the lookup, and under real concurrency two retries land in it.

Bookrail **takes** the key instead: an `INSERT` under a unique constraint, before any work
runs. The database decides who owns the key. Twenty simultaneous requests carrying one key
produce one booking and nineteen replays or `409 idempotency_key_in_progress`, and that is a
test with twenty real clients, not an argument.

```
packages/api/test/idempotency.test.ts
  lets exactly one of twenty concurrent requests with one key create a booking
```

## What a retry gets back

| Situation | What happens |
| --- | --- |
| First request succeeded | The stored response, with `Idempotent-Replayed: true` |
| First request failed with a 4xx | The same 4xx, replayed verbatim |
| First request is still running | `409 idempotency_key_in_progress`. Wait and retry |
| Same key, different body | `400 idempotency_key_reused` |
| Same key, different endpoint | `400 idempotency_key_reused` |
| First request 5xx'd **after** committing | The same 500, replayed. The key is not released |
| First request 5xx'd with nothing committed | The key is released, so the retry does the work |

That last pair is the subtle one. Releasing a key after a failure sounds generous, and it is
correct only when nothing was written. When a request committed a booking and then fell over
formatting the response, releasing the key would let the retry book a second time. So the rule
is: **the key is freed only if no effect was committed**, and a 5xx after a commit is stored
and replayed forever after.

Keys expire after 24 hours, and an hourly job removes the expired ones. They are scoped to the
project and to the environment, so a test key and a live key never collide.

## Choosing a key

- **Use an identifier that already exists in your system**: the order id, the cart id, the row
  id of the intent. A key that is regenerated on retry is not a key.
- **One key, one request.** Do not reuse a key for a different body, and do not reuse it across
  endpoints: both are a `400`, and deliberately, because it almost always means the caller
  thinks it is retrying something it is not.
- **A UUID is fine** when there is nothing better, as long as you keep it for the whole life of
  the retry loop. That is what the SDK does.
- Surrounding whitespace is trimmed, an empty key is refused, and an over long one is refused,
  with no row written for either.

## What idempotency is not

- **It is not a lock on a slot.** Two different keys for the same slot are two different
  requests, and the second gets `409 slot_unavailable` if the capacity has gone. If you need
  to hold a slot while a customer fills in a form, that is a [hold](/docs/concepts/#hold-a-short-lease-on-capacity).
- **It does not make a `GET` safe to repeat.** Reads are already repeatable, and the header is
  simply harmless there. It is accepted on `POST /v1/availability`, which is a read spelled as
  a POST because the query does not fit in a URL.
- **It is not deduplication of webhooks.** That is `Bookrail-Event-Id`, on the receiving side.
  See [Webhooks](/docs/guides/webhooks/).

## When to retry at all

The SDK retries `429`, every `5xx`, connection failures, timeouts, and the two `409` codes that
mean "come back in a moment": `idempotency_key_in_progress` and `serialization_failure`. It
never retries any other `4xx`, and never after your own `AbortSignal` fired. The backoff is
0.5 s, 1 s, 2 s, 4 s, 8 s with 25 percent jitter, and a `Retry-After` header wins.

If you are writing your own client, copy that list. Retrying a `400` is how a retry loop turns
one bad request into a thousand.
</content>
