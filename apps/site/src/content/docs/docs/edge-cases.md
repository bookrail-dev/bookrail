---
title: 'The edge cases of booking'
description: 'Twenty-two things that go wrong in booking systems, what Bookrail does about each one, and the test in the repository that proves it.'
sidebar:
  order: 15
---

Booking looks like inserting a row. It is not. It is a distributed allocation problem with a
calendar, a clock that changes twice a year, and a contract attached to every row, and almost
all of the work is in the cases nobody demoed.

This page is the honest list. For each case: what goes wrong, what this system does, and the
**test in the repository that proves it**. The test names are real; they are what you would run.
The repository is public, so every path below is a link to the file it names, and
[Open source](/docs/open-source/) says what is open and what is not.

Use the list as a checklist against whatever you are building, ours or your own. A passing
demo illustrates a case; it does not establish correctness under load.

## Capacity

### Two customers, one slot

**What goes wrong.** Two requests arrive in the same millisecond for a resource of capacity 1.
The classic implementation reads availability, sees a free slot, and writes: both reads
succeed, both writes succeed, and the club has two people on one court.

**What Bookrail does.** The check is a database constraint, not a read followed by a write. A
capacity 1 resource carries a Postgres exclusion constraint over the period of every active
occupancy, so the second write fails at the constraint whatever the application believed. One
request gets the booking, the other gets `409 slot_unavailable` naming the requirement that
could not be served.

**Proved by.**
[`packages/engine/test/concurrency.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/concurrency.test.ts),
scenario `capacity` at capacity 1: three separate processes with their own connections fire
simultaneous requests at one slot and exactly one wins.
[`packages/engine/test/booking.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/booking.test.ts)
goes under the engine and writes raw SQL as the application role: `refuses two overlapping
occupancies on a capacity 1 resource, application role included` and `refuses the double booking
even when the application check is bypassed`.
[`packages/db/test/occupancies.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/db/test/occupancies.test.ts)
asserts the constraint on its own, with no engine in the way: `rejects two overlapping occupancies
on a capacity-1 resource`.

### Capacity N, and the unit past the last one

**What goes wrong.** A class of 15 is not a court. Exclusion constraints do not express "at
most 15 overlapping", so most systems fall back to `SELECT count(*)` and a hope.

**What Bookrail does.** A trigger measures the peak of `capacity_used` over the footprint of
the new occupancy and refuses the unit that would pass the resource capacity. The measurement
is one SQL function, used by the trigger and by the engine, and a property test checks it
against the TypeScript version.

**Proved by.**
[`packages/db/test/occupancies.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/db/test/occupancies.test.ts),
`the capacity guard for capacity N`: `accepts occupancies up to the capacity`, `refuses the unit
past the capacity with a check violation, written in raw SQL`, and `refuses it on the admin
connection too`.
[`packages/engine/test/concurrency.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/concurrency.test.ts)
runs the same scenario at capacity 3 and 15.

### Composite resources: two requirements, one candidate

**What goes wrong.** A service needs a dentist and a room. Three dentists and two rooms are
free, but the only dentist who can do this treatment is the one who owns the only free room.
Naive systems offer the slot and then fail at booking time, or double allocate the same
resource to both requirements.

**What Bookrail does.** Requirements are intersected and the assignment is solved with
backtracking before anything is written. If the only solution needs one resource in two roles,
the instant is not offered.

**Proved by.**
[`packages/engine/test/booking.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/booking.test.ts):
`finds the assignment two requirements sharing a resource make necessary` and `refuses when two
requirements can only be served by the same single resource`.
[`packages/engine/test/availability.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/availability.test.ts):
`offers nothing when two requirements fight over the same resource`. Under load,
[`packages/engine/test/concurrency.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/concurrency.test.ts)
scenario `composite`.

### Capacity lowered under bookings that already exist

**What goes wrong.** Someone edits a resource from capacity 4 to capacity 1 while four bookings
overlap on it. The tempting behaviour is to accept the edit and let the overbooking exist, or
to delete bookings to make the numbers fit.

**What Bookrail does.** Neither. The exclusion constraint is re-evaluated for the occupancies
that already exist, so the edit is refused when it would create an overlap that the new
capacity forbids; and where the edit is accepted, existing bookings are never deleted. Where a
change does leave a future booking inconsistent, the system emits `booking.orphaned` and leaves
the booking exactly as it was.

**Proved by.**
[`packages/db/test/occupancies.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/db/test/occupancies.test.ts):
`re-flags existing occupancies when the capacity of a resource changes`, `closes the hole opened by
lowering the capacity under a saturating occupancy`, `refuses to lower the capacity to 1 while two
occupancies already overlap`.
[`packages/engine/test/orphaned.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/orphaned.test.ts):
`reports a capacity lowered under what is already booked`.

### A configuration change orphans a booking

**What goes wrong.** The club shortens its opening hours, or deactivates a court, and there are
already bookings in the part that just disappeared. Systems either delete them, or pretend
nothing happened and discover it on the day.

**What Bookrail does.** The booking is **not touched**, and a `booking.orphaned` event is
emitted in the same transaction as the configuration change, with a reason:
`outside_schedule`, `capacity_exceeded` or `resource_unavailable`. Deciding what to do with a
sold booking is a business decision and belongs to you; the system's job is to tell you the
moment it happens rather than to silently destroy a commitment. A nightly job repeats the scan
past the interactive horizon of 90 days.

**Proved by.**
[`packages/engine/test/orphaned.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/orphaned.test.ts):
`reports a booking left outside the opening hours, and does not touch it`, `reports a closed-day
exception`, `reports a resource that was deactivated or soft deleted`, `writes one event per booking
even when several of its resources are affected`. Also
[`packages/api/test/orphaned.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/orphaned.test.ts)
and
[`packages/api/test/reconcile.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/reconcile.test.ts)
for the nightly pass.

## Time

### The clocks change: 23 hour and 25 hour days

**What goes wrong.** Schedules are stored as UTC offsets, or as local strings converted once.
On the last Sunday of March the 02:30 slot does not exist; on the last Sunday of October it
exists twice. Systems built on offsets produce ghost slots, duplicate slots, or a whole day of
bookings an hour out.

**What Bookrail does.** Rules live on a local clock and are materialised into UTC one local day
at a time from the IANA database. A day with a transition has 23 or 25 hours, and a
`09:00` to `19:00` rule still lasts ten real hours on both. A `01:00` to `04:00` rule lasts two
real hours in spring and four in autumn, because the change falls inside it. A non-existent
local time is pushed forward by the length of the jump; a repeated one takes its first
occurrence. Durations are absolute minutes: a 60 minute booking at 01:30 lasts 60 real minutes.

**Proved by.**
[`packages/engine/test/dst.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/dst.test.ts),
over six zones with the transition dates read from the tzdata on the machine rather than typed:
`makes the local day` 23 hours long on one transition and 25 on the other (the title is built from
the measured offset change, so the number in it is computed and not typed), `keeps a 09:00-19:00
schedule at ten real hours`, `turns a 01:00-04:00 rule into three hours minus the offset change it
contains`, `moves a band that falls entirely inside the gap forward, keeping its length`, `resolves
a repeated wall-clock time to its first occurrence`, `keeps eroded start instants 60 real minutes
apart across the change`. [Time zones](/docs/guides/time-zones/) is the guide.

### A band that crosses midnight

**What goes wrong.** A bar open 22:00 to 02:00, closed on Wednesday. Does Tuesday night stop at
midnight? Most calendars are built on days, so the tail of Tuesday belongs to Wednesday and
disappears with it.

**What Bookrail does.** A closure without hours suppresses the bands the rules of that day
would have produced, night tail included, and does **not** touch the tail of a band that
started the day before. Tuesday night still serves until 02:00. A closure with hours is
subtracted, and it applies even on a suppressed day, because a closure can cross midnight onto
a day that does open.

**Proved by.**
[`packages/engine/test/availability.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/availability.test.ts):
`materializes a band that crosses midnight`.
[`packages/engine/test/dst.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/dst.test.ts):
`carries a 22:00-02:00 band across midnight into the transition day`.
[`packages/engine/test/booking.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/booking.test.ts):
`reports every local day a booking crosses, midnight included`, which is what keeps the cache
invalidation correct on both sides of the boundary.

### The customer is in another time zone

**What goes wrong.** The buyer's zone is used for the calculation, so the same court appears
open at different hours to different people, and the local date in the confirmation email is
wrong for one of them.

**What Bookrail does.** Availability is computed on the **offer**: the resource, its location
and its schedule. The `timezone` in the request is presentation only, and moves the local
column of the answer without moving the grid by one minute. Instants go in with an explicit
offset and come out in UTC. A bare date is a `400`, with the reason spelled out, because
midnight is not the same moment everywhere.

**Proved by.**
[`packages/engine/test/availability.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/availability.test.ts):
`computes on the resource, never on the customer time zone`, plus `aligns the grid to the local hour
in Asia/Kolkata (+05:30)` and `in Asia/Kathmandu (+05:45)` for the offsets that are not whole hours.

### Buffers meet another booking

**What goes wrong.** Two services on one chair, one needing 10 minutes of cleanup and the other
15 of setup. Systems that apply the asking service's buffers to somebody else's booking compute
a distance that is not the real one, and either sell an impossible slot or hide a legal one.

**What Bookrail does.** An existing occupancy carries **its own** buffers, stored on the row,
and the new booking carries its own. With `buffer_sharing: false` the two footprints stay
disjoint. With `buffer_sharing: true` the buffers may overlap each other but never the body of
the other booking, and the minimum distance drops accordingly. A block carries no buffer: it is
subtracted as it is.

**Proved by.**
[`packages/engine/test/booking.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/booking.test.ts),
four tests to the minute: `without buffer_sharing the two buffers add up: 11:49 is refused`,
`without buffer_sharing 11:50 is exactly far enough`, `with buffer_sharing the buffers overlap:
11:29 is still refused`, `with buffer_sharing 11:30 is enough, thirty minutes earlier than without`.

### A price that depends on the hour the clocks change

**What goes wrong.** A night rate on `[02:00, 03:00)` and a clock change underneath it. In
spring that hour does not exist; in autumn it happens twice. A system that computes the local
hour from a stored offset either prices an hour nobody can book or prices only one of the two
that exist, and the difference lands on a customer's card.

**What Bookrail does.** A rule is read on the local wall clock of the **offer**, on the start of
the slot, through the IANA database. Going from an instant to a wall time is total, so there is
nothing to disambiguate and nothing to guess: on the spring forward night no instant reads
02:30, so the rule fires for none of them, and on the fall back night two instants do, so it
fires for both. The weekday is the local one too, so a slot at 00:30 on a Saturday in Rome is
priced as Saturday even though UTC is still on the Friday.

**Proved by.**
[`packages/engine/test/pricing.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/pricing.test.ts),
with the transition dates read from the tzdata rather than typed: `cannot fire on the hour that does
not exist in %s`, `fires twice on the hour that happens twice in %s`, `reads days on the local day
of %s, even when UTC is still on the day before`, and `prices the day before a clock change as the
day it is locally`.

### A price band that crosses midnight, and two rules that both match

**What goes wrong.** A night rate written `22:00` to `02:00`. Read as a plain interval it is
empty and never fires. And once several rules exist, a system that applies all of them turns a
weekend rate plus an evening supplement into a number nobody quoted.

**What Bookrail does.** A band is half open and wraps: `[22:00, 24:00)` united with
`[00:00, 02:00)`, so 22:00 and 00:30 are both in it and 02:00 is not. The rules are evaluated
in order and the **first match wins**, with no chaining: a Saturday evening under a weekend rule
followed by an evening rule costs the weekend price, and the evening rule never runs. The slot
says which rule priced it, `price_rule: { index, label }`, so the number can always be traced
back. `price_add` never takes a price below zero, and a multiplier is rounded to the minor unit.

**One thing to know before you write one.** Every condition is read on the **start** of the
slot, `days` included, so a wrapping band combined with a single weekday covers half the night
it looks like it covers: `{"days": ["fri"], "time_from": "22:00", "time_to": "02:00"}` prices
Friday 22:30 and not Saturday 00:30. Write a night rate **without `days`**, or with both days
it touches (`["fri", "sat"]`), accepting that the second one also covers that day's evening.

**Proved by.**
[`packages/engine/test/pricing.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/pricing.test.ts):
`prices a band that crosses midnight on both sides of it`, `reads the time band as half open, [from,
to)`, `reads days on the day the slot starts, so a band that wraps needs both days`, `lets the first
matching rule win, with no chaining`, `never lets price_add take the price below zero`, `rounds a
multiplier to the minor unit, the two worked examples of the specification`, and the property tests
`is deterministic: the same input gives the same answer`, `never produces a negative amount, and
never leaves the integers` and `always reports the first rule that matches, never a later one`.

### The price changes between the quote and the invoice

**What goes wrong.** Availability quotes 40.00, the customer books, and somebody edits the
price list that afternoon. A system that recomputes on read now shows a different number on the
booking, and the refund, the reschedule fee and the no-show charge all follow it.

**What Bookrail does.** The booking **freezes** the price and the rule that produced it, in the
same transaction that takes the capacity, exactly as it freezes the policy. Changing the rules
afterwards changes nothing about it, and neither does a reschedule: the new booking is priced
for the slot it moved to, and the old one keeps what it froze. A hold is a quote, not a sale, so
the price is computed again at the conversion: the creation of a hold quotes an amount, the hold
itself stores none, and reading a hold back answers `price: null` rather than a number that could
differ between two reads. The no-show charge is a percentage of the frozen price, surcharge
included.

**Proved by.**
[`packages/engine/test/lifecycle.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/lifecycle.test.ts):
`freezes the price a pricing rule produced, and charges the no-show on it`, `does not move a frozen
price when the rules change afterwards`, `prices a hold at conversion, not at the hold`, `prices the
new booking of a reschedule for the slot it moved to`.
[`packages/api/test/bookings.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/bookings.test.ts)
runs the same chain over HTTP: `freezes the price a pricing rule produced, and names the rule on the
booking`.
[`packages/engine/test/availability.cache.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/availability.cache.test.ts)
covers the other half, that a cache cannot hide a rule change: `reflects a change to pricing_rules
in the next answer, with the cache still warm`.

## The life of a booking

### A hold expires halfway through the conversion

**What goes wrong.** The customer picks a slot, a hold is taken, the form takes four minutes,
the hold had a two minute lease. Systems that sweep expired holds on a timer leave a window
where an expired hold still blocks the slot, or where a dead hold still converts into a
booking.

**What Bookrail does.** Expiry is a property of the row and not of the sweep. The engine
ignores a hold from the instant it expires, so an expired hold never blocks anybody, and
`GET /v1/holds/{id}` answers `expired` before any job has run. Converting an expired hold is a
clean refusal, not a booking. The right client behaviour is to ask for availability again, not
to assume the place is still free.

**Proved by.**
[`packages/engine/test/booking.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/booking.test.ts):
`refuses to convert a hold that has expired` and `ignores an expired hold, sweeps it, and books the
slot it was holding`.
[`packages/api/test/holds.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/holds.test.ts),
whose title for it reads "says `expired`" followed by `as soon as the deadline has passed, before
any sweep has run`, and `409s on a hold that has already become a booking`.
[`packages/engine/test/concurrency.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/concurrency.test.ts)
scenario `hold_race` runs holds against direct bookings on the same slot.

### The policy changed after the sale

**What goes wrong.** A booking is made under "free cancellation up to 24 hours". Two weeks
later the club moves to 48 hours. The customer cancels 30 hours out and the system applies
today's rule to yesterday's contract, refunding the wrong amount in the wrong direction.

**What Bookrail does.** The policy is copied into the booking as `policy_snapshot` at creation.
Every later calculation, refund, reschedule fee, no show charge, reads the snapshot. The
current policy is irrelevant to a booking that already exists.

**Proved by.**
[`packages/engine/test/booking.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/booking.test.ts):
`freezes the policy snapshot at creation time`.
[`packages/engine/test/lifecycle.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/lifecycle.test.ts):
`picks the tier at the exact boundary, not a millisecond either side`, `computes the refund on
amount_paid, not on the price`, `cancels a booking whose policy carries an impossible percentage`
for a snapshot that was already malformed when it was frozen.

### Rescheduling, and the limit on it

**What goes wrong.** Reschedule is implemented as an `UPDATE` of the start. Two clients
reschedule at once and both succeed, leaving two occupancies or none; or the reschedule
succeeds and the old slot is never released; or a customer moves the same booking forty times.

**What Bookrail does.** A reschedule creates a second booking, links the two in both
directions, and leaves exactly one live occupancy. `max_reschedules` comes from the frozen
snapshot. A new start that is not on the service grid is refused rather than rounded.

**Proved by.**
[`packages/engine/test/lifecycle.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/lifecycle.test.ts):
`moves the booking, links the two, and leaves exactly one occupancy`, `leaves the old booking
untouched when the new slot is gone`, `respects max_reschedules`, `refuses a new start that is not
on the service grid`, `never lets a concurrent reader see the slot free while the reschedule runs`.
Under load,
[`packages/engine/test/concurrency.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/concurrency.test.ts)
scenario `reschedule_race`: 200 simultaneous reschedules of one booking onto one capacity 1 slot,
one winner, 199 `invalid_transition`, and a dedicated check that the chain is still coherent
afterwards.

### A no show marked too early

**What goes wrong.** The customer is nine minutes late, somebody hits "no show", and the
penalty is charged against a policy that promised a fifteen minute grace.

**What Bookrail does.** The grace period comes from the frozen snapshot and the transition is
refused before it, to the minute. When the policy says nothing about a no show charge, nothing
is charged. The automatic version, `no_show.auto_mark`, is applied by a job at the same
instant the manual one would become legal.

**Proved by.**
[`packages/engine/test/lifecycle.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/lifecycle.test.ts):
`refuses a no-show before the grace period and accepts it at the exact minute`, `charges nothing for
a no-show when the policy says nothing`, `keeps the occupancy of a completed booking, and releases
that of a no-show`.

### Every other illegal transition

**What goes wrong.** Confirm a cancelled booking. Complete one that has not started. Cancel one
twice. Each of these is a state machine question, and a system that answers them with scattered
`if` statements answers some of them wrongly.

**What Bookrail does.** The matrix is data, the row is locked `FOR UPDATE` for the transition,
and everything the matrix does not allow is `409 invalid_transition` naming the current status
and the actions that are legal from it.

**Proved by.**
[`packages/engine/test/lifecycle.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/engine/test/lifecycle.test.ts):
`exposes the documented transition matrix, and nothing more`, `refuses every action the matrix does
not allow, from every status`, `names the current status and the allowed actions in the 409`,
`refuses to complete a booking that has not started`, `applies an automatic transition once,
whatever the number of workers`.

## Talking to the API

### A response gets lost, and the client retries

**What goes wrong.** The booking succeeded, the connection dropped before the response arrived,
the client retries. Systems that implement idempotency as "look up the key, then write if
absent" have a race exactly the width of that lookup, and two concurrent retries produce two
bookings.

**What Bookrail does.** The key is **taken**, with an `INSERT` under a unique constraint, before
the work runs. Twenty simultaneous requests with one key leave one booking. The stored answer
is replayed with `Idempotent-Replayed: true`, including a 4xx. The key is released only when
nothing was committed: a `5xx` raised after the commit is stored and replayed, because
releasing it there would let the retry book a second time. The same key with a different body
is `400 idempotency_key_reused`; a request still in flight is
`409 idempotency_key_in_progress`.

**Proved by.**
[`packages/api/test/idempotency.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/idempotency.test.ts):
`lets exactly one of twenty concurrent requests with one key create a booking`, `replays the same
response and creates one booking only`, `replays a 4xx answer verbatim instead of retrying it`,
`keeps the key, so the retry gets the same 500 and never a second booking`, `still releases the key
when nothing was committed`, `refuses the same key with a different body`, `refuses the same key on
a different endpoint`, `does not burn the key on a POST to a path that does not exist`.
[Idempotency](/docs/guides/idempotency/) is the guide.

### A webhook endpoint that is disabled, or slow, or gone

**What goes wrong.** A receiver goes down. A queue keeps firing at it forever, or gives up
silently, or, worse, keeps delivering to an endpoint the customer explicitly disabled.

**What Bookrail does.** Deliveries are taken with `FOR UPDATE SKIP LOCKED` and the query
excludes disabled endpoints, so work already queued for a disabled endpoint stops leaving.
Failures retry on a fixed ladder, 3s, 30s, 5m, 30m, 2h, 12h and 24h, eight attempts, and then
the delivery is `failed`, the endpoint is `failing`, and a `webhook.failing` event is written
(and never itself delivered to anybody). A delivery that succeeds brings the endpoint back to
`active`. Any delivery can be sent again by hand.

**Proved by.**
[`packages/api/test/webhook-delivery.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/webhook-delivery.test.ts):
`stops delivering what is already queued when the endpoint is disabled`, `retries on exactly 3s,
30s, 5m, 30m, 2h, 12h, 24h and then gives up`, `replays a dead delivery and brings the endpoint back
to active`, `never delivers webhook.failing to anybody`, `records a timeout as a failure, with no
status and a reason`, `sends the deliveries of a tick in parallel, so one slow receiver holds
nobody`.

### A webhook arrives twice, or out of order

**What goes wrong.** At least once delivery is the only kind that exists, so a consumer that
assumes exactly once double books, double emails, or double refunds. And an older event
arriving after a newer one can undo a state transition that already happened.

**What Bookrail does.** A unique constraint on `(webhook_id, event_id)` makes a second delivery
of one event to one endpoint impossible whatever the outbox does, and every delivery carries
`Bookrail-Event-Id` to deduplicate on. The outbox reads the log on a `(txid, seq)` cursor and
only past the oldest running transaction, so an event committed by a slow writer cannot be
skipped by a fast one. Ordering across endpoints is not promised: the event object carries the
state, and a consumer should treat a delivery as "read the current object", not as "apply this
delta".

**Proved by.**
[`packages/api/test/webhook-delivery.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/webhook-delivery.test.ts):
`does not deliver the same event to one endpoint twice, whatever the outbox does`, `takes each
delivery once when two workers sweep together`, `append only: no row is ever updated by the delivery
path`.
[`packages/api/test/webhook-outbox.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/webhook-outbox.test.ts)
covers the cursor and the visibility horizon.

### A client that calls faster than it is allowed to

**What goes wrong.** A script in a loop, a retry storm, or a test suite left running overnight.
Without a ceiling, one key is enough to make the process slow for every other key it shares, and
with a naive ceiling (a counter per clock second) a caller gets twice its quota across the boundary
between two seconds and then nothing at all for the rest of the second.

**What Bookrail does.** A GCRA leaky bucket per API key, held in Redis as a single timestamp and
evaluated by one Lua script, so two requests that arrive together cannot both be allowed. A
`sk_test_` key may make 20 requests a second with bursts of 40; a `sk_live_` key 100 a second with
bursts of 500. The bucket is the **key**, not the project and not the address, so two keys of one
project cannot starve each other. Every response carries `RateLimit-Limit`, `RateLimit-Remaining`
and `RateLimit-Reset` (whole seconds), including the ones that were served, so a client can pace
itself before it runs out; a refusal is `429 rate_limited` with `Retry-After` and a `fix`. The limit
sits in front of the `Idempotency-Key` middleware, so a refusal neither consumes a key nor becomes
the stored answer a retry would be given for twenty-four hours. And if Redis stops answering the
request is **served**, with `RateLimit-Policy: unavailable` instead of the counters: a rate limiter
that turns into an outage is worse than no rate limiter.

**Proved by.**
[`packages/api/test/rate-limit.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/rate-limit.test.ts):
`lets exactly the burst through at one instant, and refuses the next`, `admits at most the burst
plus one per interval over any window`, `never refuses a caller whose last accepted request is older
than the drain time`, `admits exactly the burst of twenty simultaneous requests`, `computes what the
arithmetic in memory computes, from the same stored value`.
[`packages/api/test/rate-limit-api.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/rate-limit-api.test.ts):
`answers the next one with 429 rate_limited, Retry-After and the three counters`, `does not consume
the key, so the retry runs for real`, `gives two keys of one project two buckets`, `reads the policy
of the environment the key belongs to`, `leaves the routes that have no key alone`, `serves the
request, says so, and complains once a minute`.
[`packages/sdk-node/test/rate-limit.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/sdk-node/test/rate-limit.test.ts):
`waits out the refusal and gets the answer`.

### A webhook URL that points inside your network

**What goes wrong.** A customer registers an endpoint on the cloud metadata address,
`169.254.169.254`, and the delivery worker fetches credentials on their behalf. Or registers a
public hostname that resolves to a private address only at delivery time, which validation at
registration cannot catch.

**What Bookrail does.** The full table of non public ranges is refused, IPv4 and IPv6 including
`::ffff:127.0.0.1`, and the DNS is resolved **at delivery** with the connection pinned to the
addresses that were verified, which is what closes the rebinding window that a plain `fetch`
leaves open. No environment variable turns this off.

**Proved by.**
[`packages/api/test/webhook-ssrf.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/webhook-ssrf.test.ts),
and
[`packages/api/test/webhook-secrets.test.ts`](https://github.com/bookrail-dev/bookrail/blob/main/packages/api/test/webhook-secrets.test.ts)
for the neighbouring promise that the signing secret is shown once and never returned by any
serializer.

## What is not on this list

Cases the model describes and the system does not implement yet, so there is nothing to prove:

- **Recurring series with conflicting occurrences.** `recurrence` is a `400 not_yet_supported`.
- **Multi day bookings across a closure.** The `allow_closed_gaps` case is designed, not built.
- **Anything to do with money.** `payment.mode` other than `none` is a `400`. Refunds are
  computed as expectations and no amount ever moves.
- **Quotas per project.** How many resources, bookings or webhook endpoints one test account may
  create is unbounded. The rate limit above bounds how *fast*, not how many.

They will get an entry here when they get a test.

## Using this list

Every heading above is a case worth running against whatever you use, including your own code.
For each one, record the expected result before the test, then check the stored state as well
as the API response: an API that answers correctly and stores two allocations has still lost.
Use synthetic data and independent clients, and remove credentials before sharing anything.

A coding agent can pull the same material with the MCP tool `bookrail_edge_cases`, which
returns the topics as markdown from the packaged documentation, and
[For AI agents](/docs/for-ai-agents/) explains the rest of that surface.
</content>
