/**
 * The synthetic day the hero grid draws.
 *
 * Synthetic and labelled as such: no customer of Bookrail exists yet, so nothing here is real
 * data and the page says so. What is real is the shape, seven resources on a twelve hour band,
 * three kinds of occupancy and one refusal, and the counts under the frame, which are computed
 * from this array and cannot drift from what the reader sees.
 */

export type SlotKind = 'booking' | 'hold' | 'block';

export interface GridSlot {
  /** Percentage of the lane at which the rectangle starts, 0 is 08:00 and 100 is 20:00. */
  left: number;
  width: number;
  label: string;
  kind: SlotKind;
}

export interface GridRow {
  name: string;
  slots: GridSlot[];
  /** The one request the grid refuses, drawn as an outline where the capacity already went. */
  rejected?: { left: number; width: number; label: string };
}

const H = 100 / 12; // one hour of the twelve hour band

export const GRID_DATE = 'Tue 8 Sep';
export const GRID_HOURS = ['08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19'];

export const GRID_ROWS: GridRow[] = [
  {
    name: 'Court 1',
    slots: [
      { left: 0, width: 2 * H, label: 'bk_… 2h', kind: 'booking' },
      { left: 3 * H, width: H, label: 'bk_…', kind: 'booking' },
      { left: 6 * H, width: 2 * H, label: 'bk_… 2h', kind: 'booking' },
    ],
    rejected: { left: 8 * H, width: 4 * H, label: '409 slot_unavailable' },
  },
  {
    name: 'Court 2',
    slots: [
      { left: H, width: H, label: 'bk_…', kind: 'booking' },
      { left: 4 * H, width: 3 * H, label: 'hold · 9:41', kind: 'hold' },
      { left: 8 * H, width: 3 * H, label: 'bk_… 3h', kind: 'booking' },
    ],
  },
  {
    name: 'Court 3',
    slots: [
      { left: 0, width: 4 * H, label: 'blocked', kind: 'block' },
      { left: 5 * H, width: H, label: 'bk_…', kind: 'booking' },
      { left: 9 * H, width: 2 * H, label: 'bk_… 2h', kind: 'booking' },
    ],
  },
  {
    name: 'Coach Ada',
    slots: [
      { left: 2 * H, width: H, label: 'bk_…', kind: 'booking' },
      { left: 3 * H, width: H, label: 'bk_…', kind: 'booking' },
      { left: 7 * H, width: 3 * H, label: 'bk_… 2 seats', kind: 'booking' },
    ],
  },
  {
    name: 'Room A',
    slots: [
      { left: H, width: 3 * H, label: 'bk_… 6 of 8', kind: 'booking' },
      { left: 6 * H, width: 3 * H, label: 'hold · 10:00', kind: 'hold' },
    ],
  },
  {
    name: 'Room B',
    slots: [
      { left: 0, width: H, label: 'bk_…', kind: 'booking' },
      { left: 4 * H, width: 2 * H, label: 'bk_… 2h', kind: 'booking' },
      { left: 10 * H, width: 2 * H, label: 'bk_…', kind: 'booking' },
    ],
  },
  {
    name: 'Van 12',
    slots: [
      { left: 2 * H, width: 5 * H, label: 'bk_… rental 5h', kind: 'booking' },
      { left: 8 * H, width: H, label: 'bk_…', kind: 'booking' },
    ],
  },
];

/** Counted, never typed: the caption under the grid can only say what the grid draws. */
export function gridCounts(rows: GridRow[] = GRID_ROWS) {
  const all = rows.flatMap((row) => row.slots);
  return {
    bookings: all.filter((slot) => slot.kind === 'booking').length,
    holds: all.filter((slot) => slot.kind === 'hold').length,
    blocks: all.filter((slot) => slot.kind === 'block').length,
    rejected: rows.filter((row) => row.rejected !== undefined).length,
  };
}
