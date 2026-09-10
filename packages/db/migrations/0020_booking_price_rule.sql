-- 0020: which pricing rule priced a booking.
--
-- Until this migration `services.pricing_rules` was a column nobody read: the engine stamped
-- the flat `services.price_amount` on every slot and the booking froze that. The rules are now
-- evaluated (`packages/engine/src/availability/pricing.ts`) and the price they produce is the
-- one frozen in `bookings.price_amount`, which is what the refund, the reschedule fee and the
-- no-show charge are computed from.
--
-- A frozen number with no provenance is a number nobody can argue with. `price_rule` records
-- **which** rule produced it:
--
--   {"index": 0, "label": "Weekend"}    the rule at that position of services.pricing_rules
--   null                                the flat price of the service applied
--
-- `index` points into the column as the caller wrote it, holes included: a stored rule the
-- strict schema refuses is skipped at evaluation but keeps its position, so the pointer never
-- renumbers itself (`packages/engine/src/availability/load.ts`).
--
-- It is a **snapshot**, in the same sense as `policy_snapshot`: the service's rules can change,
-- be reordered or be deleted afterwards, and this row still says what applied at the moment of
-- sale. It is deliberately not a foreign key (a rule is a position in a jsonb array, not a row)
-- and the label is copied rather than resolved, for exactly the same reason.
--
-- Every booking that existed before this migration keeps `NULL`, which is true of them: they
-- were all priced flat, because nothing else was possible.
--
-- Two constraints, because the column carries two invariants and only one of them is a shape.
-- The second one, `bookings_price_rule_needs_price`, is the link that matters: a rule is what
-- produced an amount, so a booking with no amount cannot name one. The engine already respects
-- it (`priceRuleOf` answers NULL exactly when `priceForSlot` does); a row that broke it would be
-- a provenance without a number, which no reader of this table could make sense of.
--
-- No new table, so no RLS and no grant to add: `bookings` already carries the policy and the
-- privileges 0007 gave it, and a column inherits the privileges of its table.

ALTER TABLE bookings
  ADD COLUMN price_rule jsonb
    CHECK (price_rule IS NULL OR jsonb_typeof(price_rule) = 'object');

ALTER TABLE bookings
  ADD CONSTRAINT bookings_price_rule_needs_price
    CHECK (price_rule IS NULL OR price_amount IS NOT NULL);

COMMENT ON COLUMN bookings.price_rule IS
  'Which services.pricing_rules entry priced this booking: {"index": n, "label": string|null}. '
  'NULL when the flat service price applied, and NULL whenever price_amount is NULL, which a '
  'CHECK enforces. A snapshot, like policy_snapshot: the rules may change afterwards, and this '
  'row still says which one applied at the moment of sale.';
