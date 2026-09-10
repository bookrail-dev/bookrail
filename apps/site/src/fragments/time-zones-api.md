## The same rules, over HTTP

Everything above is the engine. This is what it looks like from the API, and the three habits
that keep an integration out of trouble.

### Instants in carry an offset, instants out are UTC

`from`, `to` and `start` are ISO 8601 with an explicit offset. A bare date is refused, and the
error says why rather than guessing for you:

```
Error [parameter_invalid] --from must be an ISO 8601 instant with an explicit offset, got "2026-09-14".
  param: from
  Fix: Write it as `2026-09-08T07:00:00Z` or `2026-09-08T09:00:00+02:00`. A bare date is refused because midnight is not the same instant in every time zone.
```

Every instant in a response is UTC with a `Z`. Format it for the reader at the edge of your
system, never in the middle of it.

### `timezone` is presentation, and only presentation

`POST /v1/availability` takes an optional `timezone`, and `bookrail availability --tz` sets it.
It changes the local column of the answer and nothing else. The same window asked twice, once
in `Europe/Rome` and once in `Asia/Tokyo`, returns the same UTC instants:

```
[test] 16 slot(s), times shown in Asia/Tokyo

start (UTC)               local             end (UTC)                 min  cap  price
------------------------  ----------------  ------------------------  ---  ---  ---------
2026-09-14T06:00:00.000Z  2026-09-14 15:00  2026-09-14T07:00:00.000Z  60   1    30.00 EUR
2026-09-14T06:30:00.000Z  2026-09-14 15:30  2026-09-14T07:30:00.000Z  60   1    30.00 EUR
```

Those are the same instants a request in `Europe/Rome` returns, at 08:00 and 08:30 local. The
grid belongs to the court, not to whoever is asking.

A booking stores the zone it was sold in (`timezone` on the booking), so a confirmation can be
rendered in the local time of the offer without guessing later.

### The window has limits, and they are 400s, never 500s

- A window wider than **90 days** is `400 parameter_invalid`.
- `explain` is capped at **7 days**, because it materialises a row per rejected instant.
- `GET /v1/availability/next` searches up to 90 days ahead and answers with the first bookable
  instant, which is usually the call you want instead of paging through a month.

### Reading a schedule back

`bookrail pull` writes the current project out as a `bookrail.config.ts`, with the schedules in
local time exactly as they are stored, and `bookrail diff` tells you whether a file and a
project agree. Neither converts anything to UTC on the way, because a schedule written in UTC
is a schedule that will be wrong in six months.
</content>
