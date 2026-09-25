# API reference (short form)

Base URL from `BOOKRAIL_API_URL`. Every request carries:

```
Authorization: Bearer sk_test_...
Bookrail-Version: 2026-09-01
```

Every response carries `Bookrail-Request-Id` and `Bookrail-Version`. Every `POST` accepts
`Idempotency-Key`; the same key within 24 hours returns the same response with
`Idempotent-Replayed: true` and causes no second effect.

## Who am I

```
GET /v1/project
```

Answers the project the calling key belongs to (`id`, `name`, `environment`, `api_version`,
`default_timezone`, `default_currency`) plus `api_key` with the key's own `id`, `kind`,
`scopes` and `tenant_id`, and the `plan` of the account with its `usage` this month (confirmed
live bookings and paid volume, and what the plan includes: always the live numbers, whichever
key asks). Singular and with no id in the path: the key **is** the selector, so
`GET /v1/projects` and `GET /v1/project/{id}` are `404 unknown_endpoint`. No secret material is
returned. It is what `bookrail whoami` and `bookrail doctor` call.

## Configuration CRUD

```
POST   /v1/locations            GET /v1/locations         GET|PATCH|DELETE /v1/locations/{id}
POST   /v1/resources            GET /v1/resources         GET|PATCH|DELETE /v1/resources/{id}
POST   /v1/resources/{id}/block            POST /v1/resources/{id}/unblock
POST   /v1/resource_groups      GET /v1/resource_groups   GET|PATCH|DELETE /v1/resource_groups/{id}
POST   /v1/schedules            GET /v1/schedules         GET|PATCH|DELETE /v1/schedules/{id}
POST   /v1/schedules/{id}/exceptions       DELETE /v1/schedules/{id}/exceptions/{eid}
POST   /v1/services             GET /v1/services          GET|PATCH|DELETE /v1/services/{id}
POST   /v1/policies             GET /v1/policies          GET|PATCH|DELETE /v1/policies/{id}
POST   /v1/customers            GET /v1/customers         GET|PATCH|DELETE /v1/customers/{id}
```

Lists are `{"object":"list","data":[...],"has_more":true}` and paginate by cursor:
`?limit=50&starting_after=<id of the last item>`. Never by offset, and there is no total.

`PATCH` with `rules` (schedule), `resource_ids` (group) or `requirements` (service) replaces
the whole set; omitting the field leaves the set alone. `slot_interval` and `align_to` on a
service accept `null`, which removes the slot grid; omitting them leaves it as it is.

`DELETE` answers `{"id":"...","object":"...","deleted":true}`. Resources and services are soft
deleted so that past bookings keep pointing at what they were made for; everything else is a
real delete, and references from other objects become `null`.

`?expand[]=` works for `resource.schedule`, `resource_group.resources`,
`service.requirements`, `booking.customer` and `booking.allocations.resource`.

## Availability

```
POST /v1/availability        { service_id, from, to, quantity?, resource_ids?, customer_id?,
                               timezone?, granularity?: "slots"|"ranges", explain?: boolean }
GET  /v1/availability/next?service_id=...&from=...&quantity=...&timezone=...
POST /v1/availability/check  { service_id, start, duration_minutes?, quantity?, resource_ids? }
```

Slots come back in UTC, with `available_capacity`, `price`, `price_rule` and
`resource_options`: the concrete combinations of resources that could serve the booking, each
with the units it would contribute. `explain: true` returns, for every rejected instant, the
structured reasons (`outside_schedule`, `exception_closed`, `blocked`, `occupied`, `buffer`,
`min_notice`, `max_advance`, `capacity`, `customer_limit`); the window is capped at seven days
for it and at ninety days otherwise.

With `explain: true` the answer also carries `explain_notes`: what the engine had to ignore to
answer at all, with no instant of its own. Today that is `pricing_rule_ignored`, a rule stored
on the service that the strict schema refuses; it is skipped, the price comes from the next
rule that matches, and `bookrail availability --explain` prints the note above the table.

`price` is not always the flat price of the service. If the service carries `pricing_rules`,
the first rule whose `when` matches the slot decides, and `price_rule` says which one:
`{"index": 0, "label": "Weekend"}`, or `null` when the flat price applied. `bookrail
availability` shows it as a `rule` column.

## Holds and bookings

```
POST   /v1/holds        { service_id, start, duration_minutes?, quantity?, resource_ids?,
                          customer_id? | customer{}, ttl?: "10m" }
DELETE /v1/holds/{id}
POST   /v1/bookings     { service_id, start, hold_id?, quantity?, resource_ids?,
                          customer_id? | customer{}, notes?, metadata? }
GET    /v1/bookings/{id}
GET    /v1/bookings?customer_id=&service_id=&resource_id=&status=&from=&to=
POST   /v1/bookings/{id}/confirm|check_in|complete|no_show
POST   /v1/bookings/{id}/cancel      { reason?, by?: "customer"|"provider"|"system",
                                       override_refund_percent? }
POST   /v1/bookings/{id}/reschedule  { start, resource_ids? }
```

A hold occupies the capacity: create one, then convert it by passing `hold_id` to the
booking. Converting a hold that expired is `409 hold_expired`, and the client asks for
availability again.

## Events and webhooks

```
GET  /v1/events?type=&object_id=&from=&to=      GET /v1/events/{id}
POST /v1/webhooks   { url, events?: ["*"], description? }
GET|PATCH|DELETE /v1/webhooks/{id}
POST /v1/webhooks/{id}/test
GET  /v1/webhooks/{id}/deliveries?status=&event_id=
POST /v1/webhooks/{id}/deliveries/{did}/retry
```

The signing secret is returned **once**, by the creation call. Deliveries carry
`Bookrail-Signature: t=<unix>,v1=<hmac sha256 of "<t>.<body>">`, and are retried at
3s, 30s, 5m, 30m, 2h, 12h, 24h before the endpoint is marked `failing`.
