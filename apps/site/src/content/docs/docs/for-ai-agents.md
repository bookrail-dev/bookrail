---
title: 'For AI agents'
description: 'Install the CLI and the MCP server, the order of operations that works, the output conventions, the exit codes, and one end to end example.'
sidebar:
  order: 61
---

Everything on this page is machine readable somewhere else too. If you are an agent, the fastest
path is [`/llms.txt`](/llms.txt), [`/openapi.json`](/openapi.json) and
[`/mcp/tools.json`](/mcp/tools.json).

## The machine readable surface

| File | What it is |
| --- | --- |
| [`/llms.txt`](/llms.txt) | One line per documentation page, with the markdown URL of each. |
| [`/llms-full.txt`](/llms-full.txt) | Every documentation page concatenated, in markdown. |
| [`/openapi.json`](/openapi.json) | OpenAPI 3.1, generated from the schemas that validate each request. 41 paths, 67 operations. |
| [`/mcp/tools.json`](/mcp/tools.json) | Every MCP tool with its description, input schema and annotations, read from the running server. |
| `<page>.md` | Every page written in markdown is also served as markdown at the same URL with `.md` on the end, for example [`/docs/errors.md`](/docs/errors.md). The generated API reference pages are not: read `/openapi.json` instead. |

A running Bookrail API serves the same specification on `GET /openapi.json`, without a key, so
an agent that has an address can read the contract before it has a credential.

## Install

```bash
# The CLI. It needs nothing installed.
npx bookrail --help

# The MCP server, wired into a coding agent by the CLI itself.
npx bookrail mcp install --client claude-code   # or cursor, vscode, windsurf, generic
```

`mcp install` writes or updates the `bookrail` entry in the client's own configuration file and
leaves every other server alone. It never writes a key.

The server reads `BOOKRAIL_SECRET_KEY` (or `BOOKRAIL_TEST_SECRET_KEY` and
`BOOKRAIL_LIVE_SECRET_KEY`), `BOOKRAIL_API_URL`, and `BOOKRAIL_MCP_ALLOW_LIVE`. With no
variables set it reads the same `~/.config/bookrail/credentials.json` that `bookrail login`
writes.

## The order of operations that works

The same order is in the server's own `instructions`, and it is the one an agent should follow
the first time it meets a project.

```bash
bookrail doctor --json                       # what is configured, what is missing
bookrail init --template <vertical> --json   # write bookrail.config.ts
bookrail push --dry-run --json               # read data.plan before applying anything
bookrail push --json                         # apply
bookrail diff --json                         # data.has_changes must be false
bookrail services list --json                # read back the svc_ ids

bookrail availability --service svc_... --from ... --to ... --json
bookrail availability --service svc_... --from ... --to ... --explain --json
bookrail bookings create --service svc_... --start ... --customer-email ... --json
bookrail bookings get bk_... --json          # close the loop on every write
```

Through MCP the same sequence is `bookrail_project_info`, `bookrail_examples`,
`bookrail_config_validate`, `bookrail_config_push` with `dry_run: true`, then with
`dry_run: false` and `confirm: true`, `bookrail_objects_list`, `bookrail_availability`,
`bookrail_booking_create`, `bookrail_booking_get`. The full list of tools is on the
[MCP page](/docs/mcp/).

## Output conventions

Every CLI command accepts `--json` and prints one envelope:

```json
{ "ok": true, "environment": "test", "data": {}, "next_steps": ["..."] }
```

and on failure

```json
{ "ok": false, "environment": "test",
  "error": { "code": "...", "message": "...", "param": "...", "doc_url": "...", "fix": "..." } }
```

Act on `fix`. It is an instruction, not a diagnosis. Colour is off whenever stdout is not a
terminal, and always off with `--json`.

Two safety rules are enforced rather than advised. The environment is `test` unless `--live` is
typed, and a `sk_live_` key used without it is refused before any request leaves the process.
Every destructive command needs `--yes`; through MCP, every irreversible tool returns a preview
and `requires_confirmation: true` until it is called again with `confirm: true`.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Success. | Read `data`, then `next_steps`. |
| `1` | User or configuration error. | Fix the input named by `error.param`. |
| `2` | Authentication. | The key is missing, wrong or for the other environment. |
| `3` | Network or service. | The API was unreachable or answered 5xx. Retrying is safe: every `POST` carries an `Idempotency-Key`. |
| `4` | Conflict. | The state changed underneath. Re-read, then decide. |

## The errors you will actually hit

| Code | What it means | The fix |
| --- | --- | --- |
| `slot_unavailable` | The capacity went to somebody else between the answer and the booking. | Run `availability --explain` on the same window and take another instant. |
| `start_not_on_grid` | The service defines `slotInterval` or `alignTo` and this instant is not on the grid. | Take a `start` from the availability answer, never a rounded clock time. |
| `hold_not_active` | The hold expired, was released, or is already a booking. | `bookrail holds get hold_...` says which. Create a new hold. |
| `idempotency_key_reused` | Same key, different body. | Use a new key, or send the original body. |
| `idempotency_key_in_progress` | The first request with this key has not finished. | Wait and retry the same key: it will replay the first answer. |
| `invalid_transition` | The booking is not in a state where that action is legal. | `bookings get` for the current status, then the transition the matrix allows. |
| `timezone_missing` | A candidate resource has no time zone, on its schedule or on its location. | Give the schedule a `timezone`, or the location one. |
| `not_yet_supported` | The field exists in the contract and not in this build, for example `payment.mode` other than `none`. | Drop the field. |
| `live_key_without_live` | A `sk_live_` key without `--live`. | Add `--live`, deliberately. |

The complete catalogue is on the [Errors page](/docs/errors/), and every error the API returns
carries its own `doc_url`.

## End to end

Ten commands, from nothing to a booking and back. Replace the ids with the ones your own
`push` prints.

```bash
# The public API is the default, so there is nothing to point the CLI at.
npx bookrail login --token sk_test_...

mkdir club && cd club
npx bookrail init --template padel
npx bookrail push --dry-run --json     # read data.plan
npx bookrail push --json
npx bookrail diff --json               # data.has_changes must be false

SVC=$(npx bookrail services list --json | jq -r '.data.data[0].id')
npx bookrail availability --service "$SVC" \
  --from 2026-09-08T08:00:00+02:00 --to 2026-09-08T20:00:00+02:00 --json

npx bookrail holds create --service "$SVC" \
  --start 2026-09-08T09:00:00+02:00 --ttl 10m --customer-email anna@example.com --json
npx bookrail bookings create --service "$SVC" \
  --start 2026-09-08T09:00:00+02:00 --hold hold_... --customer-email anna@example.com --json
npx bookrail bookings get bk_... --json
```

That runs against `https://api.bookrail.dev`, which is where the CLI goes by default. To point
it at an instance of your own instead, set `BOOKRAIL_API_URL` (for example
`export BOOKRAIL_API_URL=http://127.0.0.1:3000` for a local `pnpm dev`), or pass `--api-url` to
one command, or store it once with `bookrail login --api-url <url>`.

Two things about that script are not decoration. `availability` returns `start` values that
`bookings create` takes verbatim, so no instant is ever built by rounding a clock. And a bare
date such as `2026-09-08` is refused by the CLI before the request leaves, because midnight is
not the same instant in every time zone.

The dates in it are fixed. Move them forward when you run it: the padel template ships a
`maxAdvanceDays` of 14, so a start further out than that is refused by the booking window and
not by a bug.

## Modelling a business onto the model

Four questions, in this order.

1. **What is sold?** That is a Service, and it needs exactly one duration form.
2. **What has to be free for it to happen?** Those are Resources, and the Service's
   requirements. If several must be free at once, list several requirements.
3. **How many at once?** That is `capacity` on the resource and `quantity` on the booking. If
   the count lives on one thing, the seats of a class, put the capacity there and make the other
   requirements `consumes: "whole"`.
4. **What are the rules about money and time?** That is a Policy.

Do not model a slot. Slots are computed, never stored.
