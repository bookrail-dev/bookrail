/**
 * The terms a sign up accepts, as the CLI shows them.
 *
 * The same sentences and the same addresses as the sign up page of the website and the dashboard,
 * written here rather than imported: the CLI is published on its own and depends on nothing of the
 * server. `terms.test.ts` compares them with the ones the API records.
 */
export const TERMS_URL = 'https://bookrail.dev/terms';
export const DPA_URL = 'https://bookrail.dev/dpa';
export const TERMS_CLAUSES_URL = 'https://bookrail.dev/terms#17-specific-approval';

export const TERMS_ACCEPTANCE_TEXT =
  'I accept the Terms of Service and the Data Processing Agreement on behalf of my business';
export const TERMS_CLAUSES_TEXT =
  'I specifically approve the clauses listed in Section 17 of the Terms (Articles 1341 and 1342 of the Italian Civil Code)';
