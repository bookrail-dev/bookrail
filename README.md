# Bookrail

[![CI](https://github.com/bookrail-dev/bookrail/actions/workflows/ci.yml/badge.svg)](https://github.com/bookrail-dev/bookrail/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/bookrail.svg?label=bookrail)](https://www.npmjs.com/package/bookrail)
[![Docs](https://img.shields.io/badge/docs-bookrail.dev-111111.svg)](https://bookrail.dev/docs/)

**Booking infrastructure for developers.** Availability, resources, holds, bookings, policies
and webhooks for anything bookable, behind one API.

Bookrail is the layer under a booking product, not the product. You build the interface, the
pricing and the brand. Bookrail answers what is free, takes the capacity without ever giving it
twice, freezes the rules that applied at the moment of the booking, and emits a signed event
for everything that happens.

```bash
npx bookrail init --template padel     # a config file for a padel club
npx bookrail push                      # create it
npx bookrail availability --service svc_... --from 2026-09-14T00:00:00+02:00 --to 2026-09-15T00:00:00+02:00
npx bookrail bookings create --service svc_... --start 2026-09-14T18:00:00+02:00 --customer-email ada@example.com
```

```
[test] booked bk_01a0804124a974cfb34faa100c8dc6cf · confirmed
field            value
---------------  ------------------------------------
start (UTC)      2026-09-14T16:00:00.000Z
local            2026-09-14 18:00 Europe/Rome
duration         60 min
price            30.00 EUR
next transition  complete at 2026-09-14T17:00:00.000Z

allocation                             resource                              units
-------------------------------------  ------------------------------------  -----
ball_01a080412534755d93e77dd5cc1dd2ce  res_01a0804110a97175a637c6fec7692f85   1
```

That is real output, from the timed walkthrough in
[the quickstart](https://bookrail.dev/docs/quickstart/), which takes 21 seconds of machine
time end to end.

## Status, honestly

**Early access.** This repository is public and the four packages are on npm. What that does
not mean is that everything on the roadmap exists: what follows is the honest line between the
two.

What exists today:

- The **engine, the API, the CLI, the MCP server and the SDK**, all of them tested against a
  real PostgreSQL, and the booking transaction proved every run by separate processes racing
  for the same slot.
- The **API is live** at `https://api.bookrail.dev`, and it serves its own OpenAPI document at
  `https://api.bookrail.dev/openapi.json` without a key.
- The **documentation is live** at [bookrail.dev](https://bookrail.dev).
- The packages: [`bookrail`](https://www.npmjs.com/package/bookrail),
  [`@bookrail/node`](https://www.npmjs.com/package/@bookrail/node),
  [`@bookrail/mcp`](https://www.npmjs.com/package/@bookrail/mcp) and
  [`@bookrail/webhook-signature`](https://www.npmjs.com/package/@bookrail/webhook-signature).
- A **test key is issued by a person**: write to hello@bookrail.dev and say what you are
  building. There is no sign up and no dashboard yet.

What does not exist, and is documented as not existing: payments (`payment.mode` other than
`none` is a `400`), rate limiting, scope enforcement on API keys, the dashboard, browser SDKs,
and UI components.

The version numbers say the same thing: the packages are `0.x`, the surface can still change,
and every change that breaks something is in [CHANGELOG.md](CHANGELOG.md).

## What it does

- **Zero double bookings.** A Postgres exclusion constraint for capacity 1 and a trigger for
  capacity N. The guarantee is in the database, so it survives a bug in the application, and
  it is proved every run by separate processes hitting the same slot at the same instant.
- **Availability that is right.** Across resources, schedules, buffers, booking windows and
  time zones, with `explain` naming the booking, block or rule that took each instant.
- **Time zones done properly.** Schedules live on a local clock and are materialised into UTC
  day by day from the IANA database, so the day a clock changes has 23 or 25 hours and the
  rules still mean what they say.
- **Nothing changes the past.** The cancellation, reschedule and no show rules are snapshotted
  into the booking when it is made.
- **Idempotent by construction.** Every `POST` accepts an `Idempotency-Key`, and the key is
  taken with a unique constraint rather than checked with a read.
- **Made to be driven by an agent.** A CLI with `--json` on every command, an MCP server with
  36 tools, an OpenAPI document generated from the schemas that validate each request, and
  every documentation page also served as plain markdown.

The list of what goes wrong in booking systems, what happens here for each case, and the test
that proves it, is [The edge cases of booking](https://bookrail.dev/docs/edge-cases/).

## Run it locally

Node 20, pnpm 10, and a PostgreSQL 16 or newer (17 is what development and CI run). Redis is optional: without it the availability
cache lives in process memory. Docker is not required.

```bash
export DATABASE_URL=postgres://localhost:5432/bookrail_dev
export REDIS_URL=redis://localhost:6379          # optional

pnpm install
pnpm db:migrate                                  # schema, application role, RLS, constraints
pnpm test                                        # real Postgres, no mocks
pnpm test:concurrency -- --rounds 20             # 200 simultaneous requests on one slot
```

Then start the API and make yourself a key:

```bash
export BOOKRAIL_BOOTSTRAP_TOKEN=a-local-token
pnpm dev

curl -X POST http://127.0.0.1:3000/internal/bootstrap \
  -H "authorization: Bearer a-local-token" \
  -H 'content-type: application/json' \
  -d '{"account_name":"Acme","project_name":"Acme","default_timezone":"Europe/Rome"}'
```

It answers with the account, the project and the two secret keys, in clear **once**: the
database keeps only their SHA-256. The endpoint exists only while
`BOOKRAIL_BOOTSTRAP_TOKEN` is set.

## What is in here

| Package | What it is |
| --- | --- |
| `packages/engine` | The availability and booking engine. Pure functions plus the one transaction that takes capacity. |
| `packages/api` | The HTTP API, its Zod schemas, the generated OpenAPI document, the job workers. |
| `packages/db` | The schema, 19 hand written SQL migrations, row level security, the constraints. |
| `packages/cli` | [`bookrail`](packages/cli/README.md), the command line interface. |
| `packages/mcp` | [`@bookrail/mcp`](packages/mcp/README.md), the MCP server for coding agents. |
| `packages/sdk-node` | [`@bookrail/node`](packages/sdk-node/README.md), the TypeScript SDK. |
| `packages/webhook-signature` | [`@bookrail/webhook-signature`](packages/webhook-signature/README.md), the verifier a receiver runs. |
| `packages/shared` | Types, identifiers and the event catalogue shared across the above. |
| `apps/site` | [bookrail.dev](https://bookrail.dev): the site and the documentation, Astro and Starlight. |

## Documentation

- [Quickstart](https://bookrail.dev/docs/quickstart/): from a key to a booking, with the CLI,
  the SDK or plain HTTP. Every command on it was run against the production API and timed.
- [Concepts](https://bookrail.dev/docs/concepts/): the data model, with figures.
- [The edge cases of booking](https://bookrail.dev/docs/edge-cases/): the honest list, with the
  test for each case.
- [API reference](https://bookrail.dev/docs/api/reference/): 67 operations, generated from the
  specification the server serves.
- [For AI agents](https://bookrail.dev/docs/for-ai-agents/): `llms.txt`, `openapi.json`,
  `mcp/tools.json`, and the conventions an agent can rely on.

## Licence

[Apache License 2.0](LICENSE), declared by every package in its own `package.json`, with the
trademark position in [NOTICE](NOTICE). Everything that makes bookings work is open: the
engine, the API, the schema and its migrations, the job workers, the CLI, the MCP server and
the SDK. The cloud sells operations, the dashboard, managed notifications, reliability and
support, never a feature of the engine held back.

How to contribute is in [CONTRIBUTING.md](CONTRIBUTING.md), which asks for a
[DCO](https://developercertificate.org/) sign off (`git commit -s`) and nothing else. How to
report a vulnerability is in [SECURITY.md](SECURITY.md); the behaviour expected of everybody
here is in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Contact

hello@bookrail.dev, read by a person. Bookrail is a product of MP Informatica Srl, Treviso,
Italy ([legal notice](https://bookrail.dev/legal)).
