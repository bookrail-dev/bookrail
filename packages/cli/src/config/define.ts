import type { BookrailConfigInput } from './schema.js';

/**
 * The typed entry point of `bookrail.config.ts`.
 *
 * It is the identity function: everything it gives is compile-time. Runtime validation happens
 * in the CLI, against the same Zod schema, because a config file is read by `push` far more
 * often than it is type-checked by the customer's build.
 */
export function defineConfig<const T extends BookrailConfigInput>(config: T): T {
  return config;
}

export type { BookrailConfigInput as BookrailConfig };
