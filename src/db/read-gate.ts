/**
 * Keeply — the read connection's lifecycle, as a state machine with no I/O.
 *
 * `client.ts` owns a second SQLCipher connection that every read outside a
 * transaction goes through (see "THE READ CONNECTION" there). Opening it is
 * asynchronous — the key comes out of the Keychain, and the first page read is
 * where SQLCipher derives it — and closing it happens on three paths that each
 * delete or replace the file underneath: `closeDatabase()`, the erase, and the
 * restore swap. The failure this module exists to make impossible is the
 * interleaving:
 *
 *     openReadConnection()   awaits the key…
 *     closeDatabase()        …restore closes everything and moves files…
 *     openReadConnection()   …the key arrives, the handle opens: on a file
 *                            that is about to be replaced, and it is adopted
 *                            as the live reader.
 *
 * So an open is a TICKET. `detach()` — every close — voids the ticket in
 * flight, and `adopt()` with a voided ticket answers `false`: the caller closes
 * the handle it just opened instead of installing it. A reopen after a restore
 * takes a new ticket, and a failure report from the old one cannot close it.
 *
 * `current()` is synchronous on purpose. A read takes the handle and calls into
 * it in the same tick, so nothing can close it in between; the native layer
 * then guarantees an in-flight query is interrupted and drained before the
 * handle is freed (`cpp/OPDatabase.cpp`, `close`).
 *
 * Also here: the one rule about WHAT may be run as a read, because it is pure
 * and a test can hold every statement the app builds to it.
 */

export type ReadGateState = 'closed' | 'opening' | 'open';

export interface ReadGate<Handle> {
  readonly state: () => ReadGateState;
  /**
   * Start opening. `null` when a connection is already open or opening — the
   * caller opens nothing, because two readers is one leaked handle.
   */
  readonly beginOpen: () => symbol | null;
  /**
   * Install the handle opened for `ticket`. `false` when the gate was closed
   * while it opened: the caller must close `handle` itself, not use it.
   */
  readonly adopt: (ticket: symbol, handle: Handle) => boolean;
  /**
   * The open for `ticket` failed. `true` if it was still the open in progress
   * — `false` means a close already superseded it, and nothing changes.
   */
  readonly abandon: (ticket: symbol) => boolean;
  /** The open handle, or `null`. */
  readonly current: () => Handle | null;
  /** Take the handle out to close it, and void any open in progress. */
  readonly detach: () => Handle | null;
}

export function createReadGate<Handle>(): ReadGate<Handle> {
  let handle: Handle | null = null;
  let opening: symbol | null = null;

  return {
    state: () => (handle !== null ? 'open' : opening !== null ? 'opening' : 'closed'),

    beginOpen() {
      if (handle !== null || opening !== null) return null;
      opening = Symbol('read-connection-open');
      return opening;
    },

    adopt(ticket, opened) {
      if (ticket !== opening) return false;
      opening = null;
      handle = opened;
      return true;
    },

    abandon(ticket) {
      if (ticket !== opening) return false;
      opening = null;
      return true;
    },

    current: () => handle,

    detach() {
      const detached = handle;
      handle = null;
      opening = null;
      return detached;
    },
  };
}

/**
 * Why `sql` may not run as a read, or `null` when it may.
 *
 *  - SELECT (or WITH) only. The read connection is opened read-only, so a
 *    write would fail anyway; the rule is for what would NOT fail — a `BEGIN`
 *    that opened a read transaction and never ended it would pin the
 *    connection to one snapshot, and every later read would see a database
 *    that stopped changing.
 *  - One statement. op-sqlite runs EVERY statement in the string it is handed,
 *    not just the first (`opsqlite_execute` loops on the prepare tail), so
 *    `SELECT 1; BEGIN` would do exactly the above.
 *  - As many parameters as placeholders — the check `bindStatement()` makes on
 *    every statement the features build, repeated here because reads no
 *    longer pass through it. One missing parameter binds as NULL, and a
 *    filter comparing against NULL silently matches nothing.
 */
export function readStatementProblem(sql: string, parameterCount: number): string | null {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
    return 'Only a SELECT can run on the read connection';
  }
  if (/;\s*\S/.test(sql)) {
    return 'The read connection runs one statement at a time';
  }
  const placeholders = sql.split('?').length - 1;
  if (placeholders !== parameterCount) {
    return `Statement has ${placeholders} placeholders but ${parameterCount} parameters`;
  }
  return null;
}
