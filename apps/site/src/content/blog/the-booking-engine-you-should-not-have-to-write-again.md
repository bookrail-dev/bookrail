---
title: 'The booking engine you should not have to write again'
description: 'Every booking product is the same product underneath. Bookrail is the open source layer under it: what it guarantees, where the guarantees live, and what does not exist yet.'
date: 2026-09-10
author: 'Francesco Paba'
draft: false
---

Every booking product is the same product underneath. A padel club, a dental practice, a co-working space, a boat rental, a photo studio: different words on the interface, the same eight problems under it. What is free right now. Who gets the slot when two people ask at the same instant. What happens to a slot when the clocks change. Which cancellation rule applies to a booking made before the rule changed. Whether the request you retried after a timeout created one booking or two.

None of these problems is hard on its own. Together, and under real traffic, they are the reason booking systems get rewritten. The first version treats availability as a query and bookings as rows. The second version adds a lock. The third one discovers daylight saving time in production, usually in March, usually on a Sunday. The fourth one moves the cancellation policy out of the booking table and then cannot explain to a customer why their refund is different from what they were shown.

So we built the layer once, in the open, and today the repository is public: [github.com/bookrail-dev/bookrail](https://github.com/bookrail-dev/bookrail), Apache 2.0.

## What Bookrail is, and what it is not

Bookrail is booking infrastructure for developers. It is the layer under a booking product, not the product. You build the interface, the pricing and the brand. Bookrail answers what is free, takes the capacity without ever giving it twice, freezes the rules that applied at the moment of the booking, and emits a signed event for everything that happens.

It is not a scheduling app, not a Calendly, not a plugin for a CMS. There is no end user interface at all. There is an HTTP API, a CLI, a TypeScript SDK, an MCP server for coding agents, and a PostgreSQL schema you can read.

## The guarantees, and where they live

The decision that shaped everything else: the guarantees live in the database, not in the application.

**Zero double bookings.** A resource with capacity 1 has a PostgreSQL exclusion constraint on its occupancies. A resource with capacity N has a trigger that checks the peak of overlapping occupancies. If the application has a bug, or if someone writes to the table with a SQL client, the constraint still holds. We do not trust this because it sounds right. The concurrency suite starts separate Node processes, each with its own connection, and fires simultaneous requests for the same slot: 40 in every test run, 200 per scenario before a release. Exactly one wins. Before a release we run the ten scenarios twenty rounds in a row, which is 40,000 requests.

**Isolation: read committed, and the lock before the read.** We started from `SERIALIZABLE` because that is what the textbook says. We measured it. Under serializable isolation a transaction takes its snapshot at its first statement, so a transaction that then waits on an advisory lock keeps reading the state from before the lock holder committed. The lock orders the transactions, but it does not make the check after it authoritative. Under `read committed` every statement sees a fresh snapshot, so taking the advisory lock on the resource before reading its occupancies makes the check see exactly what the lock was taken for. Serializable is not wrong here, it is noisy. With the original order (read first, then lock) and three retries, 200 simultaneous requests on a capacity 15 slot left about one request in six with a `serialization_failure` instead of a clean `slot_unavailable`; it took about ten retries to clear them. With the lock first and read committed, nine runs out of forty under serializable still ended with requests lost to `serialization_failure`, and the read committed version lost none. The invariant is the constraint either way. The isolation level decides how many retries you pay for it.

**Idempotent by construction.** Every `POST` accepts an `Idempotency-Key`. The key is taken with a unique constraint, not checked with a read. Twenty simultaneous requests with the same key produce one booking and nineteen identical responses.

**Nothing changes the past.** The cancellation, reschedule and no show rules are copied into the booking when it is made, as a `policy_snapshot`. Change the policy tomorrow and the booking made today still knows its own terms. The price is frozen the same way, together with the pricing rule that produced it, so a booking can always say why it cost what it cost.

**Time zones done properly.** Schedules live on a local clock. They are materialised into UTC day by day from the IANA database, so the day a clock changes has 23 or 25 hours and the rules still mean what they say. The suite runs the same schedule across the transitions in Rome, New York, Santiago, Sydney, Kolkata and Auckland, with the dates read from tzdata rather than typed in.

**Availability that can explain itself.** Ask for availability with `explain` and each instant that is not free names the booking, the block, the buffer or the rule that took it. When you are staring at a calendar that says a room is busy and the room is empty, this is the difference between a five minute answer and an afternoon.

## Made to be driven by an agent

Most booking products will be built, from now on, partly by coding agents. We took that literally.

- Every CLI command has `--json`.
- The MCP server exposes 36 tools, so an agent can create a project, describe a padel club, and make the first booking without leaving the editor.
- The OpenAPI document is generated from the same Zod schemas that validate every request, and the API serves it without a key at `api.bookrail.dev/openapi.json`.
- Every documentation page is also served as plain markdown.

The quickstart, from a key to a confirmed booking, takes 21 seconds of machine time. Every command on that page was run against the production API and timed.

## The honest line

The packages are `0.x`. What exists today: the engine, the API, the CLI, the MCP server and the SDK, all tested against a real PostgreSQL with no mocks, about 1,500 tests. The API is live. The documentation is live.

What does not exist, and is documented as not existing: payments (any `payment.mode` other than `none` is a `400`), rate limiting, scope enforcement on API keys, a dashboard, browser SDKs and UI components.

A test key is issued by a person. Write to hello@bookrail.dev and say what you are building. There is no sign up form because there is nothing behind one yet, and we would rather say so than build a form that pretends.

## What we would like from you

Read the code. The transaction that takes capacity is one file. The list of things that go wrong in booking systems, what happens here for each of them, and the test that proves it, is on one page: [The edge cases of booking](https://bookrail.dev/docs/edge-cases/). If you find a case that is not on it, open an issue. That page is the spec.

Francesco Paba, founder, Bookrail. hello@bookrail.dev
