# Changelog

All notable changes to the published packages are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow
[semantic versioning](https://semver.org/spec/v2.0.0.html): while they are `0.x` a minor
version may change the surface, and every such change is listed under **Changed** with what to
do about it.

The four published packages are versioned together: `bookrail`, `@bookrail/node`,
`@bookrail/mcp` and `@bookrail/webhook-signature`. `@bookrail/webhook-signature` is a
dependency of the first two, so it is always published first or in the same batch.

## 0.3.1

Released on 14 September 2026, a few minutes after 0.3.0. The same code as 0.3.0, published
correctly.

### Fixed

- **`bookrail@0.3.0`, `@bookrail/node@0.3.0` and `@bookrail/mcp@0.3.0` could not be installed.**
  They were published with the dependency on `@bookrail/webhook-signature` still written as
  `workspace:*`, the notation of the monorepo, which the registry does not understand: `npx
  bookrail@0.3.0` fails with `Unsupported URL Type "workspace:"`. The three are deprecated on
  the registry and 0.3.1 carries the resolved version. `@bookrail/webhook-signature@0.3.0` was
  fine, and is republished as 0.3.1 only so that the four stay on one number.

## 0.3.0

Released on 14 September 2026. One new limit, three new headers, and nothing removed. **Do not
install this version of `bookrail`, `@bookrail/node` or `@bookrail/mcp`: see 0.3.1.**

### Added

- **A rate limit per API key, with the standard headers.** A `sk_test_` key may make **20 requests
  a second with bursts of 40**; a `sk_live_` key **100 a second with bursts of 500**. Every
  response of every endpoint that takes a key now carries `RateLimit-Limit` (the burst),
  `RateLimit-Remaining` (a whole number) and `RateLimit-Reset` (whole seconds until the budget is
  full again), so a client can pace itself instead of finding the ceiling by hitting it. Over the
  ceiling the answer is `429` with the new code **`rate_limited`**, a `Retry-After` in whole
  seconds (at least 1) and a `fix`. The bucket is the key, not the project: two keys of one
  project have two budgets.
- **`RateLimit-Policy: unavailable`**, on a response that was served because no limit could be
  applied at all: the store that holds the counters did not answer, and an unreachable store must
  not become an unreachable API. The three counters are absent on such a response.
- **`@bookrail/node` waits for the limit by itself.** No new option and no change to the retry
  policy: a `429` was already retried after the `Retry-After` the server sent, up to `maxRetries`
  times. You see `BookrailRateLimitError` only when the retries are spent or when you asked for
  none, and it now carries `fix` and the response headers.
- **`bookrail`** prints the message and the fix and exits **3**, which is the exit code of the
  `rate_limit` family and means "waiting and running this again may work". **`@bookrail/mcp`**
  returns the structured error, with the fix, as it does for every other failure.

### Changed

- **A test key now has a ceiling.** Until this release there was none, and the documentation said
  so. A script that called `POST /v1/availability` in a loop with a test key was limited only by
  how fast one process could answer; it is now limited to 20 requests a second with bursts of 40.
  Every client of ours already handles the refusal; a hand-written client should read
  `Retry-After` rather than retry immediately.
- **`429` from the reverse proxy is JSON.** The sign up endpoints are rate limited by address in
  front of the API, and that refusal used to be a page of HTML with no CORS header, which a
  browser would not let the sign up page read: the page then reported a network failure for a
  refusal the server had explained. It is now the same error envelope as everything else, with
  `code: "rate_limited"`, a `fix` and a `Retry-After`. It carries no `request_id`, because the
  proxy has none to give. A CORS preflight is not counted against that limit and is never
  refused, so a browser always gets far enough to read the answer, and the sign up endpoints send
  `Access-Control-Max-Age: 600` so that one submission of a form costs one request and not two.
- **`bookrail signup` waits at most fifteen seconds for any one `Retry-After`.** The command
  treats a `429` while it polls as a pause rather than a failure, and it honours the wait the
  answer asks for; that answer can come from anything between the terminal and the API, and a
  proxy asking for a minute used to park a sign up for a minute while the link in the mailbox was
  already valid. Past fifteen seconds it now simply asks again.

### Fixed

- **`error.fix` on `BookrailError`** in `@bookrail/node`. The field was documented for 0.2.0 and
  the envelope carried it, but the client dropped it on the way into the error object, so a caller
  could not read it. It is there now.

## 0.2.0

Released on 11 September 2026. One new command, one new field, and nothing removed.

### Added

- **Self-service test keys.** `npx bookrail signup` sends a confirmation link to an address and
  waits; opening the link creates an account, a project and one test key, which the terminal
  stores the way `bookrail login` does. The same flow exists in the browser at
  [bookrail.dev/signup](https://bookrail.dev/signup). A live key is still issued by a person:
  write to hello@bookrail.dev. The three endpoints behind it (`POST /v1/signups`,
  `POST /v1/signups/confirm`, `POST /v1/signups/{id}/claim`) take no API key, answer the same
  way for a free and a taken address, and are the only part of the API with CORS.
- **`fix` in the error envelope.** Every error may now carry an optional `fix` string next to
  `message`: what to do about it, in one sentence. Eight new error codes come with the sign up
  flow (`signup_rate_limited`, `signup_not_found`, `signup_already_confirmed`, `signup_expired`,
  `signup_secret_claimed`, `signup_secret_expired`, `signup_disabled`, `signup_email_failed`), each
  with its own HTTP status.
- **`@bookrail/node`** knows the new error codes. (This entry originally also claimed the `fix`
  field on `BookrailError`; in 0.2.0 the client dropped it, see 0.3.0 under Fixed.) The sign up
  operations are deliberately not in the SDK (`x-bookrail-sdk: false` in the OpenAPI
  document): they are for a terminal or a browser, not for an application server.

### Changed

- **The error envelope gained a field.** `fix` is optional and additive. A client that parses
  the envelope with a strict schema (one that rejects unknown keys) must allow it; every other
  client is unaffected.
- **`@bookrail/mcp` and `@bookrail/webhook-signature`** have no functional change; they move to
  0.2.0 because the four packages are versioned together.

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
