---
title: 'Concepts'
description: 'The Bookrail data model for the person building on it: location, resource, schedule, service, policy, customer, hold, booking, event and webhook, with figures.'
sidebar:
  order: 12
---

Ten objects. Everything a booking system does is made of them, and nothing in the model is
special cased for a vertical: a padel court, a dentist and a boat rental are the same shape
with different numbers.

One page on purpose. A schedule means nothing without the resource it belongs to, and ten tabs
would be a filing system rather than an explanation. The field by field list is separate:
[Entity reference](/docs/entities/).

## The shape of it

```
Account                      your organisation
└── Project                  one application, in one environment: test or live
    ├── Location             a place, and the time zone that place lives on
    ├── Resource             the thing that gets occupied, with a capacity
    ├── ResourceGroup        interchangeable resources, and how to pick one
    ├── Schedule             when a resource is open, on a local clock
    ├── Service              what you sell, and what it needs to happen
    ├── Policy               the rules of cancelling, moving and not turning up
    ├── Customer             who booked
    ├── Hold                 a short lease on capacity while somebody decides
    ├── Booking              capacity taken, rules frozen
    ├── Event                the append only log of everything above
    └── Webhook              where events go
```

A **project** is the boundary of everything else. Test and live are two projects in every way
that matters: separate keys, separate rows, and a row of one is invisible to a key of the
other. Row level security in Postgres is what enforces that, not a `WHERE` clause somebody
might forget.

## Location: where the clock lives

A location is a place with an IANA time zone. That is its real job. The time zone belongs to
the thing being booked, not to the person booking it: a court in Rome is bookable at 18:00 Rome
time whoever asks, and from Tokyo that is 01:00 the next day. Put the zone on the buyer and
every schedule in the system becomes wrong twice a year.

A virtual resource still has a location, with an explicit zone, because a video consultation
still has an hour on somebody's clock.

## Resource: the thing that gets occupied

A resource is what a booking consumes: a person, a room, a court, a vehicle, a seat, or a slot
in a class. It has a `capacity`, an integer, and that number is the whole difference between
"a court" and "a yoga class".

- `capacity: 1` is a court, a chair, a car. The database refuses a second overlapping
  occupancy with an exclusion constraint, so a double booking is impossible even if the
  application asks for one.
- `capacity: 15` is a class or a table of 15 seats. A trigger refuses the unit past the
  capacity, in SQL, on the same connection the application uses.

Neither guarantee is application code, which is the point: a bug in the engine cannot produce
an overbooking, only an error.

## Schedule: opening hours as rules and exceptions

A schedule is a set of weekly rules written on a **local clock**, plus dated exceptions. Rules
say "Monday to Friday, 09:00 to 18:00". Exceptions say "closed on 25 December" or "open
10:00 to 14:00 on this Sunday only".

Rules are materialised into UTC one local day at a time, from the IANA database. That is why
the night a clock changes has 23 or 25 hours and a `09:00` to `19:00` rule still lasts ten real
hours on both, while a `01:00` to `04:00` rule lasts two hours in spring and four in autumn.
The full order of operations, and what happens to a band that crosses midnight, is in
[Time zones](/docs/guides/time-zones/).

Alongside the schedule there are **blocks**: a resource is closed from here to there, for
maintenance or holiday. A block is not a booking; it takes the whole capacity of the resource
for its period, and it cannot be placed over something already sold.

<figure class="bk-figure">
<div class="bk-scroll">
<svg viewBox="0 0 720 200" role="img" aria-labelledby="fig-timeline-title fig-timeline-desc" xmlns="http://www.w3.org/2000/svg">
<title id="fig-timeline-title">One resource, one morning, as segments of time</title>
<desc id="fig-timeline-desc">Three horizontal tracks over the hours 08:00 to 14:00. The first track, open, is a single band from 08:00 to 13:00. The second track, taken, holds a booking from 09:00 to 10:00, a hold from 11:00 to 11:30 and a block from 12:00 to 13:00. The third track, free, is what is left: 08:00 to 09:00, 10:00 to 11:00 and 11:30 to 12:00.</desc>
<defs>
<pattern id="bk-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
<line class="bk-hatch-line" x1="0" y1="0" x2="0" y2="6" />
</pattern>
</defs>
<text class="bk-label" x="110" y="20">08:00</text>
<text class="bk-label" x="206" y="20">09:00</text>
<text class="bk-label" x="302" y="20">10:00</text>
<text class="bk-label" x="398" y="20">11:00</text>
<text class="bk-label" x="494" y="20">12:00</text>
<text class="bk-label" x="590" y="20">13:00</text>
<text class="bk-label" x="686" y="20">14:00</text>
<path class="bk-line" d="M110 28 V180 M206 28 V180 M302 28 V180 M398 28 V180 M494 28 V180 M590 28 V180 M686 28 V180" />
<text class="bk-label-strong" x="0" y="63">open</text>
<rect class="bk-fill-card" x="110" y="44" width="480" height="26" />
<rect class="bk-fill-none bk-line-2" x="110" y="44" width="480" height="26" />
<text class="bk-label" x="120" y="61">schedule: every day 08:00 to 23:00, local</text>
<text class="bk-label-strong" x="0" y="107">taken</text>
<rect class="bk-fill-ink" x="206" y="88" width="96" height="26" />
<text class="bk-label-on-ink" x="214" y="105">bk_ 60 min</text>
<rect class="bk-fill-soft" x="398" y="88" width="48" height="26" />
<rect class="bk-fill-none bk-stroke-accent bk-dashed" x="398.75" y="88.75" width="46.5" height="24.5" />
<text class="bk-label-accent" x="398" y="130">hold</text>
<rect x="494" y="88" width="96" height="26" fill="url(#bk-hatch)" />
<rect class="bk-fill-none bk-line-2" x="494" y="88" width="96" height="26" />
<text class="bk-label" x="494" y="130">block</text>
<text class="bk-label-strong" x="0" y="159">free</text>
<rect class="bk-fill-card" x="110" y="140" width="96" height="26" />
<rect class="bk-fill-none bk-line-2" x="110" y="140" width="96" height="26" />
<rect class="bk-fill-card" x="302" y="140" width="96" height="26" />
<rect class="bk-fill-none bk-line-2" x="302" y="140" width="96" height="26" />
<rect class="bk-fill-card" x="446" y="140" width="48" height="26" />
<rect class="bk-fill-none bk-line-2" x="446" y="140" width="48" height="26" />
<text class="bk-label" x="110" y="182">3 segments, before the service asks for a duration</text>
</svg>
</div>
<figcaption>
Availability is subtraction, not search. The engine takes the open bands of a resource for one
local day, removes every active occupancy and every block, and is left with a set of segments
in a normal form. Only then does a service impose its duration, its grid and its buffers on
them. The synthetic day above is a padel court on the template of the
<a href="/docs/quickstart/">quickstart</a>: a one hour booking in ink, a ten minute hold in the
accent tint, and a maintenance block hatched.
</figcaption>
</figure>

## Service: what you sell, and what it needs

A service is the thing a customer buys, and its most important field is not its price. It is
`requirements`: the list of what has to be free at the same instant for the service to happen.

A haircut needs one hairdresser. A dental appointment needs one dentist **and** one surgery
room. A padel match needs one court out of the group of courts. Each requirement names a
resource or a group, a quantity, and an optional role that ends up on the allocation.

The rest of the service is the shape of the offer: `duration` or `duration_options` or a
`duration_range`, a `slot_interval` and an `align_to` that make the grid, buffers before and
after, a booking window (`min_notice_minutes`, `max_advance_days`), and a price.

<figure class="bk-figure">
<div class="bk-scroll">
<svg viewBox="0 0 720 240" role="img" aria-labelledby="fig-service-title fig-service-desc" xmlns="http://www.w3.org/2000/svg">
<title id="fig-service-title">A service with two requirements, and the resources that can serve them</title>
<desc id="fig-service-desc">A service box on the left connects to two requirement boxes. The first requirement asks for one practitioner out of three, of which one is already taken. The second asks for one room out of two, of which one is already taken. The service is bookable only where a free practitioner and a free room exist at the same instant.</desc>
<rect class="bk-fill-card" x="1" y="70" width="180" height="92" />
<rect class="bk-fill-none bk-line-2" x="1" y="70" width="180" height="92" />
<text class="bk-title" x="14" y="94">Service</text>
<text class="bk-label" x="14" y="114">Dental check</text>
<text class="bk-label" x="14" y="130">45 min, grid 15 min</text>
<text class="bk-label" x="14" y="146">buffer_after 10 min</text>
<path class="bk-line-2" d="M181 100 H236" />
<path class="bk-line-2" d="M181 132 H236" />
<path class="bk-fill-ink" d="M236 96 l8 4 -8 4 z" />
<path class="bk-fill-ink" d="M236 128 l8 4 -8 4 z" />
<rect class="bk-fill-card" x="246" y="34" width="188" height="76" />
<rect class="bk-fill-none bk-line-2" x="246" y="34" width="188" height="76" />
<text class="bk-label-strong" x="258" y="56">requirement 1</text>
<text class="bk-label" x="258" y="74">1 of group Practitioners</text>
<text class="bk-label" x="258" y="90">role: dentist</text>
<rect class="bk-fill-card" x="246" y="126" width="188" height="76" />
<rect class="bk-fill-none bk-line-2" x="246" y="126" width="188" height="76" />
<text class="bk-label-strong" x="258" y="148">requirement 2</text>
<text class="bk-label" x="258" y="166">1 of group Rooms</text>
<text class="bk-label" x="258" y="182">role: room</text>
<rect class="bk-fill-card" x="486" y="26" width="140" height="24" />
<rect class="bk-fill-none bk-line-2" x="486" y="26" width="140" height="24" />
<text class="bk-label" x="496" y="42">dr_hall</text>
<rect class="bk-fill-ink" x="486" y="58" width="140" height="24" />
<text class="bk-label-on-ink" x="496" y="74">dr_ng, taken</text>
<rect class="bk-fill-card" x="486" y="90" width="140" height="24" />
<rect class="bk-fill-none bk-line-2" x="486" y="90" width="140" height="24" />
<text class="bk-label" x="496" y="106">dr_sato</text>
<rect class="bk-fill-ink" x="486" y="132" width="140" height="24" />
<text class="bk-label-on-ink" x="496" y="148">room_1, taken</text>
<rect class="bk-fill-card" x="486" y="164" width="140" height="24" />
<rect class="bk-fill-none bk-line-2" x="486" y="164" width="140" height="24" />
<text class="bk-label" x="496" y="180">room_2</text>
<path class="bk-line-2" d="M434 72 H480 M434 164 H480" />
<text class="bk-label-accent" x="1" y="222">Bookable where a free practitioner and a free room overlap: two combinations here, not five.</text>
</svg>
</div>
<figcaption>
Requirements are intersected, never added. The engine computes the free time of each
requirement, keeps the instants where all of them are satisfiable at once, and returns the
concrete combinations in <code>resource_options</code>. When two requirements can only be
served by the same single resource, the instant is not offered at all rather than offered and
then refused.
</figcaption>
</figure>

## Policy: the rules, frozen at the moment of sale

A policy holds the rules that apply after the booking exists: refund tiers by distance from the
start, a reschedule fee and a limit on how many times, a no show charge and its grace period, a
hold duration, whether a booking needs confirming, and how many active bookings one customer
may hold.

The important part is not the fields. It is that the policy is **copied into the booking** as
`policy_snapshot` when the booking is made. Change the policy tomorrow and yesterday's booking
still cancels under yesterday's terms, because the terms are in the row, not behind a foreign
key. This is a contract question before it is a technical one, and it is the single most
common way a homemade booking system quietly refunds the wrong amount.

Deposits and payment timing are described in the policy and honoured as numbers. **No money
moves**: there is no payment provider yet, so a refund is an expectation the API computes
(`refund_percent`, `refund_amount_expected`) and `amount_refunded` never changes on its own.
[Policies](/docs/guides/policies/) is the whole of it.

## Customer: who booked

A customer is a person in your system, not in ours. `external_id` is your identifier, and the
API upserts on it; an inline `customer` object on a hold or a booking creates or finds one by
email, so a first booking does not need two calls. A customer carries the limits a policy
applies to them, such as `max_active_bookings_per_customer`, which is decided under an advisory
lock so two simultaneous bookings cannot both slip past it.

## Hold: a short lease on capacity

A hold takes the capacity out of availability without creating a booking, for a `ttl` bounded
by the policy and capped at 30 minutes. It exists for the gap between "the customer chose a
slot" and "the customer finished the form".

A hold either becomes a booking, is released, or expires. An expired hold is ignored by the
engine from the instant it expires, before any sweep touches the row, so an expired hold never
blocks anybody even for a second. Converting an expired hold is a clean `409 hold_expired`, and
the honest answer to it is to ask for availability again rather than to assume the slot is
still there.

## Booking: capacity taken

A booking is the fact. It carries the instants in UTC, the local time zone it was sold in, the
duration in minutes, the quantity, the price, the frozen policy, and the allocations: which
resource gave which units.

Its status moves through a matrix that is data in the engine, not scattered `if` statements.

<figure class="bk-figure">
<div class="bk-scroll">
<svg viewBox="0 0 720 216" role="img" aria-labelledby="fig-matrix-title fig-matrix-desc" xmlns="http://www.w3.org/2000/svg">
<title id="fig-matrix-title">The booking transition matrix</title>
<desc id="fig-matrix-desc">A table of three rows and six columns. From pending, the allowed actions are confirm, cancel and reschedule. From confirmed, they are cancel, reschedule, check in, complete and no show. From in progress, they are cancel, complete and no show. Every other combination is refused with 409 invalid transition.</desc>
<text class="bk-label" x="140" y="24">confirm</text>
<text class="bk-label" x="238" y="24">cancel</text>
<text class="bk-label" x="330" y="24">reschedule</text>
<text class="bk-label" x="436" y="24">check_in</text>
<text class="bk-label" x="532" y="24">complete</text>
<text class="bk-label" x="632" y="24">no_show</text>
<path class="bk-line" d="M0 34 H720" />
<text class="bk-label-strong" x="0" y="58">pending</text>
<rect class="bk-fill-ink" x="140" y="44" width="72" height="20" />
<rect class="bk-fill-ink" x="238" y="44" width="72" height="20" />
<rect class="bk-fill-ink" x="330" y="44" width="72" height="20" />
<path class="bk-line" d="M0 74 H720" />
<text class="bk-label-strong" x="0" y="98">confirmed</text>
<rect class="bk-fill-ink" x="238" y="84" width="72" height="20" />
<rect class="bk-fill-ink" x="330" y="84" width="72" height="20" />
<rect class="bk-fill-ink" x="436" y="84" width="72" height="20" />
<rect class="bk-fill-ink" x="532" y="84" width="72" height="20" />
<rect class="bk-fill-ink" x="632" y="84" width="72" height="20" />
<path class="bk-line" d="M0 114 H720" />
<text class="bk-label-strong" x="0" y="138">in_progress</text>
<rect class="bk-fill-ink" x="238" y="124" width="72" height="20" />
<rect class="bk-fill-ink" x="532" y="124" width="72" height="20" />
<rect class="bk-fill-ink" x="632" y="124" width="72" height="20" />
<path class="bk-line" d="M0 154 H720" />
<text class="bk-label" x="0" y="178">cancelled, completed, no_show and rescheduled are terminal.</text>
<text class="bk-label" x="0" y="196">Every empty cell is 409 invalid_transition, naming what is legal from here.</text>
</svg>
</div>
<figcaption>
The matrix as the engine holds it. <code>check_in</code> has an automatic twin,
<code>start</code>, applied by a job at the instant the policy says, and
<code>complete</code> and <code>no_show</code> have the same. A completed booking keeps its
occupancy, because the service happened and the period is in the past; a cancelled or no show
booking gives the capacity back.
</figcaption>
</figure>

Two consequences worth knowing before you build against it.

- **A reschedule is not an update.** It creates a second booking and links the two,
  `rescheduled_from_booking_id` and `rescheduled_to_booking_id`, and leaves exactly one
  occupancy standing. Two hundred simultaneous reschedules of the same booking produce one
  winner and 199 `invalid_transition`, which is a test, not a hope.
- **A configuration change never edits a booking.** Move the opening hours under a booking that
  is already sold and Bookrail emits `booking.orphaned` and leaves the row exactly as it was.
  Silently deleting money and commitments is not an option the system has.

## Event and webhook: how it leaves the system

Every change writes an event in the same transaction that made it. The log is append only, and
not by convention: the application role has no `UPDATE` and no `DELETE` on that table.

Events are read with a cursor on `(txid, seq)` rather than on a timestamp, which is what makes
the cursor hole free under concurrent writers. A webhook endpoint turns the same events into
signed deliveries.

<figure class="bk-figure">
<div class="bk-scroll">
<svg viewBox="0 0 720 210" role="img" aria-labelledby="fig-flow-title fig-flow-desc" xmlns="http://www.w3.org/2000/svg">
<title id="fig-flow-title">From a hold to a signed delivery</title>
<desc id="fig-flow-desc">A chain of five boxes: hold, booking, event, outbox and delivery. A hold either converts into a booking or expires and gives the capacity back. The booking and its event are written in one transaction. The outbox converts events into deliveries behind the visibility horizon, and the delivery is a signed POST retried on a fixed ladder.</desc>
<rect class="bk-fill-card" x="1" y="40" width="128" height="64" />
<rect class="bk-fill-none bk-stroke-accent bk-dashed" x="1" y="40" width="128" height="64" />
<text class="bk-label-strong" x="12" y="62">hold</text>
<text class="bk-label" x="12" y="80">capacity leased</text>
<text class="bk-label" x="12" y="96">ttl up to 30 min</text>
<path class="bk-line-2" d="M129 72 H166" />
<path class="bk-fill-ink" d="M166 68 l8 4 -8 4 z" />
<rect class="bk-fill-card" x="176" y="40" width="128" height="64" />
<rect class="bk-fill-none bk-line-2" x="176" y="40" width="128" height="64" />
<text class="bk-label-strong" x="187" y="62">booking</text>
<text class="bk-label" x="187" y="80">capacity taken</text>
<text class="bk-label" x="187" y="96">policy frozen</text>
<path class="bk-line-2" d="M304 72 H341" />
<path class="bk-fill-ink" d="M341 68 l8 4 -8 4 z" />
<rect class="bk-fill-card" x="351" y="40" width="128" height="64" />
<rect class="bk-fill-none bk-line-2" x="351" y="40" width="128" height="64" />
<text class="bk-label-strong" x="362" y="62">event</text>
<text class="bk-label" x="362" y="80">same transaction</text>
<text class="bk-label" x="362" y="96">cursor (txid, seq)</text>
<path class="bk-line-2" d="M479 72 H516" />
<path class="bk-fill-ink" d="M516 68 l8 4 -8 4 z" />
<rect class="bk-fill-card" x="526" y="40" width="128" height="64" />
<rect class="bk-fill-none bk-line-2" x="526" y="40" width="128" height="64" />
<text class="bk-label-strong" x="537" y="62">delivery</text>
<text class="bk-label" x="537" y="80">signed POST</text>
<text class="bk-label" x="537" y="96">8 attempts, 24 h</text>
<path class="bk-line-2 bk-dashed" d="M65 104 V142 H150" />
<text class="bk-label" x="158" y="146">expires: capacity back, no booking, and no event to deliver</text>
<path class="bk-line" d="M0 172 H720" />
<text class="bk-label" x="0" y="192">The outbox sits between event and delivery. It converts only events older than</text>
<text class="bk-label" x="0" y="206">the oldest running transaction, so no event is ever skipped.</text>
</svg>
</div>
<figcaption>
Delivery is at least once, so deduplicate on <code>Bookrail-Event-Id</code>. The signature is
<code>HMAC-SHA256</code> over <code>"&lt;timestamp&gt;.&lt;raw body&gt;"</code>, the secret is
shown once at creation and encrypted at rest, and an endpoint that resolves to a private
address is refused at delivery time, not only at registration.
<a href="/docs/guides/webhooks/">Webhooks</a> has the details.
</figcaption>
</figure>

## What the model deliberately does not have

- **No calendar object.** A calendar is a rendering of resources and schedules, and putting one
  in the model would force every vertical through somebody else's idea of a week.
- **No appointment type separate from service.** One object, with requirements, covers both.
- **No user object for end customers.** Authentication of your users is yours. A customer is a
  record, never an account with a password here.
- **No availability table.** Availability is computed, never stored, so it cannot go stale.
  What is stored is the occupancy, which is a fact.

Waitlists, entitlements and payments are in the plan and not in the API: there is no endpoint
behind them today, and this page will say so until there is.
</content>
