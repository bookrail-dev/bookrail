---
title: 'Policies'
description: 'Cancellation tiers, reschedule fees, no show charges and deposits, how the policy is frozen into the booking, and what happens when there are no payments.'
sidebar:
  order: 44
---

A policy is the set of rules that apply **after** a booking exists: what a cancellation
refunds, what a move costs, what happens when nobody turns up, and how long a hold lives.

Two things about it are worth reading before anything else.

1. **The policy is frozen into the booking at the moment of sale**, as `policy_snapshot`. The
   live policy is irrelevant to a booking that already exists.
2. **No money moves.** There is no payment provider yet. Everything below is computed and
   written as an expectation, and `amount_refunded` never changes on its own. The section at
   the bottom says exactly which fields are real numbers and which are intentions.

## The shape of a policy

```ts
policies: {
  prepaid: {
    name: 'Prepaid',
    cancellation: [
      { before: '12h', refundPercent: 100 },
      { before: '0h', refundPercent: 0 },
    ],
    deposit: { type: 'percent', value: 100 },
    paymentTiming: 'at_booking',
    holdDuration: '10m',
    autoComplete: true,
  },
}
```

Over HTTP the same object is `POST /v1/policies` in `snake_case`. A duration is digits plus one
of `s`, `m`, `h`, `d`. A bare number is **not** a duration and is refused: it used to be read
as milliseconds, so `{ "before": 24 }` meant 24 milliseconds and refunded zero without saying
anything.

## Cancellation: tiers by distance from the start

Tiers are ordered from furthest to nearest, and the first one that is still true wins, which is
the most generous applicable one.

```json
[
  { "before": "48h", "refund_percent": 100 },
  { "before": "24h", "refund_percent": 50 },
  { "before": "0h",  "refund_percent": 0 }
]
```

- **The edge of a tier is inclusive.** `before: "48h"` still applies at exactly 48 hours from
  the start and no longer applies at 47 hours 59 minutes 59.999 seconds. That is tested to the
  millisecond on every edge, because "about two days" is not a contract.
- **After the start nothing is refunded**, unless a `{ "before": "0h" }` tier says otherwise,
  and even then only up to the instant of the start.
- **No tiers, or no policy at all, refunds nothing.** An absent rule is not a promise.
- **The refund is computed on `amount_paid`, not on the price.** Refunding a percentage of a
  price nobody paid is how a system refunds money it never took.
- **A malformed tier is dropped, not fatal.** The snapshot is a copy of a row that may be years
  old, and refusing to cancel a booking because of a two year old typo would be the wrong
  error. Malformed covers an unreadable `before` and values out of range: a `refund_percent`
  outside 0 to 100 and a negative fee are dropped like the rest.

A provider cancellation (`by: "provider"`) refunds 100 percent, unless
`override_refund_percent` says otherwise. That override is the explicit way to grant a refund
your own policy does not allow, and it is recorded as an override, so the trail stays honest.

```bash
npx bookrail bookings cancel bk_... --yes
```

```
[test] cancelled bk_01a0804124a974cfb34faa100c8dc6cf · cancelled
field            value
---------------  ------------------------------------
start (UTC)      2026-09-14T16:00:00.000Z
price            30.00 EUR
refund           100% (0 minor units expected)

Next steps
  - The refund is an expectation, not a movement: payments do not exist yet, so `amount_refunded` is untouched.
```

100 percent of nothing is nothing, and the CLI says both parts.

## Reschedule: a fee, and a limit

The same tier structure with `fee` instead of `refund_percent`, plus `max_reschedules` per
booking.

The fee comes from the tier applicable to the distance between now and the start of the **old**
booking, the one whose terms the customer accepted, and it is written as
`reschedule_fee_expected` on the **new** booking, which is the one a payment would attach to.
`max_reschedules` is compared with `reschedule_count`, which the new booking inherits
incremented; past the limit it is `422 max_reschedules_reached`.

A reschedule is not an update: it creates a second booking, links the two in both directions,
and leaves exactly one live occupancy. The price difference between the old slot and the new
one is **not** computed yet; the new booking freezes the service price as it stands at the
moment of the move.

## No show

- `grace_minutes`: how long after the start a booking may be marked as a no show. Before that
  instant it is `422 no_show_too_early`, manual or automatic. Without a policy the grace is 0.
- `charge_percent`: `no_show_charge_expected` is `floor(price × charge_percent / 100)`, on the
  **price** rather than on what was paid, because it is a charge and not a refund. Out of range
  values count as 0.
- `auto_mark: true` schedules the marking at creation and reschedules it after every
  transition. A check in removes it. An automatic start does not, because starting is not the
  same as turning up.

Marking a no show **releases the occupancy**: the customer did not come, and the rest of the
slot goes back on sale. A completed booking keeps its occupancy, because the service happened.

## Prices that depend on the slot

A service has one `price`. `pricing_rules` changes it for the slots that match a condition, and
the price a slot shows is the price its booking freezes.

```ts
{
  id: 'match',
  name: 'Match 60',
  duration: 60,
  price: { amount: 3000, currency: 'EUR' },
  pricingRules: [
    { when: { days: ['sat', 'sun'] }, price: 4000, label: 'Weekend' },
    { when: { timeFrom: '18:00', timeTo: '23:00' }, priceAdd: 1000, label: 'Evening' },
  ],
}
```

Pushed to a real project, one court open 09:00 to 23:00 Rome, this is what `bookrail
availability` answers. Friday:

```
start (UTC)               local             price      rule
------------------------  ----------------  ---------  ----------
2026-09-25T07:00:00.000Z  2026-09-25 09:00  30.00 EUR  base
...
2026-09-25T16:00:00.000Z  2026-09-25 18:00  40.00 EUR  #1 Evening
2026-09-25T20:00:00.000Z  2026-09-25 22:00  40.00 EUR  #1 Evening
```

Saturday:

```
start (UTC)               local             price      rule
------------------------  ----------------  ---------  ----------
2026-09-26T07:00:00.000Z  2026-09-26 09:00  40.00 EUR  #0 Weekend
...
2026-09-26T20:00:00.000Z  2026-09-26 22:00  40.00 EUR  #0 Weekend
```

Saturday evening is 40.00, **not** 50.00. That is the rule that matters most: the rules are
evaluated in order and the **first match wins**, with no chaining. The weekend rule comes
first, so it decides, and the evening rule never runs that day.

Every slot carries the rule that priced it:

```json
{
  "object": "availability_slot",
  "start": "2026-09-26T07:00:00.000Z",
  "end": "2026-09-26T08:00:00.000Z",
  "duration_minutes": 60,
  "available_capacity": 1,
  "price": { "amount": 4000, "currency": "EUR" },
  "price_rule": { "index": 0, "label": "Weekend" }
}
```

`price_rule` is `null` when the flat price applied. The booking freezes both: `booking.price`
and `booking.price_rule` are what the slot said at the moment of sale, and they do not move
afterwards, not when the rules change and not on a reschedule.

### The rules of a rule

- **`when` is an and.** `days` (local weekday names), `time_from`/`time_to`, `date_from`/
  `date_to` (inclusive), `resource_id`, `duration_min` (an equality, not a minimum). All of
  them are read on the **start** of the slot, on the **local clock of the offer**, never the
  caller's: a Saturday surcharge is the club's Saturday.
- **`time_from`/`time_to` is half open**, `[from, to)`, and wraps when `to` is before `from`:
  `22:00`-`02:00` is the night rate. Give both or neither, and give two different times.
- **Exactly one effect** per rule: `price` replaces, `price_add` adds (it may be negative, and
  the result never goes below zero), `price_multiplier` scales (at most four decimals, rounded
  to the minor unit with half rounding up, so `2500 x 1.15` is `2875` and `1999 x 0.8` is
  `1599`).
- **`label`** is free text, at most 60 characters, and comes back in `price_rule`.
- **A `when` with no condition at all is refused**, and so is a rule on a service with no
  `price`: there would be nothing to modify, and everything after an always-matching rule
  would be dead.
- At most 100 rules. A malformed one is a `400 parameter_invalid` whose `param` names its
  index, `pricing_rules[3].when.time_from`.

Two nights a year the local clock is not a function of the wall time, and the rules follow it
rather than paper over it: on the spring forward night no instant reads 02:30, so a rule about
`[02:00, 03:00)` matches nothing; on the fall back night two instants do, and it matches both.
[The edge cases](/docs/edge-cases/) has the tests.

## Deposits and payment timing

The policy describes them and the booking freezes them:

- `payment_timing`: `at_booking`, `deposit_then_balance`, `after_service`, or `none`.
- `deposit`: `{ type: 'percent' | 'fixed', value }`.

They are honoured as data. They do not charge anything, because there is nothing to charge
with. A request that asks for more, `payment.mode` other than `none`, is a
`400 not_yet_supported` rather than a silent no-op.

## Holds, confirmation and customer limits

The policy also carries the rules that shape the booking flow itself:

- `hold_duration` (`hold_duration_seconds` in the API): the lease a hold gets by default,
  capped at 30 minutes.
- `require_customer_confirmation` and `require_provider_confirmation`: a booking that needs one
  is created `pending` instead of `confirmed`.
- `auto_start` and `auto_complete`: the automatic transitions, applied by a job at the instant
  they fall due.
- `max_active_bookings_per_customer`: decided under an advisory lock on the customer, so two
  simultaneous bookings cannot both slip past it. Availability reports it as
  `reason: customer_limit_reached` with a `200` and no slots, rather than as an error.

## What is real and what is an expectation

This is the honest table. Left column: written and enforced today. Right column: computed,
stored, and waiting for payments to exist.

| Enforced now | Computed as an expectation |
| --- | --- |
| Which tier applies, to the millisecond | `refund_amount_expected` |
| `max_reschedules`, as a `422` | `reschedule_fee_expected` |
| `grace_minutes`, as a `422` | `no_show_charge_expected` |
| `hold_duration`, capped at 30 min | `deposit`, `payment_timing` |
| `require_*_confirmation`, as a `pending` status | Any price difference on a reschedule |
| `pricing_rules`, evaluated per slot and frozen | |
| `max_active_bookings_per_customer` | |
| `auto_start`, `auto_complete`, `no_show.auto_mark` | |

`amount_paid`, `amount_due` and `amount_refunded` exist on the booking and stay at whatever you
put there. Nothing in Bookrail moves them.

Also not implemented, and named here so nobody plans around them: `refund_fee_fixed` (an
administrative retention), entitlements as a payment mode, and tax.
</content>
