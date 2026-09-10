# `@bookrail/mcp`

The Bookrail MCP server: booking infrastructure for coding agents, over the Model Context
Protocol. **36 tools**, 4 resources and 3 guided prompts, on stdio.

```bash
# Wire it into a client, from the CLI itself
npx bookrail mcp install --client claude-code   # or cursor, vscode, windsurf, generic

# Or run it by hand
npx @bookrail/mcp
```

`mcp install` writes or updates the `bookrail` entry in the client's own configuration file
(`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `~/.codeium/windsurf/mcp_config.json`),
preserves every other server and every key it does not own, refuses a file that is not valid
JSON rather than replacing it, and **never writes a credential**.

## Configuration

| Variable | What it does |
| --- | --- |
| `BOOKRAIL_SECRET_KEY` | The key. Or `BOOKRAIL_TEST_SECRET_KEY` and `BOOKRAIL_LIVE_SECRET_KEY`. |
| `BOOKRAIL_API_URL` | The API. Defaults to the public one. |
| `BOOKRAIL_MCP_ALLOW_LIVE` | `1` to permit the live environment at all. |

With no variables set, the server reads the same `~/.config/bookrail/credentials.json` that
`bookrail login` writes.

## The guardrails

An agent holding a key can cancel a real customer's booking, so the defaults assume it will
try.

- **Test is the default.** The live environment needs `BOOKRAIL_MCP_ALLOW_LIVE=1` **and** a
  live key. Either one alone does nothing.
- **Irreversible tools preview first.** They return what they would do plus
  `requires_confirmation: true`, and act only when called again with `confirm: true`.
- **Every tool is annotated.** `readOnlyHint`, `destructiveHint`, `idempotentHint` and
  `openWorldHint` are on all 36, so a client that gates on them has something real to gate on.
- **stdout belongs to the protocol.** `process.stdout.write` is replaced at startup, so nothing
  but JSON-RPC frames can reach the transport.
- **Every failure is structured.** An `isError` result carrying `{ code, message, fix,
  doc_url }`, the same contract as the CLI and the API.

## What is in it

Tools for the whole loop: `bookrail_project_info`, `bookrail_doctor`, `bookrail_examples`,
`bookrail_schema`, `bookrail_config_validate`, `bookrail_config_push`, `bookrail_config_pull`,
the object CRUD (`bookrail_objects_list`, `bookrail_object_get|create|update|delete`),
availability (`bookrail_availability`, `bookrail_availability_next`,
`bookrail_availability_check`, `bookrail_explain_unavailable`), holds, the booking lifecycle,
events, webhooks, and the documentation tools `bookrail_docs_search`, `bookrail_docs_get` and
`bookrail_edge_cases`.

Resources: `bookrail://docs/{path}`, `bookrail://schema/{entity}`, `bookrail://config`,
`bookrail://project`. Prompts: `add-bookings-to-app`, `model-my-vertical`,
`debug-availability`.

The generated list, with every input schema and annotation, is
[bookrail.dev/mcp/tools.json](https://bookrail.dev/mcp/tools.json), and the readable version is
[bookrail.dev/docs/mcp](https://bookrail.dev/docs/mcp/). Both are produced by asking the
running server, so they cannot drift from it.

## How it is built

The server drives the `bookrail` CLI **in process** rather than reimplementing its HTTP client.
One client, one error contract, one set of validations: a tool cannot behave differently from
the command it wraps. One dependency of its own beyond `zod`:
`@modelcontextprotocol/sdk`.

Measured: about 120 ms from spawn to the answer to `tools/list`, 25 MB and 91 packages
installed.

## Documentation

- [Coding agents](https://bookrail.dev/docs/guides/agents/): the guide.
- [For AI agents](https://bookrail.dev/docs/for-ai-agents/): the machine readable surface.
- [MCP reference](https://bookrail.dev/docs/mcp/): every tool.

## Status

Early access. The API is live at `https://api.bookrail.dev`, keys are issued by hand
(hello@bookrail.dev), and this package is on npm as
[`@bookrail/mcp`](https://www.npmjs.com/package/@bookrail/mcp), Apache 2.0, with its source in
[github.com/bookrail-dev/bookrail](https://github.com/bookrail-dev/bookrail) under
`packages/mcp`.

## Licence

Apache-2.0.
