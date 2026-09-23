# `bookrail`

The Bookrail command line interface: booking infrastructure as code, and every operation of the
API, designed so a person and a coding agent can use the same tool.

- **Install nothing**: `npx bookrail <command>`.
- Three runtime dependencies, none of which has dependencies of its own: 6.6 MB and 4 packages
  installed.
- `--json` on **every** command, printing one envelope. Exit codes `0` success, `1` user or
  configuration, `2` authentication, `3` network or service, `4` conflict.
- Test is the default environment. A `sk_live_` key used without `--live` is refused before any
  request leaves the process.

```bash
npx bookrail login                       # store a sk_test_ key, mode 600
npx bookrail init --template padel       # write bookrail.config.ts
npx bookrail push --dry-run              # see the plan
npx bookrail push                        # apply it
npx bookrail availability --service svc_... --from 2026-09-14T00:00:00+02:00 --to 2026-09-15T00:00:00+02:00
npx bookrail bookings create --service svc_... --start 2026-09-14T18:00:00+02:00 --customer-email ada@example.com
```

## What it can do

| Group | Commands |
| --- | --- |
| Credentials | `login`, `logout`, `whoami`, `env`, `version`, `doctor` |
| Configuration as code | `init` (nine verticals), `push`, `pull`, `diff` |
| Objects | `locations`, `resources`, `resource_groups`, `schedules`, `services`, `policies`, `customers` |
| Operating | `availability` (with `next`, `check`, `--explain`), `holds`, `bookings` (create, get, list, confirm, cancel, reschedule, check-in, no-show, complete) |
| Events | `webhooks` (including `listen`), `events list --follow` |
| Payments | `stripe connect`, `stripe status`, `stripe disconnect --yes`, `payments get`, `payments list` |
| Offline | `schema`, `examples`, `docs` |
| Agents | `mcp install --client claude-code \| cursor \| vscode \| windsurf \| generic` |

`bookrail --help` and `bookrail <command> --help` are the reference, and the site publishes
exactly that output at [bookrail.dev/docs/cli](https://bookrail.dev/docs/cli/).

## Connecting Stripe

`bookrail stripe connect` prints a Stripe authorisation link, opens it in your browser, and
waits until you have authorised. Your Stripe account stays yours: charges are made directly on
it and Bookrail never sees or stores a Stripe key of yours, so there is nothing to paste.
`--no-open` on a machine with no desktop, `--no-wait` in a script, `stripe status` to read the
account back, `stripe disconnect --yes` to revoke.

## Taking a deposit

```bash
bookrail bookings create --service svc_... --start 2026-10-05T09:00:00+02:00 --payment deposit
```

`--payment deposit` uses the `deposit` rule of the policy, `--payment full` charges the whole
price. The booking is created `pending` and holds its slot, and the output carries the
`client_secret`, the account and the platform publishable key to pass to Stripe.js. The secret
is shown **once** and is stored nowhere: `bookrail payments get pay_...` reads it back from
Stripe for as long as the payment is pending.

`bookrail payments list --booking bk_...` shows what has been charged and what has gone back.
A refund is what `bookrail bookings cancel` does, according to your policy; there is no
`payments refund`, because there is no endpoint behind it.

Not here yet: a deferred balance, saved cards, charging a no-show, and rescheduling a booking
that has money on it.

## Configuration as code

`bookrail.config.ts` describes locations, schedules, resources, groups, policies and services.
`push` matches objects by `metadata.config_id`, never by name, so a second push updates instead
of duplicating, and an object with no `config_id` is reported as unmanaged and left alone.
Deletions need `--yes`. `--adopt kind:config_id=remote_id` takes over one existing object,
explicitly.

## Where the key comes from

1. `BOOKRAIL_SECRET_KEY` in the environment, if set.
2. `~/.config/bookrail/credentials.json` (or `$XDG_CONFIG_HOME/bookrail/credentials.json`),
   written by `bookrail login` with mode 600.

The key is never printed. `whoami` and `env` show it masked.

## Output

```json
{ "ok": true, "environment": "test", "data": {}, "next_steps": ["..."] }
```

```json
{ "ok": false, "environment": "test",
  "error": { "code": "...", "message": "...", "param": "...", "doc_url": "...", "fix": "..." } }
```

`fix` is an instruction, not a diagnosis. Colour and decoration are off whenever stdout is not
a terminal, and always off with `--json`.

## Documentation

- [Quickstart](https://bookrail.dev/docs/quickstart/), timed against the production API.
- [CLI basics](https://bookrail.dev/docs/cli-basics/) and the full
  [CLI reference](https://bookrail.dev/docs/cli/).
- [Coding agents](https://bookrail.dev/docs/guides/agents/) and
  [For AI agents](https://bookrail.dev/docs/for-ai-agents/).

## Status

Early access. The API is live at `https://api.bookrail.dev`, a **test key is self service**
(`npx bookrail signup`, or [bookrail.dev/signup](https://bookrail.dev/signup)) while a **live
key** still comes from a person (hello@bookrail.dev), and this package is on npm as
[`bookrail`](https://www.npmjs.com/package/bookrail), Apache 2.0, with its source in
[github.com/bookrail-dev/bookrail](https://github.com/bookrail-dev/bookrail) under
`packages/cli`. `logs`, `requests`, `keys`, `projects`, `dev`, `migrate` and `upgrade` answer
`not_yet_available`, because there is no endpoint behind them.

## Licence

Apache-2.0.
