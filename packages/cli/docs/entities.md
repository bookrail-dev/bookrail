# Entities

The whole model, with no vertical-specific feature in it. If a business cannot be expressed
with these, the model changes; a module is never added.

## Location
Where things happen. Carries a `timezone`, which is the fallback wall clock for the resources
that belong to it.

## Resource
Anything that can be occupied: a person, a room, a court, a vehicle, a class, a table. Fields
that matter: `type` (free text: `staff`, `room`, `court`, `vehicle`, ...), `capacity` (how
many units it serves at once), `attributes` (free JSON, used by group selectors), `status`,
`schedule`, `location`.

A resource with `capacity: 1` cannot be double booked: an exclusion constraint in Postgres
covers every active occupancy on it, so the guarantee survives a bug in the application.

## ResourceGroup
A named set of resources plus an allocation strategy: `first_available`, `least_busy`,
`round_robin` or `priority` (the order the members are declared in). A service requires a
group when the customer does not care which member serves the booking.

## Schedule
Opening hours, as rules on a local clock plus exceptions.

- A rule has `days` (local days of the week), `from`, `to`, and an optional validity window.
- An `open` exception adds a band on one date; a `closed` exception with hours subtracts one.
- A `closed` exception **without** hours suppresses the whole local day, including the bands
  its rules would have produced. Closures win over openings.
- A band whose end is not strictly after its start crosses midnight.

## Service
What is sold. Exactly one duration form: `duration`, `durationOptions` or `durationRange`.
Plus the grid (`slotInterval`, `alignTo`), the buffers, the price and its `pricingRules`
(prices that depend on the day, the hour, the date, the resource or the duration: see
`bookrail docs config`), the booking window, the
policy, and the requirements.

### Requirements
A service needs one or more resources *at the same time*: a scan needs a sonographer, a room
and the machine. Each requirement names a resource or a group, a `quantity`, a `consumes`
(`per_unit` or `whole`) and an optional `role`, which comes back on the allocation so a
client can tell which resource played which part.

## Policy
Money and lifecycle rules, frozen onto each booking at creation as `policy_snapshot`, so a
policy edited later never changes what a customer was promised. Cancellation and reschedule
tiers, deposit, no-show, hold duration, confirmation requirements, `autoStart`,
`autoComplete`, `maxReschedules`.

## Customer
The minimum: `external_id`, `email`, `phone`, `name`, `timezone`, `locale`. Anything else
stays in your system, linked by `external_id`.

## Booking
The commitment. Statuses: `held`, `pending`, `confirmed`, `in_progress`, `completed`,
`cancelled`, `no_show`, `rescheduled`. Carries its allocations, its frozen price and policy,
and the expected refund, no-show charge and reschedule fee computed at each transition.

## Hold
A short reservation of the capacity while a customer pays or fills in a form. It occupies the
resource exactly like a booking until it expires or is converted.

## Event
Append-only. One event per transition, written in the same transaction as the change, and
delivered to webhook endpoints with an HMAC signature.

## Amounts and instants
Amounts are integers in the minor unit of the currency, never floats. Instants are ISO 8601
with an explicit offset on the way in, and UTC plus a `timezone` field on the way out.
