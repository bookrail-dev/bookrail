/**
 * The webhook signature, re-exported from `@bookrail/webhook-signature`.
 *
 * The implementation moved out of this package. The reason is not tidiness: the
 * verifier is the one function of Bookrail that runs on **the customer's** machine, and it was
 * duplicated, once here, once as a forty-line copy inside the CLI, which publishes on its own
 * and could not depend on `@bookrail/shared` (id generation, Drizzle-adjacent error types, a
 * logger) to check thirty-two bytes. Now there is one verifier, in a package with no runtime
 * dependencies that a customer can install by itself.
 *
 * `@bookrail/shared` re-exports it rather than making every server-side caller change its
 * import, because the choice between "one import path for server code" and "one implementation"
 * is a false one: the re-export gives both. `packages/api/src/webhooks/deliver.ts` therefore
 * still imports `buildSignatureHeader` from here, and it is still the same function object as
 * `signPayload` in the package.
 */
export * from '@bookrail/webhook-signature';
