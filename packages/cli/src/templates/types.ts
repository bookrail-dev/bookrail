import type { BookrailConfigInput } from '../config/schema.js';

export interface Template {
  /** `bookrail init --template <name>`. */
  name: string;
  /** One line, printed by `bookrail init --help` and by `bookrail examples`. */
  summary: string;
  /**
   * Which of the nine verticals this template implements, numbered and named, or `none` for the
   * empty template, which implements no vertical at all.
   */
  vertical: string;
  /** Comment lines written at the top of the generated `bookrail.config.ts`. */
  notes: string[];
  config: BookrailConfigInput;
}
