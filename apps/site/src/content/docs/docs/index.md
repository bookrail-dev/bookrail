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

- **No way to get a key.** `api.bookrail.dev` is up and is the address in the `servers` block of
  the OpenAPI document, but there is no dashboard and no sign-up: keys are issued by hand.
  Ask for one on the early access page.
- **No payments.** `payment.mode` other than `none` is refused with `not_yet_supported`, and
  `amount_due` is always `0`.
- **No rate limiting**, and no scope enforcement: API key scopes are stored but not checked.

## Conventions

Every instant on the way in carries an explicit offset; every instant on the way out is UTC.
Identifiers are prefixed, and the prefix says what the object is. Amounts are integers in the
minor unit of their currency. Lists are cursored, never offset, and never carry a total. Every
`POST` accepts an `Idempotency-Key`, and the same key within 24 hours replays the same response.
