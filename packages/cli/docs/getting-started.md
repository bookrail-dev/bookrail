# Getting started

Bookrail is booking infrastructure: availability, holds, bookings, policies and webhooks
behind one HTTP API. This CLI describes a project as code and talks to that API.

## The loop

```bash
bookrail login                       # store a sk_test_ key, mode 600
bookrail init --template padel       # write bookrail.config.ts
bookrail push --dry-run              # see what would be created
bookrail push                        # create it
bookrail diff                        # confirm the project matches the file
bookrail doctor                      # check credentials, project, reachability, version, config
```

Then you operate on it:

```bash
bookrail availability --service svc_... --from 2026-09-11T00:00:00Z --to 2026-09-12T00:00:00Z
bookrail availability --service svc_... --from ... --to ... --explain   # why an instant is not there
bookrail holds create --service svc_... --start 2026-09-11T06:00:00Z --ttl 10m
bookrail bookings create --service svc_... --start 2026-09-11T06:00:00Z --hold hold_...
bookrail bookings cancel bk_... --yes
bookrail webhooks create --url https://example.com/hooks/bookrail       # the secret, once
bookrail webhooks listen --url https://<your tunnel> --port 4100        # watch deliveries land
bookrail events list --follow                                           # watch the log
```

Everything is `test` until you type `--live`. A `sk_live_` key used without `--live` is a
hard error, not a warning: no request built by this process can reach the live environment
unless you asked for it.

## Where the key comes from

1. `BOOKRAIL_SECRET_KEY` in the environment, if set.
2. `~/.config/bookrail/credentials.json` (or `$XDG_CONFIG_HOME/bookrail/credentials.json`),
   written by `bookrail login` with mode 600.

The key is never printed. `bookrail whoami` and `bookrail env` show it masked; `whoami` also
names the project the key opens, its scopes and its `tenant_id`.

## Output

Every command takes `--json` and prints

```json
{ "ok": true, "environment": "test", "data": { }, "next_steps": ["..."] }
```

and on failure

```json
{ "ok": false, "environment": "test",
  "error": { "code": "...", "message": "...", "param": "...", "doc_url": "...", "fix": "..." } }
```

Exit codes: `0` success, `1` user or configuration error, `2` authentication, `3` network or
service, `4` conflict (the state changed under you; retrying may work).

Colour and decoration are off whenever stdout is not a terminal, and always off with `--json`.
