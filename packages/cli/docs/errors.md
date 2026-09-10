# Errors

Every error, from the API and from the CLI, has a machine code, a human message, the guilty
field when there is one, a documentation URL, and, from the CLI, a `fix`: one sentence that
says what to do next.

```json
{ "ok": false, "environment": "test",
  "error": {
    "code": "slot_unavailable",
    "message": "The requested slot is no longer available. 1 unit requested, 0 available.",
    "param": "start",
    "doc_url": "https://bookrail.dev/docs/errors#slot_unavailable",
    "fix": "The capacity is gone. Run `bookrail availability --service ... --explain` to see what took it.",
    "request_id": "req_..."
  } }
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | User or configuration error. Re-running the same command fails the same way. |
| 2 | Authentication or permission. |
| 3 | Network, timeout, rate limit or server fault. Retrying later may work. |
| 4 | Conflict: the state changed underneath. Retrying may work right now. |

## Types

`invalid_request` (400), `authentication` (401), `permission` (403), `not_found` (404),
`conflict` (409), `rate_limit` (429), `policy_violation` (422), `payment_required` (402),
`internal` (500).

## Codes you will meet

| Code | Type | When |
|---|---|---|
| `missing_api_key`, `invalid_api_key`, `revoked_api_key` | authentication | No key, a malformed one, or one that was revoked. |
| `live_key_without_live` | authentication (CLI) | A `sk_live_` key is configured and `--live` was not typed. Nothing was sent. |
| `parameter_missing`, `parameter_invalid`, `invalid_body` | invalid_request | The request body. |
| `resource_missing` | not_found | An id that does not exist in this project and environment. |
| `slot_unavailable` | conflict | The capacity is gone. The message carries the units requested and available. |
| `hold_expired`, `hold_not_active` | conflict | The hold died or was already used. |
| `serialization_failure` | conflict | Nothing was written. Run the command again. |
| `idempotency_key_in_progress` | conflict | Another request with the same key is still running. |
| `idempotency_key_reused` | invalid_request | The same key was used for a *different* request. |
| `start_not_on_grid` | policy_violation | The instant is not on the slot grid of the service. |
| `min_notice_violated`, `outside_booking_window` | policy_violation | The booking window of the service. |
| `customer_limit_reached` | policy_violation | `maxActiveBookingsPerCustomer` is reached. |
| `duration_not_offered` | invalid_request | Not one of the service's durations. |
| `resource_not_eligible` | invalid_request | A forced resource is not a candidate of any requirement. |
| `invalid_transition` | conflict | The booking's state does not allow that action. |
| `no_show_too_early`, `complete_too_early` | policy_violation | Too early for that transition. |
| `max_reschedules_reached` | policy_violation | The policy's limit. |
| `range_too_large`, `invalid_range`, `timezone_missing` | invalid_request | Availability requests. |
| `invalid_webhook_url` | invalid_request | Not public, or `http` on live. |

Two codes that people expect and that do **not** exist: `capacity_exceeded` (a quantity above
capacity is `slot_unavailable`, whose message is more precise) and `schedule_conflict` (a
calendar change that invalidates a future booking is not an error: it emits a
`booking.orphaned` event and leaves the booking alone).

## CLI-only codes

| Code | Meaning |
|---|---|
| `config_not_found` | No `bookrail.config.*` in the working directory. |
| `invalid_config` | The file parsed but does not validate. The message lists each position. |
| `config_unreadable` | The file could not be evaluated. Usually a TypeScript config on a Node without a TypeScript loader. |
| `confirmation_required` | The command would delete something and `--yes` was not given. |
| `ambiguous_config_id` | Two remote objects carry the same `metadata.config_id`. |
| `missing_input` | A required value was not given and there was no terminal to ask on. |
| `network_error`, `timeout` | The API could not be reached. |
