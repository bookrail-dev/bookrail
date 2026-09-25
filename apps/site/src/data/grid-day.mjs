/**
 * The synthetic day of the homepage, in hours: one source for the picture and for the engine.
 *
 * `src/data/grid.ts` draws it as the resource grid of the hero, and `scripts/generate.mjs` hands
 * the three courts of it to the availability engine at build time, so the `explain` rows the page
 * prints are what the engine answers about the day the reader is looking at. Neither side keeps
 * a copy.
 *
 * Synthetic and labelled as such: no customer of Bookrail exists yet. The identifiers are
 * well formed UUIDs made from a counter, so the API's own serializer can turn them into the
 * prefixed identifiers it prints (`res_…`, `bk_…`), and nothing in them is somebody's data.
 *
 * Plain JavaScript with JSDoc rather than TypeScript, because the build script that feeds the
 * engine runs on Node without a compiler.
 */

/** @typedef {'booking' | 'hold' | 'block'} SlotKind */

/**
 * @typedef {object} DaySlot
 * @property {number} from Hours after the opening of the band, 0 is 08:00.
 * @property {number} hours
 * @property {string} label
 * @property {SlotKind} kind
 * @property {string} id UUID of the booking, hold or block the rectangle is.
 */

/**
 * @typedef {object} DayResource
 * @property {string} id UUID of the resource.
 * @property {string} name
 * @property {boolean} court Whether the resource is one of the courts the engine is asked about.
 * @property {DaySlot[]} slots
 * @property {{ from: number, hours: number, label: string } | undefined} [rejected] The one
 *   request the grid refuses, drawn as an outline over the capacity it asked for. It must overlap
 *   an occupancy of the same resource: the engine is asked, at test time, and has to refuse it.
 */

/** `0198f0c2-a1b4-7e2e-9a1c-<n>`: a version 7, variant 1 UUID, and obviously a counter. */
export function syntheticUuid(n) {
  return `0198f0c2-a1b4-7e2e-9a1c-${n.toString(16).padStart(12, '0')}`;
}

let next = 0;
const id = () => syntheticUuid(++next);

/** The day, the zone it is sold in, and the band the grid draws. */
export const GRID_DAY = {
  date: '2026-09-08',
  label: 'Tue 8 Sep',
  timezone: 'Europe/Rome',
  open: '08:00',
  close: '20:00',
  hours: 12,
};

/** @type {DayResource[]} */
export const GRID_RESOURCES = [
  {
    id: id(),
    name: 'Court 1',
    court: true,
    slots: [
      { from: 0, hours: 2, label: 'bk_… 2h', kind: 'booking', id: id() },
      { from: 3, hours: 1, label: 'bk_…', kind: 'booking', id: id() },
      { from: 6, hours: 2, label: 'bk_… 2h', kind: 'booking', id: id() },
    ],
    // 15:00 to 19:00 on Court 1, which the booking of 14:00 to 16:00 already holds until 16:00.
    // `test/home.test.ts` asks the engine and fails if it would accept this request.
    rejected: { from: 7, hours: 4, label: '409 slot_unavailable' },
  },
  {
    id: id(),
    name: 'Court 2',
    court: true,
    slots: [
      { from: 1, hours: 1, label: 'bk_…', kind: 'booking', id: id() },
      { from: 4, hours: 3, label: 'hold · 9:41', kind: 'hold', id: id() },
      { from: 8, hours: 3, label: 'bk_… 3h', kind: 'booking', id: id() },
    ],
  },
  {
    id: id(),
    name: 'Court 3',
    court: true,
    slots: [
      { from: 0, hours: 4, label: 'blocked', kind: 'block', id: id() },
      { from: 5, hours: 1, label: 'bk_…', kind: 'booking', id: id() },
      { from: 9, hours: 2, label: 'bk_… 2h', kind: 'booking', id: id() },
    ],
  },
  {
    id: id(),
    name: 'Coach Ada',
    court: false,
    slots: [
      { from: 2, hours: 1, label: 'bk_…', kind: 'booking', id: id() },
      { from: 3, hours: 1, label: 'bk_…', kind: 'booking', id: id() },
      { from: 7, hours: 3, label: 'bk_… 2 seats', kind: 'booking', id: id() },
    ],
  },
  {
    id: id(),
    name: 'Room A',
    court: false,
    slots: [
      { from: 1, hours: 3, label: 'bk_… 6 of 8', kind: 'booking', id: id() },
      { from: 6, hours: 3, label: 'hold · 10:00', kind: 'hold', id: id() },
    ],
  },
  {
    id: id(),
    name: 'Room B',
    court: false,
    slots: [
      { from: 0, hours: 1, label: 'bk_…', kind: 'booking', id: id() },
      { from: 4, hours: 2, label: 'bk_… 2h', kind: 'booking', id: id() },
      { from: 10, hours: 2, label: 'bk_…', kind: 'booking', id: id() },
    ],
  },
  {
    id: id(),
    name: 'Van 12',
    court: false,
    slots: [
      { from: 2, hours: 5, label: 'bk_… rental 5h', kind: 'booking', id: id() },
      { from: 8, hours: 1, label: 'bk_…', kind: 'booking', id: id() },
    ],
  },
];

/**
 * The question the engine is asked about the day: a match of 60 minutes on any of the three
 * courts, on a half hour grid, over the whole band. It is what a padel club sells, and the
 * answer names, for every instant it refuses, the booking, the hold or the block on each court.
 */
export const EXPLAIN_QUESTION = {
  serviceId: syntheticUuid(0xa1),
  groupId: syntheticUuid(0xa2),
  requirementId: syntheticUuid(0xa3),
  serviceName: 'Match',
  durationMinutes: 60,
  slotIntervalMinutes: 30,
  /** The instant the question is asked: 07:00 in Rome, an hour before the courts open. */
  now: '2026-09-08T05:00:00Z',
};
