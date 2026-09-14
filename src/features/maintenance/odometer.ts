/**
 * Keeply — reading a sequence of odometer readings that may go backwards.
 *
 * Pure: no database, no clock. Extracted because getting it wrong is not a
 * crash — it is the app printing a confident number that is nonsense, which is
 * worse than printing nothing.
 *
 * ── AN ODOMETER GOING BACKWARDS IS A REAL EVENT ────────────────────────────
 * A replaced instrument cluster starts at zero. So does a swapped engine on
 * some bikes, and so does a correction: a user who typed `4710` for `47100`
 * and fixes it a month later leaves the same shape in the data.
 *
 * Refusing the reading at entry was the other option and it is wrong — it
 * makes the app refuse the truth about the car in front of the user. So the
 * reading is accepted and the ANALYTICS are made honest instead.
 *
 * ── WHAT "HONEST" MEANS HERE ───────────────────────────────────────────────
 * Measure the LATEST run only. Before this, `max(odometer) - min(odometer)`
 * spanned the reset: readings of 120,000 → 121,000 → 0 → 500 reported
 * 121,000 km travelled for a car that had done about 1,500, and the fuel walk
 * — which orders by odometer — had its whole sequence scrambled and printed
 * **1008.3 km/L** as fact.
 *
 * A reset therefore starts a new measurement period rather than permanently
 * poisoning the figures. The result says so, so the screen can state the window
 * rather than quietly narrowing it.
 *
 * ── SEGMENTED BY DATE, NOT BY ODOMETER ─────────────────────────────────────
 * Date order is the truth about SEQUENCE; the odometer is the truth about
 * DISTANCE within a run. A backdated receipt — found in a glovebox, entered
 * late — sits correctly in date order with an odometer between its neighbours,
 * so it produces no split. Only a genuine reset breaks monotonicity.
 *
 * Within a run the odometer is non-decreasing by construction, so ordering by
 * one or the other no longer differs.
 */

/** The minimum a row needs to take part. */
export interface OdometerReading {
  id: string;
  /** `'YYYY-MM-DD'`. */
  dateISO: string;
  odometer: number;
}

export interface OdometerRun<T> {
  /** The latest monotonic run, in date order. Possibly empty. */
  readings: readonly T[];
  /**
   * Whether readings before this run were dropped because the odometer went
   * back. The screen says so — a narrowed window presented as the whole
   * history is the same lie in a smaller font.
   */
  afterReset: boolean;
  /** Where the run starts, or `null` when there are no readings. */
  fromISO: string | null;
}

/**
 * The latest stretch over which the odometer only went forward.
 *
 * Ties are stable: equal dates fall back to `id`, so two fills recorded on one
 * day cannot reorder between calls and change which run is "latest".
 *
 * A SINGLE mistyped low reading has the same effect as a reset — the run
 * restarts at the typo and the earlier history is dropped. That is deliberate:
 * distinguishing "a dip that recovers" from "a reset" requires guessing which
 * of two readings is the wrong one, and guessing wrong produces exactly the
 * confident-nonsense this function exists to prevent. Correcting the reading
 * restores the history, because the run is recomputed from the rows every time.
 */
export function latestMonotonicRun<T extends OdometerReading>(
  readings: readonly T[],
): OdometerRun<T> {
  if (readings.length === 0) return { readings: [], afterReset: false, fromISO: null };

  const ordered = [...readings].sort((a, b) =>
    a.dateISO === b.dateISO ? a.id.localeCompare(b.id) : a.dateISO.localeCompare(b.dateISO),
  );

  let start = 0;
  let resets = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.odometer < ordered[index - 1]!.odometer) {
      start = index;
      resets += 1;
    }
  }

  const run = ordered.slice(start);
  return {
    readings: run,
    afterReset: resets > 0,
    fromISO: run[0]?.dateISO ?? null,
  };
}
