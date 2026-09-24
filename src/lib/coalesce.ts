/**
 * Keeply — at most one run in flight, and at most one waiting behind it.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 * Some work is idempotent and expensive and asked for in bursts. Rebuilding
 * the OS reminder queue is the case that made this file: four gather queries,
 * a cancel of everything queued, then up to sixty sequential native calls —
 * requested at boot, on every foreground, after every document write and after
 * every reminder-settings toggle. Tap five lead-time chips and five complete
 * rebuilds queue up, each one's answer overwritten by the next.
 *
 * The answer the LAST request wants is the only one that matters, and a rebuild
 * that STARTS after a request is the only one guaranteed to see it. So:
 *
 *  - Idle: a request starts a run at once.
 *  - Busy: a request schedules ONE trailing run, to start when the current one
 *    finishes. Every further request before that start joins the same
 *    trailing run — the intermediate ones collapse — and the trailing run is
 *    given the NEWEST request's arguments.
 *  - A request is never answered by a run that started before it. A run in
 *    flight may have read the settings a moment before the user changed them;
 *    handing its result to the caller who made that change would report a
 *    rebuild that does not reflect it.
 *
 * Five taps during one rebuild therefore cost two rebuilds, not five, and the
 * second one is the one that is right.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 * Not a debounce: nothing waits on a timer, and an idle request starts
 * immediately. Not a queue: requests that collapse are not replayed, because
 * for idempotent work "run it again" and "run it once more, later" are the
 * same thing.
 *
 * A rejection reaches the callers of the run that rejected, and nobody else;
 * the trailing run still starts. `syncAllReminders()` never rejects anyway, but
 * a helper that let one failure poison the next request would be a trap.
 *
 * Pure: no imports. `tests/coalesce.test.ts` drives it with fake timers.
 */

/**
 * Wrap `task` so overlapping calls coalesce as described above.
 *
 * The wrapper has the task's own signature, so callers do not change. Each
 * call's promise settles with the result of the run that served it: the run
 * it started, or the trailing run it joined.
 */
export function coalesce<Args extends unknown[], Result>(
  task: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  let running = false;
  let trailing: {
    args: Args;
    readonly promise: Promise<Result>;
    readonly resolve: (value: Result) => void;
    readonly reject: (reason: unknown) => void;
  } | null = null;

  function start(args: Args): Promise<Result> {
    running = true;
    // `async` so a task that throws synchronously still becomes a rejection,
    // and still hands over to the trailing run below.
    const run = (async () => task(...args))();
    const handOver = () => {
      running = false;
      const next = trailing;
      if (next === null) return;
      trailing = null;
      start(next.args).then(next.resolve, next.reject);
    };
    run.then(handOver, handOver);
    return run;
  }

  return (...args: Args): Promise<Result> => {
    if (!running) return start(args);
    if (trailing === null) {
      let resolve!: (value: Result) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<Result>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      trailing = { args, promise, resolve, reject };
    } else {
      // The newest request's arguments win: it is the one the caller is
      // waiting to see take effect.
      trailing.args = args;
    }
    return trailing.promise;
  };
}
