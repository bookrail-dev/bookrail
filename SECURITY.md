# Security policy

## Reporting a vulnerability

Write to **hello@bookrail.dev**. Do not open a public issue, and do not open a pull request
that fixes it before it has been discussed: both of those publish the vulnerability before
anybody can act on it.

Include, as far as you can:

- what the problem is, and which package, endpoint or command it affects;
- how to reproduce it, ideally as a failing test or a sequence of `curl` calls;
- what an attacker gets out of it;
- the version or the commit you looked at.

If you want an encrypted channel, say so in a first message with no details and one will be
arranged.

## What happens then, honestly

Bookrail is built by a very small team. These are the times it can actually keep, not the ones
that look good in a policy:

| | |
| --- | --- |
| Acknowledgement of your report | within 3 working days |
| First assessment, with a severity and a plan | within 10 working days |
| Fix for a serious issue | as fast as it can be done, and you are told the date |
| Public disclosure | after the fix is released, with credit unless you prefer not |

If you have not heard back within the acknowledgement window, send the message again: it was
lost, not ignored.

## Scope

In scope: the code in this repository, the packages published from it (`bookrail`,
`@bookrail/node`, `@bookrail/mcp`, `@bookrail/webhook-signature`), the schema and its row level
security policies, and the hosted API at `api.bookrail.dev`.

Out of scope: automated scanner output with no demonstrated impact, missing hardening headers
on the marketing site, denial of service by volume against the hosted API, social engineering,
and anything that requires access to a machine you have already compromised.

Please do not run load tests, brute force, or anything destructive against the hosted API. If
you need an account to test with, ask for one.

## No bug bounty

There is no money. There is no swag. What there is: a credit in the release notes and in this
file, a direct line to the person who wrote the code, and a fix. If that is not worth your time
that is entirely fair, and no hard feelings.

## Supported versions

The latest released version of each package is the one that gets fixes. There are no long term
support branches yet. When there are, they will be listed here.
