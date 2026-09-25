/**
 * The sentences and the addresses of the terms the CLI shows, against the ones the API records.
 *
 * The CLI is published on its own and does not import the server's constants, so the two copies
 * are compared here: a sentence changed on one side only would have somebody accept, in the
 * terminal, words that are not the ones on the website.
 */
import { describe, expect, it } from 'vitest';
import {
  DPA_URL as SHARED_DPA_URL,
  TERMS_ACCEPTANCE_TEXT as SHARED_ACCEPTANCE,
  TERMS_CLAUSES_TEXT as SHARED_CLAUSES,
  TERMS_CLAUSES_URL as SHARED_CLAUSES_URL,
  TERMS_URL as SHARED_TERMS_URL,
} from '@bookrail/shared';
import {
  DPA_URL,
  TERMS_ACCEPTANCE_TEXT,
  TERMS_CLAUSES_TEXT,
  TERMS_CLAUSES_URL,
  TERMS_URL,
} from '../src/terms.js';

describe('the terms of bookrail signup', () => {
  it('are word for word the ones the API and the website use', () => {
    expect(TERMS_URL).toBe(SHARED_TERMS_URL);
    expect(DPA_URL).toBe(SHARED_DPA_URL);
    expect(TERMS_CLAUSES_URL).toBe(SHARED_CLAUSES_URL);
    expect(TERMS_ACCEPTANCE_TEXT).toBe(SHARED_ACCEPTANCE);
    expect(TERMS_CLAUSES_TEXT).toBe(SHARED_CLAUSES);
  });
});
