/**
 * The versions of the two legal texts a customer accepts: the Terms of Service and the Data
 * Processing Agreement.
 *
 * The texts themselves are not in the code. They are written and approved outside it, and the
 * website publishes them at `/terms` and `/dpa`, reading them at build time. What the API needs is
 * only the version in force, because that is what an acceptance records: a sign up, the
 * `bookrail signup` command and the dashboard before a checkout all write the pair below next to
 * the account, and a new version is presented to the account before its next checkout.
 *
 * A test compares these two strings with the front matter of the texts, where the texts are in
 * the working copy, so a new version published without updating this file fails the build.
 */
export const LEGAL_VERSIONS: LegalVersions = {
  terms: '2026-09-25',
  dpa: '2026-09-25',
};

export interface LegalVersions {
  readonly terms: string;
  readonly dpa: string;
}

/**
 * Is this the version of a text that must never be accepted for real: a draft (`...-draft`), or
 * the fixture of a test suite (`...-fixture`)?
 */
export function isUnpublishableLegalVersion(version: string): boolean {
  return /-(draft|fixture)$/i.test(version.trim());
}

/**
 * Why an API in production must not start with these versions, or `null` when it may. An API
 * that records acceptances of a draft would hold, in `terms_acceptances`, the proof of an
 * agreement to a text nobody published.
 */
export function legalVersionsRefusal(versions: LegalVersions): string | null {
  const drafts = (
    [
      ['Terms of Service', versions.terms],
      ['Data Processing Agreement', versions.dpa],
    ] as const
  ).filter(([, version]) => isUnpublishableLegalVersion(version));
  if (drafts.length === 0) return null;
  return (
    `The ${drafts.map(([name, version]) => `${name} (${version})`).join(' and ')} ` +
    `${drafts.length === 1 ? 'is a draft' : 'are drafts'}, and NODE_ENV=production records ` +
    'real acceptances of them. Publish the approved texts (status: approved in legale/) and set ' +
    'the same versions in packages/shared/src/legal.ts before releasing.'
  );
}

/** Where a customer accepted: the sign up page, the terminal, or the dashboard before paying. */
export const TERMS_CHANNELS = ['web', 'cli', 'dashboard'] as const;

export type TermsChannel = (typeof TERMS_CHANNELS)[number];

/** The published pages, and the anchor of the clauses approved one by one. */
export const TERMS_URL = 'https://bookrail.dev/terms';
export const DPA_URL = 'https://bookrail.dev/dpa';
export const TERMS_CLAUSES_URL = 'https://bookrail.dev/terms#17-specific-approval';

/** The two sentences a customer ticks, word for word, wherever they tick them. */
export const TERMS_ACCEPTANCE_TEXT =
  'I accept the Terms of Service and the Data Processing Agreement on behalf of my business';
export const TERMS_CLAUSES_TEXT =
  'I specifically approve the clauses listed in Section 17 of the Terms (Articles 1341 and 1342 of the Italian Civil Code)';
