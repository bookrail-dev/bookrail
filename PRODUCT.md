# Bookrail

Booking infrastructure for developers. Availability, resources, holds, bookings, policies and
webhooks for anything bookable, behind one API.

## What it is

The layer under a booking product, not the product. A team that has to let people book
something builds the interface, the pricing and the brand; Bookrail answers what is free, takes
the capacity without ever giving it twice, freezes the rules that applied at the moment of the
booking, and emits a signed event for everything that happens.

The word for the category is booking infrastructure. We use it until it is the word everybody
uses.

## Who it is for

Developers, and the coding agents they work with. Product teams adding booking to an
application; vertical SaaS that keeps rebuilding a calendar and getting DST wrong;
marketplaces that need one availability model over many providers. Not end users: we do not
ship an app anybody books through.

## The promise

- **Zero double bookings.** An exclusion constraint for capacity 1 and a trigger for capacity N.
  The guarantee is in Postgres, so it survives a bug in the application, and it is proved every
  run by separate processes hitting the same slot at the same instant.
- **Availability that is right.** Across resources, schedules, buffers, booking windows and
  time zones, with `explain` that names the booking, block or rule that took each instant.
- **Time zones done properly.** Schedules live on a local clock and are materialised into UTC
  day by day from the IANA database, so the day a clock changes has 23 or 25 hours and the rules
  still mean what they say.
- **Nothing changes the past.** The cancellation, reschedule and no-show rules are snapshotted
  into the booking when it is made.
- **Idempotent by construction.** Every `POST` accepts an `Idempotency-Key`, and the key is
  taken with a unique constraint rather than checked with a read.
- **Made to be driven by an agent.** A CLI with `--json` on every command, an MCP server with 36
  tools, an OpenAPI document generated from the schemas that validate each request, and every
  documentation page also served as plain markdown.

Everything above exists and is tested today, and the API is live at `api.bookrail.dev`.
Payments, rate limiting, scope enforcement on API keys and the dashboard do not exist; the site
says so on the page where it would matter.

## The tone

Precise, honest, technical, calm, generous. We say what the product does and where it stops. We
publish what went wrong. We do not use exclamation marks, hype, invented numbers or an em dash.
Code and real screenshots instead of illustrations. Official language: English.

## Naming

The product is **Bookrail** (`bookrail.dev`), chosen on 7 September 2026, and the code says the
same word: the packages are `bookrail`, `@bookrail/node`, `@bookrail/mcp` and
`@bookrail/webhook-signature`, the command is `bookrail`, the headers are `Bookrail-*`, and the
identifier prefixes and environment variables follow. Every snippet the site publishes is the
one that runs.

## Licence

Apache 2.0 for everything that makes bookings work. The cloud sells operations, the dashboard,
managed notifications, reliability and support, never a feature of the engine held back.
