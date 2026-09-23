---
title: 'Quickstart'
description: 'From an API key to a confirmed booking, with the CLI, the SDK or plain HTTP. Every command on this page was run against the production API and timed.'
sidebar:
  order: 11
---

Every command and every response on this page was run against `https://api.bookrail.dev` on
8 September 2026, from a clean project, and copied out of the terminal. Nothing here is typed
by hand.

**The whole walk took 21 seconds of machine time**: 18 seconds for the CLI section and 3
seconds for the SDK one. The timings are at the bottom, step by step. What that number does
not include is the part nobody can measure for you: reading this page, and the minute it takes
to open the confirmation link that gets you a key. Budget ten minutes for the first run and one
minute for every one after it.

## What exists today, and what does not

Bookrail is in early access, and the honest version of that is a short list.

- **The API is live** at `https://api.bookrail.dev`. It is the same code the tests run against.
- **A test key is self service.** Run `npx bookrail signup`, or open
  [/signup](/signup), type an address and open the link we send: that creates the account, the
  project and one `sk_test_...` key, in under two minutes and without writing to anybody. A
  **live** key still comes from a person, so for that one write to
  [hello@bookrail.dev](mailto:hello@bookrail.dev?subject=Bookrail%20live%20key) and say what you
  are building.
- **The packages are on npm.** `bookrail`, `@bookrail/node`, `@bookrail/mcp` and
  `@bookrail/webhook-signature` are published, Apache 2.0
  ([Open source](/docs/open-source/) says what is open and what is not), so the `npx` and
  `npm install` lines below run exactly as they are written. The section that needs nothing
  installed at all is [plain HTTP](#3-with-plain-http-no-package-needed), because the API is up
  and it answers `curl`.
- **Payments need a connected Stripe account.** `payment.mode` of `deposit` or `full` works
  once the project has connected one; without it the call answers `409 stripe_not_connected`.
  `payment.mode: "entitlement"` is still a `400 not_yet_supported`. See
  [Payments with Stripe](/docs/guides/stripe/) and [Policies](/docs/guides/policies/).

## 1. With the CLI

### Get the key

```bash
npx bookrail signup
```

It asks for an address, sends a link there, and waits. Open the link and the command stores the
key with mode 600 in `~/.config/bookrail/credentials.json`. `--no-store` prints it once instead.

If you already have a key, `npx bookrail login` stores it. It asks for the key, checks it
against the API, and writes it to the same file. `--token -` reads it from standard input
instead, which is what a script should do.

```
Stored the test key for project Bookrail smoke (proj_01a07cb881bb73848d0745023ba7aa33) in
~/.config/bookrail/credentials.json (mode 600).

Next steps
  - Run `bookrail whoami --json` to confirm.
  - Run `bookrail init --template <vertical>` to create a bookrail.config.ts.
  - Run `bookrail push --dry-run` to see what would be created.
```

Everything is the test environment until you type `--live`, and a `sk_live_` key used without
`--live` is a hard error rather than a warning.

### Describe the club

```bash
npx bookrail init --template padel
```

That writes `bookrail.config.ts`: one location on `Europe/Rome`, opening hours 08:00 to 23:00
every day, two courts of capacity 1, a group that holds both, a prepaid policy with a two tier
refund, and a service that offers 60 and 90 minutes on a half hour grid.

```ts
export default defineConfig({
  project: 'padel',
  locations: [{ id: 'club', name: 'Club', timezone: 'Europe/Rome' }],
  schedules: {
    club_hours: {
      name: 'Club hours',
      timezone: 'Europe/Rome',
      rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '08:00', to: '23:00' }],
    },
  },
  resources: [
    { id: 'court_1', name: 'Court 1', type: 'court', location: 'club', schedule: 'club_hours' },
    { id: 'court_2', name: 'Court 2', type: 'court', location: 'club', schedule: 'club_hours' },
  ],
  resourceGroups: {
    courts: { name: 'Courts', resources: ['court_1', 'court_2'], allocationStrategy: 'first_available' },
  },
  policies: {
    prepaid: {
      name: 'Prepaid',
      cancellation: [{ before: '12h', refundPercent: 100 }, { before: '0h', refundPercent: 0 }],
      holdDuration: '10m',
      autoComplete: true,
    },
  },
  services: [
    {
      id: 'match',
      name: 'Match',
      durationOptions: [60, 90],
      slotInterval: 30,
      alignTo: 'hour',
      price: { amount: 3000, currency: 'EUR' },
      policy: 'prepaid',
      bookingWindow: { minNoticeMinutes: 60, maxAdvanceDays: 14 },
      requirements: [{ group: 'courts', quantity: 1 }],
    },
  ],
});
```

The file the template writes also carries `deposit` and `paymentTiming` on the policy, which
are stored and honoured as data and move no money: see [Policies](/docs/guides/policies/).

Nine vertical templates ship with the CLI: `bookrail init --help` lists them, and
`bookrail examples <vertical>` prints a fuller model without writing anything.

### See the plan, then apply it

```bash
npx bookrail push --dry-run
```

```
[test] plan (dry run, nothing applied): 7 to create

action  kind            id          name        changes
------  --------------  ----------  ----------  -------
create  location        club        Club
create  schedule        club_hours  Club hours
create  resource        court_1     Court 1
create  resource        court_2     Court 2
create  resource group  courts      Courts
create  policy          prepaid     Prepaid
create  service         match       Match

Next steps
  - Run `bookrail push` to apply it.
```

```bash
npx bookrail push
```

The same table, with `applied` instead of `plan`. Objects are matched by
`metadata.config_id`, never by name, so a second `push` updates rather than duplicates, and an
object that has no `config_id` is reported as unmanaged and left alone. Deletions need `--yes`.

### Ask what is free

```bash
npx bookrail availability \
  --service svc_01a08041186277d699e4cf0ac77eec54 \
  --from 2026-09-14T00:00:00+02:00 \
  --to   2026-09-15T00:00:00+02:00
```

```
[test] 57 slot(s) for svc_01a08041186277d699e4cf0ac77eec54, times shown in Europe/Rome

start (UTC)               local             end (UTC)                 min  cap  price      resources
------------------------  ----------------  ------------------------  ---  ---  ---------  ------------------------------------------------
2026-09-14T06:00:00.000Z  2026-09-14 08:00  2026-09-14T07:00:00.000Z  60   1    30.00 EUR  res_01a0804110a97175a637c6fec7692f85 | res_01...
2026-09-14T06:00:00.000Z  2026-09-14 08:00  2026-09-14T07:30:00.000Z  90   1    30.00 EUR  res_01a0804110a97175a637c6fec7692f85 | res_01...
2026-09-14T06:30:00.000Z  2026-09-14 08:30  2026-09-14T07:30:00.000Z  60   1    30.00 EUR  res_01a0804110a97175a637c6fec7692f85 | res_01...
```

57 is not a round number, and it is not supposed to be: 08:00 to 23:00 on a half hour grid
gives 29 starts for the 60 minute option (08:00 to 22:00) and 28 for the 90 minute one, whose
last start is 21:30 because 22:00 plus 90 minutes would run past closing. Instants go in with
an explicit offset and come out in UTC; `--tz` changes only the local column, never the grid.
A bare date is refused, with the reason:

```
Error [parameter_invalid] --from must be an ISO 8601 instant with an explicit offset, got "2026-09-14".
  param: from
  Fix: Write it as `2026-09-08T07:00:00Z` or `2026-09-08T09:00:00+02:00`. A bare date is refused because midnight is not the same instant in every time zone.
  https://bookrail.dev/docs/errors#parameter_invalid
```

### Book one

```bash
npx bookrail bookings create \
  --service svc_01a08041186277d699e4cf0ac77eec54 \
  --start 2026-09-14T18:00:00+02:00 \
  --duration 60 \
  --customer-email ada@example.com \
  --customer-name "Ada Lovelace"
```

```
[test] booked bk_01a0804124a974cfb34faa100c8dc6cf · confirmed
field            value
---------------  ------------------------------------
service          svc_01a08041186277d699e4cf0ac77eec54
start (UTC)      2026-09-14T16:00:00.000Z
local            2026-09-14 18:00 Europe/Rome
end (UTC)        2026-09-14T17:00:00.000Z
duration         60 min
quantity         1
price            30.00 EUR
customer         cus_01a0804122dd778ebca84130540b4ee1
hold
next transition  complete at 2026-09-14T17:00:00.000Z

allocation                             resource                              role  units
-------------------------------------  ------------------------------------  ----  -----
ball_01a080412534755d93e77dd5cc1dd2ce  res_01a0804110a97175a637c6fec7692f85        1
```

That is the whole loop. The customer was created inline from the email; the courts are
capacity 1, so the second court is still free at that instant and the third attempt is not.
Here is what the third attempt actually says:

```
Error [slot_unavailable] The requested slot is no longer available. 1 unit requested, 0 available. No resource can serve requirement 01a08041-1890-7221-ae47-285fdac0d66b (Court 2).
  param: start
  request id: req_4ed7ea90ffd795fd2f8231a5
  Fix: The capacity is gone. Run `bookrail availability --service ... --explain` to see what took it.
  https://bookrail.dev/docs/errors#slot_unavailable
```

And `--explain` names who took it:

```
[test] 0 slot(s) for svc_01a08041186277d699e4cf0ac77eec54, times shown in Europe/Rome

2 instant(s) rejected: occupied 4

local instant     code      resource                              why
----------------  --------  ------------------------------------  ---------------------------------------------------
2026-09-15 08:00  occupied  res_01a0804110a97175a637c6fec7692f85  Court 1 is already taken during the booking window.
2026-09-15 08:00  occupied  res_01a08041128171fdb467a328b0c51390  Court 2 is already taken during the booking window.
2026-09-15 08:30  occupied  res_01a0804110a97175a637c6fec7692f85  Court 1 is already taken during the booking window.
2026-09-15 08:30  occupied  res_01a08041128171fdb467a328b0c51390  Court 2 is already taken during the booking window.
```

### Take the events

```bash
npx bookrail webhooks create \
  --url https://example.com/hooks/bookrail \
  --events booking.created --events booking.cancelled
```

```
[test] created wh_01a0804128b974cba21b5c55d26fe2f1 -> https://example.com/hooks/bookrail
subscribed to: booking.created, booking.cancelled

signing secret: whsec_...

This is the only time the secret is shown. It is stored encrypted and no endpoint will
ever return it again. If you lose it, the only remedy is to create another endpoint.
Put it in your receiver now (BOOKRAIL_WEBHOOK_SECRET) and verify every delivery against it.
```

Store the secret at that moment: it is shown once and encrypted at rest, and no endpoint
returns it again. Then watch what arrives:

```bash
npx bookrail webhooks listen --max 1 --duration 40
```

```
[test] no --url given, so nothing was registered: following the event log instead.
The objects below are exactly what a delivery would have carried, byte for byte, but no
endpoint was called and no signature was produced. To exercise a real delivery, expose a
local port (ngrok, cloudflared, ...) and re-run with `--url <public url> --port <port>`.
[test] following the event log every 2s. Ctrl-C to stop.
2026-09-08T09:03:15.475Z  booking.cancelled      bk_01a0804124a974cfb34faa100c8dc6cf
[test] stopped (max) after 1 event(s).

Next steps
  - This mode registers nothing and verifies no signature.
  - Run `bookrail webhooks listen --url <public url> --port 4100` to receive real deliveries.
  - Resume exactly here: `bookrail events list --follow --starting-after evt_01a08041defd7583b1ea5f6e378e9e23`.
```

With a public URL (`--url https://<your tunnel> --port 4100`) the same command registers a
temporary endpoint, receives the real POSTs, verifies every `Bookrail-Signature`, and deletes
the endpoint on the way out. Without one it polls the event log, which carries the same
objects and no signature, and says so. The CLI does not open a tunnel for you.
[Webhooks](/docs/guides/webhooks/) has the rest: the ladder, replays, and the SSRF rule.

## 2. With the SDK

The configuration above is code, and the CLI pushes it. The SDK is for the part your
application does at runtime: ask, book, read back.

```bash
npm install @bookrail/node
```

```ts
import Bookrail from '@bookrail/node';

const bookrail = new Bookrail(process.env.BOOKRAIL_SECRET_KEY!);
const service = 'svc_01a08041186277d699e4cf0ac77eec54';

const { slots } = await bookrail.availability.list({
  service_id: service,
  from: '2026-09-15T00:00:00+02:00',
  to: '2026-09-16T00:00:00+02:00',
  timezone: 'Europe/Rome',
});
console.log(`${slots.length} slots, first at ${slots[0].start}`);

const params = {
  service_id: service,
  start: slots[0].start,
  duration_minutes: slots[0].duration_minutes,
  customer: { email: 'ada@example.com', name: 'Ada Lovelace' },
};
const options = { idempotencyKey: 'quickstart-demo-1' };

const booking = await bookrail.bookings.create(params, options);
console.log(`${booking.id} ${booking.status} ${booking.start} -> ${booking.end}`);

// The same call again, with the same key: no second booking, and the API says so.
const again = await bookrail.bookings.create(params, options).withResponse();
console.log(`retry -> ${again.data.id} replayed=${again.response.idempotentReplayed}`);
```

```
57 slots, first at 2026-09-15T06:00:00.000Z
bk_01a080425290775faa2272a54296ccb2 confirmed 2026-09-15T06:00:00.000Z -> 2026-09-15T07:00:00.000Z
retry -> bk_01a080425290775faa2272a54296ccb2 replayed=true
```

Three lines, one booking. That last line is the whole point of
[idempotency](/docs/guides/idempotency/): the key is taken with a unique constraint in the
database, not checked with a read, so a retry cannot become a second booking even when the two
requests are in flight at the same moment. If you do not pass a key, the SDK generates one and
sends the same one on every retry of that call.

The full surface, one method per operation of the API, is the
[SDK reference](/docs/sdk/). It is `packages/sdk-node/README.md`, published here and on npm
from the same file.

## 3. With plain HTTP, no package needed

This is the section that runs today, because it needs nothing but a key and `curl`.

```bash
curl -s https://api.bookrail.dev/v1/availability \
  -H "Authorization: Bearer $BOOKRAIL_SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"service_id":"svc_01a08041186277d699e4cf0ac77eec54",
       "from":"2026-09-16T00:00:00+02:00",
       "to":"2026-09-17T00:00:00+02:00",
       "timezone":"Europe/Rome"}'
```

```json
{
  "object": "availability",
  "service_id": "svc_01a08041186277d699e4cf0ac77eec54",
  "timezone": "Europe/Rome",
  "granularity": "slots",
  "slots": [
    {
      "object": "availability_slot",
      "start": "2026-09-16T06:00:00.000Z",
      "end": "2026-09-16T07:00:00.000Z",
      "duration_minutes": 60,
      "available_capacity": 1,
      "price": { "amount": 3000, "currency": "EUR" },
      "resource_options": [
        { "resources": [{ "resource_id": "res_01a0804110a9...", "role": null, "capacity_used": 1 }] },
        { "resources": [{ "resource_id": "res_01a0804112817...", "role": null, "capacity_used": 1 }] }
      ]
    }
  ]
}
```

(The two identifiers are shortened here for the page. The response carries them in full, and
`resource_options` is the list of concrete combinations that can serve the slot: either court.)

```bash
curl -s https://api.bookrail.dev/v1/bookings \
  -H "Authorization: Bearer $BOOKRAIL_SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: quickstart-curl-1' \
  -d '{"service_id":"svc_01a08041186277d699e4cf0ac77eec54",
       "start":"2026-09-16T06:00:00Z",
       "duration_minutes":60,
       "customer":{"email":"ada@example.com","name":"Ada Lovelace"}}'
```

The booking comes back with 40 required fields. The ones worth reading first:

```json
{
  "id": "bk_01a08043651774e9aedfb770932801c9",
  "object": "booking",
  "status": "confirmed",
  "start": "2026-09-16T06:00:00.000Z",
  "end": "2026-09-16T07:00:00.000Z",
  "duration_minutes": 60,
  "timezone": "Europe/Rome",
  "price": { "amount": 3000, "currency": "EUR" },
  "policy_snapshot": {
    "name": "Prepaid",
    "cancellation": [{ "before": "12h", "refund_percent": 100 }, { "before": "0h", "refund_percent": 0 }],
    "auto_complete": true,
    "hold_duration_seconds": 600
  },
  "next_transition": "complete",
  "next_transition_at": "2026-09-16T07:00:00.000Z",
  "allocations": [
    { "object": "booking_allocation", "resource_id": "res_01a0804110a9...", "capacity_used": 1 }
  ],
  "environment": "test",
  "created_at": "2026-09-08T09:04:55.167Z"
}
```

`policy_snapshot` is the policy as it stood at the moment of the sale, copied into the
booking. Change the policy tomorrow and this booking still refunds by these tiers. That is
[Policies](/docs/guides/policies/), and it is the reason the field is there rather than a
`policy_id` alone.

Send the same request again with the same `Idempotency-Key` and the response headers say what
happened:

```
HTTP/2 201
bookrail-request-id: req_2b119f20e3bc04f555dacee3
bookrail-version: 2026-09-01
idempotent-replayed: true
```

## How long it took

Wall clock, one laptop on a home connection in Italy, against `api.bookrail.dev`, on
8 September 2026. Each number is one process, cold Node start included.

| Step | Command | Time |
| --- | --- | --- |
| 1 | `bookrail login` | 0.80 s |
| 2 | `bookrail whoami` | 0.58 s |
| 3 | `bookrail init --template padel` | 0.10 s |
| 4 | `bookrail push --dry-run` | 2.10 s |
| 5 | `bookrail push` (7 objects created) | 5.66 s |
| 6 | `bookrail availability` (one day, 57 slots) | 1.09 s |
| 7 | `bookrail bookings create` | 1.51 s |
| 8 | `bookrail webhooks create` | 0.71 s |
| 9 | `bookrail webhooks listen` plus a cancellation | 5.34 s |
| | **CLI section** | **17.9 s** |
| | SDK section (availability, booking, replayed retry) | 2.6 s |
| | HTTP section (availability, booking, replay) | 3.1 s |

The one slow step is `push`, and it is slow because it creates seven objects in seven
round trips. Nothing else is over two seconds.

## Where to go next

- [Concepts](/docs/concepts/): the model behind the config file, with the figures.
- [The edge cases of booking](/docs/edge-cases/): what goes wrong in booking systems, what
  this one does about each case, and the test that proves it.
- [API reference](/docs/api/reference/): all 73 operations, generated from the specification
  the server serves.
- [For AI agents](/docs/for-ai-agents/): the same loop, driven by a coding agent through the
  CLI or the MCP server.
</content>
