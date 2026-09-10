# For coding agents

The rules this CLI is built to, so that an agent can drive it without guessing.

1. **Self-describing.** Every command's `--help` says what it does, what it needs, what it
   returns, and what to do next.
2. **Structured output always available.** Every command takes `--json`. Nothing has to be
   parsed out of human text.
3. **Errors say how to fix them.** Every error carries a `fix` field: an operative sentence,
   not a diagnosis.
4. **Idempotent and safe by default.** Every `POST` the CLI makes carries an
   `Idempotency-Key`. Destructive operations need `--yes`.
5. **Test and live separated and visible.** Every output declares its `environment`. The
   default is test; live needs `--live`, and a live key used without it is refused before any
   request leaves the process.
6. **No hidden interactivity.** Every prompt has a flag that replaces it. When stdout is not a
   terminal the CLI never asks: it fails with a `fix` instead of hanging.
7. **Verifiability.** Every action has a way to check its outcome: `bookrail diff` after a
   push, `bookrail doctor` when something is wrong, `bookrail <entity> get` after a write.

## Recommended order of operations

```bash
bookrail doctor --json                       # what is configured, what is missing
bookrail init --template <vertical> --json   # write bookrail.config.ts
bookrail push --dry-run --json               # read `data.plan` before applying
bookrail push --json                         # apply
bookrail diff --json                         # data.has_changes must be false
bookrail services list --json                # read back the svc_ ids

bookrail availability --service svc_... --from ... --to ... --json      # what is bookable
bookrail availability --service svc_... --from ... --to ... --explain --json   # and why not
bookrail bookings create --service svc_... --start ... --customer-email ... --json
bookrail bookings get bk_... --json          # close the loop on every write
```

`bookrail schema config --json` gives the JSON Schema to write a config against.
`bookrail examples <vertical> --json` gives a complete, working model plus the calls that
follow it. `bookrail docs <topic> --markdown` prints this documentation offline.

## Mapping a business onto the model

Ask four questions, in this order:

1. **What is sold?** That is a Service, and it needs exactly one duration form.
2. **What has to be free for it to happen?** Those are Resources, and the Service's
   requirements. If several must be free at the same time, list several requirements.
3. **How many at once?** That is `capacity` on the resource, and `quantity` on the booking.
   If the count lives on one thing (the seats of a class) put the capacity there and make the
   other requirements `consumes: "whole"`.
4. **What are the rules about money and time?** That is a Policy.

Do not model a "slot": slots are computed, never stored.

## Things that will bite

- Ids in a config are **logical**. The `svc_...` identifier only exists after a push.
- A push never touches an object with no `metadata.config_id`. If you created objects through
  the API, `bookrail pull` will show them but pushing that file will create copies. To take
  them over, use `bookrail pull --adopt` (stamps all of them) or
  `bookrail push --adopt <kind>:<config_id>=<remote_id>` (one, named by its remote id).
  Nothing is ever adopted by name: names are not unique.
- `align_to` and `slot_interval` decide which instants exist. A service with no grid accepts
  any instant inside the opening hours.
- Amounts are integers in the minor unit: `3000` is 30.00 EUR.
- Instants in must carry an explicit offset; instants out are UTC. A bare date is refused by
  the CLI before the request: midnight is not the same instant in every time zone.
- `bookrail webhooks test` exits 0 even when the endpoint answers 500. The delivery happened,
  and that is the answer: branch on `data.status` (`succeeded` / `failed`). The same rule
  applies to `bookrail diff` and `data.has_changes`.
- `--follow` and `webhooks listen` need `--max` or `--duration` when combined with `--json`:
  one envelope cannot be printed by a loop that never ends.
