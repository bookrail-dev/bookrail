# bookrail.config.ts

The whole booking model as code: a file you keep in git, diff before applying, and push.

```ts
import { defineConfig } from 'bookrail';

export default defineConfig({
  locations: [{ id: 'club', name: 'Club', timezone: 'Europe/Rome' }],
  schedules: {
    club_hours: {
      timezone: 'Europe/Rome',
      rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '08:00', to: '23:00' }],
    },
  },
  resources: [
    { id: 'court_1', name: 'Court 1', type: 'court', location: 'club', schedule: 'club_hours' },
  ],
  resourceGroups: {
    courts: { resources: ['court_1'], allocationStrategy: 'first_available' },
  },
  policies: {
    prepaid: {
      cancellation: [{ before: '12h', refundPercent: 100 }, { before: '0h', refundPercent: 0 }],
      deposit: { type: 'percent', value: 100 },
      holdDuration: '10m',
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
      requirements: [{ group: 'courts', quantity: 1 }],
    },
  ],
});
```

## Ids are logical

`id` is your own name for the object. The push stores it in `metadata.config_id` on the
remote object; that is the entire mapping. A `res_...` identifier never appears in a config
file, and the same file applies to test and to live.

Every collection accepts two spellings: an array of objects each carrying `id`, or a record
keyed by that id. `name` defaults to the id.

## What push does

- Matches by `metadata.config_id`.
- Creates and updates in dependency order: location, schedule, resource, group, policy,
  service. Deletes in the exact reverse order.
- **Never touches an object that has no `metadata.config_id`.** Objects created through the
  API or a dashboard are listed as unmanaged and left alone.
- Refuses to delete anything without `--yes`.
- Is idempotent: running it twice is the same as running it once, and running it again after
  a failure converges.

## Field reference

`bookrail schema config --json` prints the full JSON Schema, generated from the same
validation the push uses. `bookrail schema services --json` prints one collection.

Notable fields, and what they are for:

| Field | Where | What it does |
|---|---|---|
| `capacity` | resource | How many units the resource can serve at once. Capacity 1 is enforced by a database exclusion constraint, not by application code. |
| `consumes` | requirement | `per_unit` takes `quantity` units; `whole` takes the resource entirely. A yoga instructor is `whole`: one person whatever the class size. |
| `allowSplit` | service | Lets one booking take capacity from several resources of a group (eight covers over two tables of four). |
| `bufferBefore` / `bufferAfter` | service | Minutes kept free around the booking. They are not sold to anyone. |
| `bufferSharing` | service | Lets the buffers of two adjacent bookings overlap **each other**, never the body of the other booking. |
| `bookingWindow` | service | `minNoticeMinutes` and `maxAdvanceDays`. Minutes and days, not duration strings. |
| `durationRange` | service | A rental or a meeting room: availability answers continuous ranges instead of a grid. |
| `alignTo` | service | `hour`, `half_hour` or `schedule_start`: where the slot grid is anchored. |
| `pricingRules` | service | Prices that depend on the slot. Evaluated in order; the first match wins. See below. |
| `holdDuration` | policy | How long a hold survives. `"10m"`, or a number of seconds. |
| `autoStart` / `autoComplete` | policy | Let the scheduler move a booking to `in_progress` and to `completed` by itself. |
| `noShow.autoMark` | policy | Lets the scheduler mark a no-show after the grace period. |
| `maxReschedules` | policy | How many times one booking may be moved. |

## Prices that depend on the slot

A service has one `price`. `pricingRules` changes it for the slots that match a condition:

```ts
{
  id: 'match',
  price: { amount: 3000, currency: 'EUR' },
  pricingRules: [
    { when: { days: ['sat', 'sun'] }, price: 3500, label: 'Weekend' },
    { when: { timeFrom: '18:00', timeTo: '22:00' }, priceAdd: 500, label: 'Evening' },
    { when: { durationMin: 90 }, priceMultiplier: 1.4 },
  ],
}
```

The rules are evaluated **in order and the first match wins**: there is no chaining, so a
Saturday evening costs 3500, not 4000. A rule that matches nothing costs nothing; a rule
placed after one that always matches is dead, which is why a `when` with no condition at all is
refused.

- `when` is an **and**: `days`, `timeFrom`/`timeTo`, `dateFrom`/`dateTo`, `resourceId`,
  `durationMin`. All of them read the **local clock of the offer**, never the customer's, and
  all of them are evaluated on the **start** of the slot.
- `timeFrom`/`timeTo` is half open, `[from, to)`, and wraps when `to` is before `from`:
  `22:00`-`02:00` is the night rate. Give both or neither.
- a band that wraps past midnight is written **without `days`, or with both days it touches**.
  Every condition is read on the **start** of the slot, `days` included, so
  `{ days: ['fri'], timeFrom: '22:00', timeTo: '02:00' }` covers Friday 22:30 and not Saturday
  00:30, which is the other half of the same night. Write `['fri', 'sat']` for the whole night,
  and accept that it also covers the Saturday evening, or leave `days` out.
- `dateFrom`/`dateTo`, unlike the time band, are independent: give both for a season, or one
  alone for a range open at that end. `{ dateFrom: '2026-07-01' }` is "from July on"; both
  dates are inclusive.
- exactly one of `price` (replace), `priceAdd` (add, may be negative, never goes below zero)
  and `priceMultiplier` (scale, at most four decimals, rounded to the minor unit).
- `label` is free text, at most 60 characters, and comes back in `price_rule`.
- a service with **no** `price` cannot have rules: there is nothing for them to modify, and
  the push is refused with a `400`.

The price a slot shows is the price the booking freezes. Changing the rules afterwards does not
change a booking that has already been made, and neither does rescheduling it.

**One limit worth knowing.** `when.resourceId` is a real `res_...` identifier, not a logical id
of this file: `push` does not resolve references inside pricing rules. Take the id from
`bookrail resources list` or from a `bookrail pull`.

## Time zones in a config

A schedule's `timezone` is the wall clock its `from`/`to` are read on. A rule whose `to` is
not strictly after its `from` crosses midnight: `22:00`-`02:00` is four hours and
`00:00`-`00:00` is the whole local day.

Fixed dates (a tour that runs three Wednesdays) are a schedule with **no rules** and one
`open` exception per date.
