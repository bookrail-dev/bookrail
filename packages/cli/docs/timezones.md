# Time zones and edge cases

Availability is computed on the **offer**, never on the buyer. A schedule's rules are written
on a local clock; they are materialised into UTC day by day with the IANA database, so the day
a clock changes has 23 or 25 hours and the rules still mean what they say locally.

- A rule's day of the week is the **local** day. A "Monday" rule in Auckland covers Sunday
  evening in UTC.
- Durations are always absolute minutes. A 60 minute booking at 01:30 on the night of the
  change lasts 60 real minutes, whatever the wall clock says.
- A multi-day booking "Friday 10:00 to Monday 10:00" is computed locally and converted: it
  lasts 71 or 73 hours when it crosses a change.

## Daylight saving

Band ends are converted with `disambiguation: compatible`:

- a **non-existent** time (02:30 on the March night) is pushed **forward** by the length of
  the jump, so 02:30 becomes 03:30 and the band keeps its wall-clock shape;
- a **repeated** time (02:30 on the October night) takes the **first** occurrence, the one
  still on summer offset.

Consequences, all under test: a `01:00`-`04:00` rule lasts 2 real hours on the spring-forward
day and 4 on the fall-back day, when the change falls inside the band; a `09:00`-`19:00` rule
lasts 10 real hours on both. A band whose two ends both fall inside the jump does not vanish:
it moves forward whole and keeps its wall-clock length. A band whose ends collapse onto the
same instant does vanish.

Slots inside a non-existent hour do not exist, not by a special rule, but because that hour
is not in the timeline.

## Rules, exceptions and blocks: the order

For each local day:

1. A `closed` exception **without hours** suppresses the day: the bands its rules would have
   produced are not generated at all, night tail included. It does **not** touch the tail of a
   band that started the day before: a bar open Tuesday 22:00-02:00 and closed on Wednesday
   still serves until 2 a.m. on Tuesday night.
2. The bands of the rules whose `days` contain the local weekday, and whose validity window
   (both ends inclusive) contains the day. `validUntil` limits the days a rule may *start* on,
   not the instants it produces.
3. The bands of that day's `open` exceptions, in addition to the rules, or alone if the day
   has no rules. On a day suppressed by step 1 they are suppressed too: **closures beat
   openings**.
4. `closed` exceptions **with hours** are subtracted. They apply even on a suppressed day,
   because a closure can cross midnight onto a day that does open.
5. Blocks are subtracted whole: inside a block the capacity is 0, whatever the resource's
   capacity.
6. Each surviving segment carries the resource's capacity.

Overlapping bands are unioned **booleanly** before capacity is applied: two rules covering the
same instant open the resource once, not twice.

## Other edge cases handled and tested

1. Two simultaneous requests for the last seat: one wins, the other gets `slot_unavailable`.
2. A hold that expires between the availability call and the confirmation: `hold_expired`.
3. A schedule change that invalidates a future booking: the booking is **not** touched; a
   `booking.orphaned` event is emitted.
4. A capacity reduction below existing bookings: same.
5. Overlapping buffers: buffers are not bookable, but they constrain the admissible starts.
   An existing occupancy carries **its own** buffers, not those of the service asking.
   With `bufferSharing: true` two buffers may overlap each other, never the body of the other
   booking. Blocks carry no buffer.
6. A booking across midnight, across a clock change, or across a closure in the middle.
7. A quantity above one resource's capacity but available across a group: `allowSplit: true`.
8. Slots partly covered by a block: eroded correctly.
9. Availability over huge windows: capped at 90 days per call, 7 with `explain`.
10. A booking in the past: refused.
11. A customer in another time zone: availability is computed on the resource and presented in
    the zone asked for.
12. A pricing rule on the hour the clocks change: see below.

## Prices that depend on the clock

`pricingRules` are read on the **local clock of the offer**, on the **start** of the slot. Four
cases follow from that, and all four are tested:

1. **A band that crosses midnight.** `timeFrom: '22:00', timeTo: '02:00'` is half open and
   wraps: it covers 22:00 to 23:59 and 00:00 to 01:59, and not 02:00 itself. Combine it with
   `days` and the wrap becomes visible: the day is the day the slot **starts** on, so
   `days: ['fri']` on that band covers Friday 22:30 and not Saturday 00:30. A night rate is
   written without `days`, or with both days it touches (`['fri', 'sat']`).
2. **The night the clocks go forward.** No instant reads 02:30 local, so a rule about
   `[02:00, 03:00)` matches nothing that night. The hour does not exist; a rule about it cannot
   fire, and the slots on either side keep the price they would have had.
3. **The night the clocks go back.** Two instants read 02:30 local, and the rule matches
   **both**. The hour happens twice, and both times cost what the rule says.
4. **A local day that is not the UTC day.** `days: ['sat']` is about the Saturday of the club.
   A slot at 00:30 on Saturday in Rome is 22:30 on Friday in UTC and is priced as Saturday; the
   same rule in Auckland moves the other way. The zone is the offer's, never the caller's.

Two more things worth knowing before you write a rule: the **first** matching rule wins and
nothing chains after it, and `priceAdd` never takes a price below zero. The price a slot shows
is the price the booking freezes, so a rule changed afterwards does not move a booking that has
already been made.
