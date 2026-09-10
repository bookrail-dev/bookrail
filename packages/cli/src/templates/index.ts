import { clinic } from './clinic.js';
import { coworking } from './coworking.js';
import { empty } from './empty.js';
import { gym } from './gym.js';
import { padel } from './padel.js';
import { rental } from './rental.js';
import { restaurant } from './restaurant.js';
import { salon } from './salon.js';
import { tours } from './tours.js';
import { tutoring } from './tutoring.js';
import type { Template } from './types.js';

/**
 * The nine verticals shipped as templates (salon, padel, gym, rental, restaurant, clinic,
 * coworking, tours and tutoring), each one a scenario the engine already has a regression test
 * for (`packages/engine/test/availability.verticals.test.ts`), plus `empty`.
 *
 * Every template is a typed value rather than a text file: it is type-checked by `tsc`,
 * validated against the config schema by the test suite, and rendered to
 * `bookrail.config.ts` by the same writer `pull` uses, so a template can never drift into a
 * file that `bookrail push` refuses.
 */
export const TEMPLATES: Record<string, Template> = {
  salon,
  padel,
  gym,
  rental,
  restaurant,
  clinic,
  coworking,
  tours,
  tutoring,
  empty,
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

export type { Template };
