---
title: 'Documentation'
description: 'What Bookrail is, what exists today, and where each piece is documented.'
sidebar:
  order: 0
---

Bookrail is booking infrastructure: availability, resources, holds, bookings, policies and the
events they emit, behind one HTTP API. It is the layer under a booking product, not the product.

## Where to start

- **[Quickstart](/docs/quickstart/)**: from a key to a confirmed booking, with the CLI, the SDK
  or plain HTTP. Every command on it was run against the production API and timed.
- **[Concepts](/docs/concepts/)**: the whole model in one page, with figures. The field by field
  list is the **[Entity reference](/docs/entities/)**.
- **[Configuration](/docs/configuration/)**: `bookrail.config.ts`, the booking model as code.
- **[The edge cases of booking](/docs/edge-cases/)**: sixteen things that go wrong in booking
  systems, what happens here, and the test that proves each one.
- **[API](/docs/api/)**, the **[API reference](/docs/api/reference/)** and the
  **[SDK](/docs/sdk/)**: the short form, every operation generated from the OpenAPI document,
  and the TypeScript client.
- **Guides**: [time zones](/docs/guides/time-zones/), [webhooks](/docs/guides/webhooks/),
  [idempotency](/docs/guides/idempotency/), [policies](/docs/guides/policies/) and
  [coding agents](/docs/guides/agents/).
- **[Errors](/docs/errors/)**: every code, what it means, and what to do about it.
- **[For AI agents](/docs/for-ai-agents/)**: the machine readable surface, in one page.

## What exists today

The engine, the API, the CLI, the MCP server and the TypeScript SDK are written and tested
against real Postgres. What does not exist yet, and is not documented as if it did:

- **A small dashboard, and no password.** Keys are self service (`npx bookrail signup`, or
  [/signup](/signup)): a test key and a live key on the [Free plan](/pricing/). The
  [dashboard](/dashboard/), signed in with a link to your address, shows the plan, this month's
  usage, the projects and the keys, and makes and revokes keys. It does not create projects,
  invite a team or show a bill yet.
- **No payments.** `payment.mode` other than `none` is refused with `not_yet_supported`, and
  `amount_due` is always `0`.
- **No scope enforcement**: API key scopes are stored but not checked, and there are no per
  project quotas. There *is* a rate limit per key, which is the one ceiling that exists: 20
  requests a second with bursts of 40 on a `sk_test_` key, 100 a second with bursts of 500 on a
  `sk_live_` one. Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and
  `RateLimit-Reset`; a refusal is `429 rate_limited` with `Retry-After`, and the SDK, the CLI and
  the MCP server wait for it without being asked.

## Conventions

Every instant on the way in carries an explicit offset; every instant on the way out is UTC.
Identifiers are prefixed, and the prefix says what the object is. Amounts are integers in the
minor unit of their currency. Lists are cursored, never offset, and never carry a total. Every
`POST` accepts an `Idempotency-Key`, and the same key within 24 hours replays the same response.
