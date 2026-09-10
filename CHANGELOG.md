# Changelog

All notable changes to the published packages are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow
[semantic versioning](https://semver.org/spec/v2.0.0.html): while they are `0.x` a minor
version may change the surface, and every such change is listed under **Changed** with what to
do about it.

The four published packages are versioned together: `bookrail`, `@bookrail/node`,
`@bookrail/mcp` and `@bookrail/webhook-signature`. `@bookrail/webhook-signature` is a
dependency of the first two, so it is always published first or in the same batch.

## 0.1.0

The first public release. Everything below already existed and was tested; this is the day it
became something anybody could read and install.

### Added

- **The availability and booking engine.** Timelines as segment algebra, schedules
  materialised into UTC day by day from the IANA database, availability across resources,
  groups, buffers, booking windows and time zones, and `explain`, which names the booking,
  block or rule that took each instant.
- **Zero double bookings, enforced by PostgreSQL.** An exclusion constraint for capacity 1 and
  a statement level trigger for capacity N, so the guarantee survives a bug in the application.
  It is proved on every run by separate processes racing for the same slot.
- **The HTTP API**: 67 operations over locations, resources and their blocks, resource groups,
  schedules and their exceptions, services, policies, customers, availability, holds, bookings
  and their six transitions, the event log and webhooks. Every `POST` accepts an
  `Idempotency-Key`, and the key is taken with a unique constraint rather than checked with a
  read.
- **Row level security on every table**, forced, with an application role that has no
  `BYPASSRLS` and sees nothing without a tenant context.
- **Policies frozen into the booking.** The cancellation, reschedule and no show rules that
  applied at the moment of the booking are snapshotted into it, so nothing changes the past.
- **Events and webhooks**: an append only event log written in the same transaction as the row
  it describes, a transactional outbox, signed delivery with a documented retry ladder, and an
  SSRF guard that connects to the addresses it has already checked.
- **`bookrail`**, the command line interface: configuration as code with `defineConfig`, push,
  pull and diff, the operational commands, `--json` on every one of them, and nine templates
  for real verticals.
- **`@bookrail/mcp`**, the Model Context Protocol server: 36 tools over the same command
  layer, with a barrier between test and live keys.
- **`@bookrail/node`**, the TypeScript SDK: types generated from the OpenAPI document, retries
  with `Retry-After`, cursor pagination as an async iterable, typed errors, and
  `webhooks.constructEvent`. ESM only, one runtime dependency, no Node builtin on the main
  path.
- **`@bookrail/webhook-signature`**: `signPayload` and `verifySignature`, zero runtime
  dependencies, the one piece of Bookrail that runs on the receiver's machine.
- **The OpenAPI 3.1 document**, generated from the Zod schemas that validate every request and
  served by the API itself at `/openapi.json` without a key.
- **The site and the documentation** (`apps/site`), including the timed quickstart, the data
  model, the edge cases of booking, and every page also served as plain markdown for agents.
