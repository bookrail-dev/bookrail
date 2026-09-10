/**
 * The consent state machine, with no DOM in it.
 *
 * Bookrail's website sets no cookie and calls no third party, so this code is **dormant**: it
 * exists so that the day something is added which genuinely needs consent, the correct
 * behaviour is already written, reviewed and tested rather than improvised under pressure. Both
 * `ConsentBanner.astro` and this module do nothing unless the build carries
 * `PUBLIC_CONSENT_BANNER=1`, and `test/consent.test.ts` asserts that the compiled site contains
 * neither the markup nor the cookie name.
 *
 * The rules it implements come from the GDPR, the ePrivacy directive, the Italian Garante's
 * 2021 cookie guidelines and the EDPB's guidance on valid consent:
 *
 * - nothing non necessary happens before a choice. Not on load, not on scroll, not on a click
 *   somewhere else on the page;
 * - the three actions are equivalent. Accept all, Reject all and Manage have the same visual
 *   weight and sit in the same place, and refusing takes the same one click as accepting;
 * - closing the banner or scrolling is not consent. There is no close button that means yes;
 * - the choice is stored in a first party technical cookie, per category, for six months, and
 *   can be changed at any time from a link in the footer that reopens the panel;
 * - necessary is always on and cannot be switched off, because it is not consent based.
 *
 * The preferred alternative remains not needing any of this: a self hosted, cookie free
 * analytics such as Plausible or Umami requires no banner at all.
 */

/** First party, technical, and named so a reader can find it in the browser. */
export const CONSENT_COOKIE = 'bookrail_consent';

/** Six months. Long enough not to nag, short enough to be a real re-ask. */
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 182;

/** Bumped when the categories change, which invalidates every stored choice. */
export const CONSENT_VERSION = 1;

export type ConsentCategory = 'necessary' | 'analytics' | 'external_media';

/** The categories, in the order the panel lists them, with what a reader needs to decide. */
export const CONSENT_CATEGORIES: readonly {
  id: ConsentCategory;
  label: string;
  always: boolean;
  purpose: string;
  provider: string;
  duration: string;
}[] = [
  {
    id: 'necessary',
    label: 'Necessary',
    always: true,
    purpose: 'Remembering this choice, and nothing else.',
    provider: 'Bookrail, first party',
    duration: '6 months',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    always: false,
    purpose: 'Counting page views to see which documentation is read.',
    provider: 'Named here when one exists',
    duration: 'Stated here when one exists',
  },
  {
    id: 'external_media',
    label: 'External media',
    always: false,
    purpose: 'Playing a video or a demo hosted somewhere else.',
    provider: 'Named here when one exists',
    duration: 'Stated here when one exists',
  },
];

export interface ConsentChoice {
  version: number;
  /** Always true. It is not consent based, so it is not a choice. */
  necessary: true;
  analytics: boolean;
  external_media: boolean;
  /** When the choice was made, ISO 8601, so an audit can see it and so can the visitor. */
  at: string;
}

/** No stored choice yet. Everything optional is off, which is the only lawful default. */
export function defaultChoice(now: Date): ConsentChoice {
  return {
    version: CONSENT_VERSION,
    necessary: true,
    analytics: false,
    external_media: false,
    at: now.toISOString(),
  };
}

export function acceptAll(now: Date): ConsentChoice {
  return { ...defaultChoice(now), analytics: true, external_media: true };
}

export function rejectAll(now: Date): ConsentChoice {
  return defaultChoice(now);
}

export function fromCategories(
  selected: Partial<Record<ConsentCategory, boolean>>,
  now: Date,
): ConsentChoice {
  return {
    ...defaultChoice(now),
    analytics: selected.analytics === true,
    external_media: selected.external_media === true,
  };
}

/**
 * Reads the choice out of a `document.cookie` string.
 *
 * Anything unreadable, or written by an older version of the categories, is `null`: an
 * unparseable cookie must mean "ask again", never "assume yes".
 */
export function readChoice(cookieHeader: string): ConsentChoice | null {
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.split('=');
    if (rawName === undefined || rawName.trim() !== CONSENT_COOKIE) continue;
    try {
      const parsed: unknown = JSON.parse(decodeURIComponent(rest.join('=')));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const value = parsed as Record<string, unknown>;
      if (value.version !== CONSENT_VERSION) return null;
      return {
        version: CONSENT_VERSION,
        necessary: true,
        analytics: value.analytics === true,
        external_media: value.external_media === true,
        at: typeof value.at === 'string' ? value.at : '',
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The `document.cookie` string for a choice.
 *
 * `SameSite=Lax` and `Path=/` because it is read on every page of one site and sent nowhere
 * else. `Secure` because the site is served over TLS. No `Domain`, so it never reaches a
 * subdomain that has nothing to do with it.
 */
export function serializeChoice(
  choice: ConsentChoice,
  { maxAgeSeconds = CONSENT_MAX_AGE_SECONDS, secure = true } = {},
): string {
  const value = encodeURIComponent(JSON.stringify(choice));
  return [
    `${CONSENT_COOKIE}=${value}`,
    `Max-Age=${String(maxAgeSeconds)}`,
    'Path=/',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Everything the controller needs from a browser, so a test can hand it something else. */
export interface ConsentEnvironment {
  readCookies: () => string;
  writeCookie: (value: string) => void;
  prefersReducedMotion: () => boolean;
  now: () => Date;
}

export interface ConsentController {
  /** The stored choice, or `null` when the visitor has not decided yet. */
  readonly choice: ConsentChoice | null;
  /** True when the banner has to be shown: no stored choice, or the visitor reopened it. */
  readonly visible: boolean;
  /** True when the panel with the per category switches is open. */
  readonly managing: boolean;
  /** False under `prefers-reduced-motion`, so the caller shows the final state at once. */
  readonly animate: boolean;
  acceptAll: () => ConsentChoice;
  rejectAll: () => ConsentChoice;
  save: (selected: Partial<Record<ConsentCategory, boolean>>) => ConsentChoice;
  manage: () => void;
  /** Reopen from the footer link. It does not clear the stored choice: it shows it again. */
  reopen: () => void;
}

/**
 * The controller.
 *
 * Constructing it **writes nothing**. That is the whole point, and the first assertion of
 * `test/consent.test.ts`: a visitor who has not chosen anything leaves no trace behind.
 */
export function createController(environment: ConsentEnvironment): ConsentController {
  let choice = readChoice(environment.readCookies());
  let visible = choice === null;
  let managing = false;

  const persist = (next: ConsentChoice): ConsentChoice => {
    choice = next;
    environment.writeCookie(serializeChoice(next));
    visible = false;
    managing = false;
    return next;
  };

  return {
    get choice() {
      return choice;
    },
    get visible() {
      return visible;
    },
    get managing() {
      return managing;
    },
    get animate() {
      return !environment.prefersReducedMotion();
    },
    acceptAll: () => persist(acceptAll(environment.now())),
    rejectAll: () => persist(rejectAll(environment.now())),
    save: (selected) => persist(fromCategories(selected, environment.now())),
    manage: () => {
      managing = true;
      visible = true;
    },
    reopen: () => {
      visible = true;
      managing = true;
    },
  };
}

/** The browser environment, used by `ConsentBanner.astro` and by nothing else. */
export function browserEnvironment(): ConsentEnvironment {
  return {
    readCookies: () => document.cookie,
    writeCookie: (value) => {
      document.cookie = value;
    },
    prefersReducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    now: () => new Date(),
  };
}
