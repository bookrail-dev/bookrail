---
title: 'Coding agents'
description: 'Build a booking flow with a coding agent: the MCP server, the CLI, the guardrails that stop it doing damage, and one example that runs end to end against the API.'
sidebar:
  order: 45
---

Bookrail is built to be driven by a coding agent as well as by a person. Not as a demo: the
CLI takes `--json` on every command, the MCP server exposes 36 tools with real input schemas,
the API ships an OpenAPI document generated from the schemas that validate each request, and
every documentation page is also served as markdown.

[For AI agents](/docs/for-ai-agents/) is the reference for that surface: the files, the
conventions, the exit codes, the errors. This page is the guide: how to actually put an agent
to work on a booking flow without it doing damage.

## Two ways in, and when to use which

**The MCP server** is for an agent working inside an editor or a chat: it discovers what it can
do from `tools/list`, gets typed arguments, and gets structured errors with a `fix` field.

```bash
npx bookrail mcp install --client claude-code   # or cursor, vscode, windsurf, generic
```

That writes the `bookrail` entry into the client's own configuration and leaves every other
server alone. It never writes a key.

**The CLI** is for an agent that has a shell, which is most of them, and for anything scripted
or run in CI. Every command takes `--json` and prints one envelope, so an agent parses one
shape and never a table.

They are not two implementations. The MCP server drives the CLI in process, so there is one
HTTP client and one error contract behind both. A tool cannot behave differently from the
command it wraps.

## The guardrails

These matter more than the tool list, because an agent with a key is an agent that can cancel
a real customer's booking.

- **Test is the default and live is a wall.** The CLI is in the test environment unless `--live`
  is typed, and a `sk_live_` key used without it is refused before any request leaves the
  process. The MCP server needs `BOOKRAIL_MCP_ALLOW_LIVE=1` **and** a live key: one of the two
  alone does nothing.
- **Irreversible operations preview first.** Through MCP, a destructive tool returns what it
  would do plus `requires_confirmation: true`, and only acts when called again with
  `confirm: true`. On the CLI the same operations need `--yes`.
- **`push` shows a plan.** `--dry-run` computes and prints, changes nothing. Deletions in a plan
  need `--yes` on top.
- **The tools carry annotations.** `readOnlyHint`, `destructiveHint`, `idempotentHint` and
  `openWorldHint` are on every tool in [`/mcp/tools.json`](/mcp/tools.json), so a client that
  gates on them has something real to gate on.
- **stdout belongs to the protocol.** The MCP server replaces `process.stdout.write` at startup
  so nothing but JSON-RPC frames can reach the transport, and every failure is an `isError`
  carrying `{ code, message, fix, doc_url }`.

Give an agent a **test key only**, and give it a project of its own. That is one line of
prevention worth more than every hint above.

## Give it the documentation, not a search box

An agent works far better with the whole contract than with a chat about the contract.

| What to hand it | Why |
| --- | --- |
| [`/llms.txt`](/llms.txt) | The index: one line per page, with the markdown URL of each. |
| [`/llms-full.txt`](/llms-full.txt) | Every page concatenated. One fetch, whole documentation. |
| [`/openapi.json`](/openapi.json) | 41 paths, 67 operations, generated from the request schemas. A live API serves the same document on `GET /openapi.json` without a key. |
| [`/mcp/tools.json`](/mcp/tools.json) | Every tool with its input schema, read from the running server at build time. |

Through MCP the same material is available without leaving the session:
`bookrail_docs_search` and `bookrail_docs_get` read the packaged pages,
`bookrail_schema` returns the schema of one entity, `bookrail_examples` returns a complete
valid configuration for a vertical, and `bookrail_edge_cases` returns
[the edge case list](/docs/edge-cases/) as markdown, by topic.

There are also three guided prompts on the server: `add-bookings-to-app`,
`model-my-vertical` and `debug-availability`.

## The order that works

An agent that follows this order gets it right the first time. An agent that starts by writing
a configuration from the schema alone usually does not.

```bash
bookrail doctor --json                       # what is configured, what is missing
bookrail examples <vertical> --json          # a complete, valid model to start from
bookrail init --template <vertical> --json   # write bookrail.config.ts
bookrail push --dry-run --json               # read data.plan before applying anything
bookrail push --json
bookrail diff --json                         # data.has_changes must be false
bookrail services list --json                # read back the ids the API assigned

bookrail availability --service svc_... --from ... --to ... --json
bookrail bookings create --service svc_... --start ... --customer-email ... --json
bookrail bookings get bk_... --json          # close the loop on every write
```

Two habits are worth enforcing in a system prompt.

1. **Never build an instant.** Take `start` verbatim from the availability answer. A rounded
   clock time is how you get `start_not_on_grid`, and a bare date is refused outright because
   midnight is not the same instant everywhere.
2. **Read back after every write.** `bookings get` after `bookings create` costs one round trip
   and turns "the command seemed to work" into a fact.

## When it goes wrong, read `fix`

Every error, from the CLI, from MCP and from the API, carries the same shape:

```json
{ "ok": false, "environment": "test",
  "error": {
    "code": "slot_unavailable",
    "message": "The requested slot is no longer available. 1 unit requested, 0 available.",
    "param": "start",
    "fix": "The capacity is gone. Run `bookrail availability --service ... --explain` to see what took it.",
    "doc_url": "https://bookrail.dev/docs/errors#slot_unavailable"
  } }
```

`fix` is an instruction, not a diagnosis. It is written for a machine to act on, and following
it is almost always the right next step. The exit code says how to categorise the failure:
`1` user or configuration, `2` authentication, `3` network or service (retrying is safe,
every `POST` carries an `Idempotency-Key`), `4` conflict (re-read, then decide).

`--explain` is the one to reach for when availability disagrees with expectation. It names the
resource and the reason for every rejected instant:

```
2 instant(s) rejected: occupied 4

local instant     code      resource                              why
----------------  --------  ------------------------------------  ---------------------------------------------------
2026-09-15 08:00  occupied  res_01a0804110a97175a637c6fec7692f85  Court 1 is already taken during the booking window.
2026-09-15 08:00  occupied  res_01a08041128171fdb467a328b0c51390  Court 2 is already taken during the booking window.
```

Through MCP that is `bookrail_explain_unavailable`, which takes one instant and answers the
same question.

## One example, end to end

This is the [quickstart](/docs/quickstart/) written as a script an agent can run without a
human in the loop. It assumes `BOOKRAIL_SECRET_KEY` holds a **test** key.

```bash
set -e
mkdir club && cd club

npx bookrail doctor --json
npx bookrail init --template padel --json
npx bookrail push --dry-run --json          # inspect .data.plan, then apply
npx bookrail push --json
npx bookrail diff --json                    # .data.has_changes must be false

SVC=$(npx bookrail services list --json | jq -r '.data.data[0].id')

# Take a start from the answer, never from a clock.
START=$(npx bookrail availability --service "$SVC" \
  --from 2026-09-14T00:00:00+02:00 --to 2026-09-15T00:00:00+02:00 --json \
  | jq -r '.data.slots[0].start')

BK=$(npx bookrail bookings create --service "$SVC" --start "$START" --duration 60 \
  --customer-email ada@example.com --json | jq -r '.data.id')

npx bookrail bookings get "$BK" --json
npx bookrail events list --json             # every write left a trace
npx bookrail bookings cancel "$BK" --yes --json
```

Nine commands. Against `https://api.bookrail.dev` the whole thing runs in under twenty
seconds; the measured numbers are in the [quickstart](/docs/quickstart/#how-long-it-took).

## Modelling before building

The most common failure is not a wrong call. It is an agent inventing an entity the model does
not have, usually a "slot" table or a "calendar" object.

Four questions, in this order:

1. **What is sold?** A Service, with exactly one duration form.
2. **What has to be free for it to happen?** Resources, listed as the Service's requirements.
   Several things at once means several requirements, not one bigger resource.
3. **How many at once?** `capacity` on the resource, `quantity` on the booking.
4. **What are the rules about time and money?** A Policy. See
   [Policies](/docs/guides/policies/).

Do not model a slot. Slots are computed, never stored, which is exactly why they cannot go
stale. `bookrail_examples` returns a working model for nine verticals, and starting from the
closest one beats starting from the schema.
</content>
