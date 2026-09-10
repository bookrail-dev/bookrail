---
title: 'Webhooks'
description: 'Register an endpoint, verify the signature, understand the retry ladder, replay a delivery, and the SSRF rule that decides which URLs are allowed.'
sidebar:
  order: 42
---

Every change in a project writes an event, in the same transaction that made the change. A
webhook endpoint turns those events into signed POSTs. This page is the whole of it: register,
verify, retry, replay, and the rule about which URLs are allowed to exist.

## Register an endpoint

```bash
npx bookrail webhooks create \
  --url https://example.com/hooks/bookrail \
  --events booking.created --events booking.cancelled
```

```
[test] created wh_01a0804128b974cba21b5c55d26fe2f1 -> https://example.com/hooks/bookrail
subscribed to: booking.created, booking.cancelled

signing secret: whsec_...

This is the only time the secret is shown. It is stored encrypted and no endpoint will
ever return it again. If you lose it, the only remedy is to create another endpoint.
Put it in your receiver now (BOOKRAIL_WEBHOOK_SECRET) and verify every delivery against it.
```

Over HTTP the same call is `POST /v1/webhooks` with `url` and `events`. `*` subscribes to
everything; `webhook.*` is refused, because an endpoint that is told about its own failures
would be told by the mechanism that is failing.

The secret is shown once, in the creation response, and encrypted at rest. No serializer has a
branch that can emit it again, which is a test rather than a convention
(`packages/api/test/webhook-secrets.test.ts`). Losing it means creating another endpoint.

An endpoint has a `status`: `active`, `failing` or `disabled`. You can set `disabled`, and you
cannot set `failing`: that one is the system's opinion, not yours.

## What a delivery looks like

```
POST /hooks/bookrail HTTP/1.1
Content-Type: application/json
Bookrail-Signature: t=1789012345,v1=6f1c...
Bookrail-Event-Id: evt_01a08041defd7583b1ea5f6e378e9e23
Bookrail-Webhook-Id: wh_01a0804128b974cba21b5c55d26fe2f1
Bookrail-Delivery-Id: whd_...
```

The body is the event object: `id`, `type`, `created_at`, `actor`, and
`data: { object, previous }`. `previous` carries the fields that changed, so a consumer can
tell a confirmation from a reschedule without keeping its own history.

Two headers matter operationally. `Bookrail-Event-Id` is what you deduplicate on: delivery is
**at least once**. `Bookrail-Delivery-Id` is what you quote when you ask why an attempt behaved
the way it did.

## Verify the signature

`Bookrail-Signature` is `t=<unix seconds>,v1=<hex>`, and `v1` is
`HMAC-SHA256(secret, "<t>.<raw body>")`.

The timestamp is inside the signed payload deliberately. Without it a signature is valid
forever and a captured delivery can be replayed at any point in the future; with it, a receiver
that also checks the age of `t` has a bounded window. The default tolerance is 300 seconds, in
both directions, because clock skew is symmetric.

```bash
npm install @bookrail/webhook-signature
```

```ts
import express from 'express';
import { verifySignature } from '@bookrail/webhook-signature';

app.post('/hooks/bookrail', express.raw({ type: 'application/json' }), (request, response) => {
  const ok = verifySignature(
    request.body.toString('utf8'),                 // the raw bytes, as they arrived
    request.get('Bookrail-Signature'),
    process.env.BOOKRAIL_WEBHOOK_SECRET!,
  );
  if (!ok) return response.sendStatus(400);

  const event = JSON.parse(request.body.toString('utf8'));
  // Deduplicate on event.id, then act.
  response.sendStatus(200);
});
```

With `@bookrail/node` the same thing is `bookrail.webhooks.constructEvent(rawBody, header,
secret)`, which verifies and parses in one call and throws
`BookrailSignatureVerificationError` when it does not match.

Three rules that account for most of the failures people hit:

1. **Pass the raw bytes.** A body that was parsed and re-encoded will not verify: two JSON
   encoders disagree about key order and whitespace. In Express that means `express.raw`, not
   `express.json`.
2. **`verifySignature` returns `false`, it never throws.** A verifier that throws on a malformed
   header turns a forged request into a 500 instead of a 400, so this one does not.
3. **The comparison is constant time**, and a header may carry several `v1=` values so that a
   secret can be rotated without a window of failures. The verifier accepts if any of them
   matches the secret you hold. Bookrail does not rotate secrets yet, but the receiver you
   deploy today keeps working on the day it does.

The package has **zero runtime dependencies** and reaches only `node:crypto`.

## Watch deliveries land, locally

```bash
npx bookrail webhooks listen --url https://<your tunnel> --port 4100
```

With a public URL the CLI registers a temporary endpoint pointed at it, listens on the local
port, verifies every signature it receives, and deletes the endpoint when the command exits
(`--keep` leaves it). It does not open the tunnel: use `ngrok`, `cloudflared` or whatever you
already have.

Without a URL it polls the event log instead, and says so rather than pretending:

```
[test] no --url given, so nothing was registered: following the event log instead.
The objects below are exactly what a delivery would have carried, byte for byte, but no
endpoint was called and no signature was produced.
[test] following the event log every 2s. Ctrl-C to stop.
2026-09-08T09:03:15.475Z  booking.cancelled      bk_01a0804124a974cfb34faa100c8dc6cf
[test] stopped (max) after 1 event(s).
```

## Retries

A delivery succeeds on any `2xx`. A `3xx` is a failure and no redirect is followed. Everything
else, timeouts included, goes onto a fixed ladder:

| Attempt | After |
| --- | --- |
| 1 | immediately |
| 2 | 3 s |
| 3 | 30 s |
| 4 | 5 min |
| 5 | 30 min |
| 6 | 2 h |
| 7 | 12 h |
| 8 | 24 h |

After the eighth the delivery is `failed`, the endpoint moves to `failing`, and a
`webhook.failing` event is written. That event is never delivered to anybody, for the obvious
reason. A delivery that succeeds later brings the endpoint back to `active`.

The request timeout is 10 seconds, and deliveries of one tick go out in parallel, so one slow
receiver does not hold up anyone else's.

Answer quickly and do the work afterwards. A receiver that books a table, sends an email and
charges a card before returning 200 will time out and be retried, and then it will do all three
again.

## Replay, and the delivery log

```bash
npx bookrail webhooks deliveries wh_01a0804128b974cba21b5c55d26fe2f1
npx bookrail webhooks retry wh_01a0804128b974cba21b5c55d26fe2f1 whd_...
```

`GET /v1/webhooks/{id}/deliveries` lists attempts with their status, response code, duration
and next attempt; `POST /v1/webhooks/{id}/deliveries/{did}/retry` sends one again. There is no
30 day archive and no replay of a whole time range: there are eight attempts across 24 hours,
and a manual retry.

## Exactly once does not exist, and here is what does

- **No event is skipped.** The outbox reads the log on a `(txid, seq)` cursor and only past the
  oldest running transaction, so an event committed by a slow writer cannot be jumped over by a
  fast one.
- **No event is delivered twice to one endpoint by the sender.** A unique constraint on
  `(webhook_id, event_id)` makes it impossible whatever the outbox does.
- **A delivery can still arrive twice at your door**, because the network exists and a timeout
  after your handler committed looks exactly like a failure. Deduplicate on
  `Bookrail-Event-Id`.
- **Order across endpoints is not promised.** Treat a delivery as "this object changed, here it
  is", not as a delta to apply.

## Which URLs are allowed

An endpoint URL must resolve to a public address, and that is checked **at delivery time**, not
only at registration. The DNS is resolved when the POST is about to be made and the connection
is pinned to the addresses that were verified, which closes the rebinding window that a plain
`fetch` leaves open. The full table of private and reserved ranges is refused, IPv4 and IPv6,
including `::ffff:127.0.0.1` and `169.254.169.254`.

No environment variable turns this off. For local development, use a tunnel, which is a public
address, or `bookrail webhooks listen` without a URL, which polls.

## Events you can subscribe to

`--events` is validated against a closed list and anything outside it is refused. The list has
two halves, and the difference matters.

**Emitted today**, twelve types:

```
booking.created     booking.confirmed   booking.checked_in   booking.started
booking.completed   booking.cancelled   booking.no_show      booking.rescheduled
booking.orphaned    hold.created        hold.released        hold.expired
```

**Subscribable but not emitted yet**, because the feature behind them does not exist:
`booking.updated`, `booking.reminder_due`, `hold.converted`, `waitlist.*`, `payment.*`,
`entitlement.*`, `resource.updated`, `resource.blocked`, `schedule.updated`,
`availability.changed`. Registering for one of these is accepted and will simply never fire
until the feature ships. We would rather you could write the subscription once than have the
API reject a name it is going to accept in three months.

`*` subscribes to everything including types added later. `webhook.failing` and `webhook.test`
exist in the log and are never delivered to any endpoint.

`booking.orphaned` is the one people miss. It fires when a configuration change leaves a sold
booking inconsistent, and it is the only warning you get that somebody edited the calendar
under a customer. See [The edge cases of booking](/docs/edge-cases/).
</content>
