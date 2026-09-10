---
title: 'Open source'
description: 'Apache 2.0, what is open and what is not, and where the repository is today.'
sidebar:
  order: 80
---

## The licence

**Apache 2.0**, for the engine, the API, the SDKs, the components and the CLI. Confirmed on
7 September 2026, after weighing AGPL and the source available licences: Apache 2.0 gives the
widest adoption, works inside a company without a lawyer, and carries a patent grant that MIT
does not.

Every package in the repository already declares it: `bookrail`, `@bookrail/mcp`,
`@bookrail/node`, `@bookrail/webhook-signature`, and the internal `db`, `engine`, `api` and
`shared`.

## Where the repository is

Public since 10 September 2026, at
[github.com/bookrail-dev/bookrail](https://github.com/bookrail-dev/bookrail). The organisation
is `bookrail-dev` because the name `bookrail` on GitHub belongs to an inactive account. Bugs and
questions go to the issue tracker of that repository, and the most useful issue you can open is
one that names a case [The edge cases of booking](/docs/edge-cases/) does not cover: that page is
the specification, so a missing case is a missing guarantee. Contributions arrive as pull
requests, each with a test;
[CONTRIBUTING.md](https://github.com/bookrail-dev/bookrail/blob/main/CONTRIBUTING.md) in the
repository says how the suite is run.

The four packages are on npm: [`bookrail`](https://www.npmjs.com/package/bookrail),
[`@bookrail/node`](https://www.npmjs.com/package/@bookrail/node),
[`@bookrail/mcp`](https://www.npmjs.com/package/@bookrail/mcp) and
[`@bookrail/webhook-signature`](https://www.npmjs.com/package/@bookrail/webhook-signature).
Everything the documentation shows with `npx` works from npm exactly as it works from a clone of
the repository.

## What is open, and what is not

The rule: **everything you need to make bookings work is open. Everything you need to run them
at scale without thinking about it is the cloud.** Self hosting has to give a complete, honest
product, otherwise the openness is a marketing claim.

| Component | Open source | Cloud |
| --- | --- | --- |
| Availability and booking engine | Yes | Yes, the same code |
| REST API, data model, Postgres migrations | Yes | Yes |
| Job worker, webhook delivery | Yes | Yes |
| SDKs, UI components, CLI, OpenAPI document | Yes | Yes |
| Local mini dashboard | Yes | Not applicable |
| Full dashboard: logs, availability simulator, analytics, team | No | Yes |
| Billing, metering, multi account tenancy | No | Yes |
| Managed notifications, hosted portal on your domain | No | Yes |
| SSO, granular roles, advanced audit log | No | Yes |
| Multiple regions, SLA, support, certifications | No | Yes |

## Why

Nobody puts the core of their business behind a closed API from a company they have not heard
of. With the code open you can read how concurrency and time zones are handled before you trust
them, and you can host it yourself if we disappear. That is the whole argument; the rest
follows from it.
