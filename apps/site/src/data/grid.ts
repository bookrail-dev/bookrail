/**
 * The synthetic day the hero grid draws.
 *
 * Synthetic and labelled as such: no customer of Bookrail exists yet, so nothing here is real
 * data and the page says so. What is real is the shape, seven resources on a twelve hour band,
 * three kinds of occupancy and one refusal, and the counts under the frame, which are computed
 * from this array and cannot drift from what the reader sees.
 *
 * The day itself is `grid-day.mjs`, in hours, because the build script hands the same day to the
 * availability engine and prints what it answers. This file only turns hours into the
 * percentages of the lane.
 */
import { GRID_DAY, GRID_RESOURCES } from './grid-day.mjs';

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

const H = 100 / GRID_DAY.hours; // one hour of the band

export const GRID_DATE = GRID_DAY.label;

/** `08` to `19`: the label of every hour the band starts. */
export const GRID_HOURS = Array.from({ length: GRID_DAY.hours }, (_, index) =>
  String(Number(GRID_DAY.open.slice(0, 2)) + index).padStart(2, '0'),
);

export const GRID_ROWS: GridRow[] = GRID_RESOURCES.map((resource) => ({
  name: resource.name,
  slots: resource.slots.map((slot) => ({
    left: slot.from * H,
    width: slot.hours * H,
    label: slot.label,
    kind: slot.kind,
  })),
  ...(resource.rejected === undefined
    ? {}
    : {
        rejected: {
          left: resource.rejected.from * H,
          width: resource.rejected.hours * H,
          label: resource.rejected.label,
        },
      }),
}));

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
