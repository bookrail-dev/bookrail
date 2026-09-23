---
title: 'Payments with Stripe'
description: 'Connect your own Stripe account, take a deposit or the full price on a booking, and let a cancellation refund it according to your policy.'
sidebar:
  order: 44
---

Bookrail charges on **your** Stripe account, not on ours. You connect it once, over Stripe's
own authorisation page, and from then on Bookrail can act for that account.

There is no field anywhere in Bookrail where you paste a Stripe secret key, and there will not
be one. Bookrail is a Stripe Connect platform: it acts for your account with its own platform
key plus a `Stripe-Account` header, so a key of yours would be a secret held for nothing. You
stay the merchant, Stripe bills you its fees directly, and Bookrail holds no money.

:::note
What is here: connecting the account, taking a deposit or the full price when a booking is
made, and refunding it when a cancellation says so. What is not here yet: a balance charged
later, a saved card, charging a no-show, a refund asked for through the API rather than through
a cancellation, and rescheduling a booking that has money on it.
:::

## Three commands

```bash
bookrail stripe connect      # prints a link, opens it, waits until you have authorised
bookrail stripe status       # which account, and whether it can take charges
bookrail stripe disconnect --yes
```

`connect` prints the authorisation link, opens it in your browser, and then polls until the
browser has come back. Use `--no-open` on a machine with no desktop (the link is printed either
way) and `--no-wait` in a script. The link works once, and for fifteen minutes.

You need to be signed in to Stripe as the owner of the account you want to connect, in the
browser that opens. Connect the **test** account first: `bookrail stripe connect` without
`--live` asks for an authorisation in Stripe's test mode, and a test account authorised for the
live environment is refused rather than quietly stored.

Everything the CLI does here is also in the SDK:

```ts
const link = await bookrail.stripe.connect();
console.log(`Open ${link.url} before ${link.expires_at}`);

const connection = await bookrail.stripe.retrieve();
// { status: 'connected', account_id: 'acct_...', publishable_key: 'pk_...',
//   charges_enabled: true, ... }
```

## In your front end: the publishable key is the platform's

This is the one thing that surprises people, so it is worth stating plainly. For a direct charge
on a connected account, Stripe.js is initialised with the **platform's** publishable key and the
connected account id, not with a publishable key of yours:

```ts
const connection = await bookrail.stripe.retrieve();

const stripe = await loadStripe(connection.publishable_key, {
  stripeAccount: connection.account_id,
});
```

`GET /v1/stripe` returns `publishable_key` whatever the status is, so you can write the front end
before the account is connected.

## Reading the status

```json
{
  "object": "stripe_connection",
  "status": "connected",
  "environment": "test",
  "account_id": "acct_...",
  "publishable_key": "pk_test_...",
  "charges_enabled": true,
  "webhook_configured": true,
  "connected_at": "2026-09-22T16:02:11Z",
  "disconnected_at": null,
  "disconnect_reason": null
}
```

- `status` is `connected`, `not_connected` (you have never completed an authorisation for this
  project and environment) or `disconnected` (you had one and it is not in force any more).
- `charges_enabled` comes from Stripe at the moment you ask, and only while connected. It is
  `null` when nothing is connected **and** when Stripe did not answer in time. `null` is not
  `false`: it means nobody knows right now, and the rest of the answer, which comes from
  Bookrail's own records, is still true.
- `charges_enabled: false` on a connected account usually means the Stripe onboarding of that
  account is not finished. Finish it in the Stripe dashboard; nothing needs to change here.

- `webhook_configured` is about the **deployment**, not about your project: it says whether the
  Stripe webhook endpoint has been registered and its signing secret configured. `false` means
  payments would start normally and none of them would ever be confirmed, because nothing would
  be listening. On `bookrail.dev` it is true.

`bookrail doctor` reports the same thing as a `stripe_connection` check, with the command that
fixes it.

## Test and live are separate connections

One connection per project **and environment**. Connecting in test does not connect live, and
the authorisation Stripe grants carries the mode it was granted in: if the two disagree, the
callback refuses and writes nothing. That is deliberate. A live project charging a test account
takes no money, and a test project charging a live one takes real money.

## One account per project, and it is never replaced silently

Once a project is connected, a second authorisation cannot move it to another account. Any link
minted earlier stops working the moment a connection exists, a link minted by an API key that
has since been revoked stops working at that moment too, and a browser that arrives late is told
which account the project is already connected to. Changing account is
`bookrail stripe disconnect --yes` followed by `bookrail stripe connect`, in that order, on
purpose: the account a business is paid on is not something that should change without somebody
deciding it.

## Taking a deposit or the full price

Once an account is connected, a booking can take money:

```bash
bookrail bookings create --service svc_... --start 2026-10-05T09:00:00+02:00 --payment deposit
```

```ts
const booking = await bookrail.bookings.create({
  service_id: 'svc_...',
  start: '2026-10-05T09:00:00+02:00',
  payment: { mode: 'deposit' },
});
```

`deposit` uses the `deposit` rule of the policy that applies to the service; `full` charges the
whole price the booking froze. Both refuse rather than guess: a service with no price answers
`400 price_missing`, a policy with no deposit answers `400 deposit_not_configured`, a project
with no connected account answers `409 stripe_not_connected`, and an amount that works out to
zero answers `400 payment_amount_invalid` and tells you to use `payment.mode: "none"`.

Set the deposit on the policy:

```bash
bookrail policies create --set name=Standard \
  --data '{"deposit": {"type": "percent", "value": 30}}'
```

`percent` is a percentage of the frozen price, rounded **down**; `fixed` is an amount in the
minor unit of the currency, capped at the price. A pricing rule that makes Saturday evening
more expensive makes the deposit larger to match, because the deposit is computed from the
price the booking actually froze.

## The answer, and the one value you get once

```json
{
  "id": "bk_...",
  "status": "pending",
  "amount_due": 1500,
  "amount_paid": 0,
  "payment_expires_at": "2026-09-22T16:32:11Z",
  "payment_intent": {
    "id": "pi_...",
    "client_secret": "pi_..._secret_...",
    "amount": 1500,
    "currency": "EUR",
    "status": "requires_payment_method",
    "stripe_account": "acct_...",
    "publishable_key": "pk_test_...",
    "payment_id": "pay_..."
  }
}
```

The booking is **pending**, and it holds its slot: nobody else can book it while the customer
pays. `client_secret` is returned **once**. Bookrail stores it nowhere: not in a column, not in
a log, and not in the body it remembers for an `Idempotency-Key`, so a retry of the same key
answers the same booking with `client_secret: null`. If you lose it, read it again:

```ts
const payment = await bookrail.payments.retrieve(booking.payment_intent.payment_id);
// payment.client_secret, for as long as the payment is pending
```

## In your front end

```tsx
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement } from '@stripe/react-stripe-js';

const stripe = await loadStripe(booking.payment_intent.publishable_key, {
  stripeAccount: booking.payment_intent.stripe_account,
});

<Elements stripe={stripe} options={{ clientSecret: booking.payment_intent.client_secret }}>
  <PaymentElement />
</Elements>;
```

The publishable key is the **platform's** and the account is yours: that is how a direct charge
on a connected account works, and it is the same pair `GET /v1/stripe` returns. Which payment
methods the customer is offered is decided by **your** Stripe dashboard, for the currency and
the amount: Bookrail asks for none in particular.

## What happens next, and what you listen to

The booking becomes `confirmed` when Stripe tells Bookrail the money arrived. Listen for it:

```bash
bookrail webhooks create --url https://example.com/hooks \
  --event booking.confirmed --event payment.succeeded --event payment.refunded
```

- `payment.succeeded`: the money arrived. `amount_paid` on the booking has moved and
  `amount_due` is down to zero.
- `booking.confirmed`: the slot is the customer's. It does **not** arrive when your policy has
  `require_customer_confirmation` or `require_provider_confirmation`: being paid does not accept
  a booking for you, so it stays `pending` and you confirm it when you are ready.
- `payment.failed`: a card was refused. The booking stays `pending` and the same
  `client_secret` still works: the customer can try another card until the deadline.
- `booking.cancelled` with `cancellation_reason: "payment_timeout"`: nobody paid in time.

Never confirm a booking whose payment is still in flight. The API refuses it with
`409 payment_pending`, because confirming would tell the customer the slot is theirs while the
card may still be refused.

## The thirty minute deadline

`payment_expires_at` is thirty minutes after the booking was made. A booking that is still
waiting for its money at that instant is cancelled, its slot goes back on the market, and its
PaymentIntent is cancelled at Stripe. It is not optional: a `pending` booking holds capacity
exactly like a confirmed one, so without a deadline a customer who closed the browser would
hold the slot for ever.

If the payment succeeds anyway, a moment too late, the money is **refunded in full**
automatically: the slot is gone and keeping the money for it is not an option. The
`payment.succeeded` event for that case carries `booking_status: "cancelled"`, so your own
system can see what happened.

## Refunds

A refund is not something you ask for directly. It is what a cancellation does, according to
the policy the customer agreed to when they booked:

```bash
bookrail bookings cancel bk_... --yes --reason 'customer changed their mind'
```

The tiers of `cancellation` decide the percentage, `refund_amount_expected` on the booking says
what it works out to, and a `payments` row of type `refund` is created and sent to Stripe by
the background worker within seconds. It is `pending` until Stripe confirms the money moved and
`succeeded` afterwards, and `payment.refunded` is the event that says so.

```bash
bookrail payments list --booking bk_... --json
```

A refund you make from your **own** Stripe dashboard is recorded too: the counters on the
booking tell the truth about the money whoever moved it.

## What is not supported yet

**Rescheduling a booking that has a payment on it** answers `422 reschedule_not_supported`. A
reschedule creates a new booking and freezes the price of the new slot on it, and there is no
rule yet for the difference between the two prices. Cancel it, which refunds it according to
your policy, and create a new booking.

**A no-show does not refund the deposit,** which is the point of a deposit. It also does not
charge anything extra: `no_show_charge_expected` is an expectation and charging it needs a
saved card, which does not exist yet.

## Disconnecting

`bookrail stripe disconnect --yes` revokes Bookrail's access to the account. Bookrail stops
being able to charge on it; nothing already taken is affected. Reconnecting afterwards is the
same `bookrail stripe connect`.

The connection is recorded as disconnected only once Stripe has confirmed the revocation. If
Stripe refuses, the command fails and nothing is written: telling you that you had revoked
something you had not would be worse than an error.

You can also revoke the authorisation from your own Stripe dashboard, under Connected apps.
Bookrail finds out: Stripe sends an `account.application.deauthorized` event, the connection is
recorded as `disconnected` with `disconnect_reason: "deauthorized"`, and a `stripe.disconnected`
event is written to your log.

## What Bookrail stores, and what it does not

Stored: the account identifier (`acct_...`), whether the link is in force, and when it changed.
The account identifier is not a secret: it travels as a request header.

Not stored: any Stripe key of yours, and not even the OAuth access and refresh tokens the
authorisation returns. They are dropped before they reach anything that could write them down.

## If the link fails

An authorisation link works exactly once. If something goes wrong halfway through, the link is
spent and the page says so: run `bookrail stripe connect` again to get a new one. That is the
price of a link that can only ever be used once, which is what stops somebody else's
authorisation code from being attached to your project.
