# `@bookrail/webhook-signature`

Verify (and sign) Bookrail webhook payloads. **Zero runtime dependencies**: `node:crypto` and
nothing else.

This is the one piece of Bookrail that runs on your machine rather than ours, so it is a
package of its own, small enough to install for the thirty two bytes it compares.

```bash
npm install @bookrail/webhook-signature
```

```ts
import express from 'express';
import { verifySignature } from '@bookrail/webhook-signature';

app.post('/hooks/bookrail', express.raw({ type: 'application/json' }), (request, response) => {
  const ok = verifySignature(
    request.body.toString('utf8'),          // the RAW bytes, exactly as they arrived
    request.get('Bookrail-Signature'),
    process.env.BOOKRAIL_WEBHOOK_SECRET!,
  );
  if (!ok) return response.sendStatus(400);

  const event = JSON.parse(request.body.toString('utf8'));
  // Deduplicate on event.id: delivery is at least once.
  response.sendStatus(200);
});
```

## The signature

```
Bookrail-Signature: t=1789012345,v1=6f1c...
```

`v1` is `HMAC-SHA256(secret, "<t>.<raw body>")`, hex encoded.

The timestamp is **inside** the signed payload on purpose. Without it a signature is valid
forever, and anyone who captured one delivery could replay it at any point in the future with
no way for a receiver to tell. With it, a receiver that also checks the age of `t` has a
bounded window. The default tolerance is 300 seconds, in both directions, because clock skew is
symmetric.

## Three things that matter

1. **Pass the raw bytes.** A body that was parsed and re-encoded will not verify: two JSON
   encoders disagree about key order and whitespace. In Express that is `express.raw`, never
   `express.json`.
2. **It returns `false`, it never throws.** A receiver is by definition handling input from the
   network, and a verifier that throws on a malformed header turns a forged request into a 500
   instead of a 400.
3. **The comparison is constant time**, and a header may carry several `v1=` values so a secret
   can be rotated without a window in which deliveries fail. This function accepts if any of
   them matches the secret you hold. Bookrail does not rotate secrets yet; the receiver you
   deploy today keeps working on the day it starts.

## API

```ts
verifySignature(body, header, secret, toleranceSeconds?, nowSeconds?): boolean
parseSignatureHeader(header): { timestamp: number; signatures: string[] } | null
signPayload(body, secret, timestampSeconds): string    // the header value
computeSignature(body, secret, timestampSeconds): string
signaturePayload(timestampSeconds, body): string       // "<t>.<body>"

SIGNATURE_HEADER      // 'Bookrail-Signature'
EVENT_ID_HEADER       // 'Bookrail-Event-Id'
WEBHOOK_ID_HEADER     // 'Bookrail-Webhook-Id'
DELIVERY_ID_HEADER    // 'Bookrail-Delivery-Id'
DEFAULT_SIGNATURE_TOLERANCE_SECONDS   // 300
SIGNATURE_SCHEME      // 'v1'
```

`@bookrail/node` wraps this in `webhooks.constructEvent(rawBody, header, secret)`, which
verifies and parses in one call, and the `bookrail` CLI uses it in `webhooks listen`. One
verifier in the whole project: a receiver that accepts a delivery nobody signed, or refuses one
that was signed, is a security bug either way, and two implementations would be one too many.

ESM only, Node 20.10 or newer.

## Documentation

[Webhooks](https://bookrail.dev/docs/guides/webhooks/): registering an endpoint, the retry
ladder, replays, deduplication, and the rule about which URLs are allowed to exist.

## Status

Early access. This package is on npm as
[`@bookrail/webhook-signature`](https://www.npmjs.com/package/@bookrail/webhook-signature),
Apache 2.0, with its source in
[github.com/bookrail-dev/bookrail](https://github.com/bookrail-dev/bookrail) under
`packages/webhook-signature`.

## Licence

Apache-2.0.
