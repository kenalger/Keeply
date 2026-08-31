# Phase 1 Remediation

From the QA audit of the Phase 1 foundation. Ordered by cost-to-reverse, not by severity.

**The window matters.** Migration `0000` has never run on a device. Everything in Group A is an
afternoon's work now and a data migration across six feature modules later. Fix Group A before Phase 2.

---

## Group A — must land before migration 0000 ships

### A1. `db.transaction()` is not atomic
`drizzle-orm/op-sqlite/session.js:36-47` dispatches `begin` and `commit` without awaiting, so an async
callback body executes *after* COMMIT, and a throw inside it never reaches the synchronous `catch` —
no ROLLBACK either. Verified by reading the source.

Export a single sanctioned `withTransaction()` from `src/db`, built on op-sqlite's own
`db.transaction()` (`op-sqlite/src/functions.ts:186-258`), which does BEGIN → await → COMMIT → ROLLBACK
correctly behind a lock queue. Then make the broken one unreachable: narrow `getDb()`'s return type with
`Omit<…, 'transaction'>`.

`src/db/migrate.ts` already routes around this bug. The trap was left armed for feature code.

### A2. Every `UNIQUE INDEX` collides with soft delete
`drizzle/0000:283,298`. Soft-delete a reminder, then re-create the same
`(entity_type, entity_id, days_before)` → `UNIQUE constraint failed`. The tombstone is invisible in the
UI but still owns the slot, so a user cannot re-enable a reminder they turned off.

Partial unique indexes: `.where(sql\`deleted_at is null\`)`. Supported by the bundled SQLite 3.51.3.

### A3. Two sources of truth for vehicle money
`src/db/schema/vehicles.ts:153,208,257`. The file header says `vehicle_expenses` is the single ledger
where "every peso lands exactly once" — but the three detail tables each carry their own
`amount_minor`/`currency`, and `expense_id` is nullable, so nothing enforces the pairing. §13 totals and
cost-per-km will double-count or under-count depending on which query a developer writes. Silently.

Drop `amount_minor`/`currency` from the detail tables, or make `expense_id NOT NULL`.

### A4. Database location vs. key location
**Decision: keep user data out of device backups.**

The DB sits in `Paths.document` (backed up to iCloud); the key is `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
(not backed up). A restored phone therefore gets an undecryptable file and a recovery screen that
removes its own retry button after three attempts.

Move the DB to `Library/Application Support` with `NSURLIsExcludedFromBackupKey` (and the Android
equivalent). A restored phone opens a clean app instead of a bricked one. Portability is §20's
encrypted export, which the user controls — this is what "you control your backups" means.

Also: always offer a confirmed **"Erase local data and start over"** action on the key-unavailable
screen. Nobody should ever reach a screen with no way forward.

### A5. `deleted_at` is enforced nowhere
On all 12 tables, filtered by nothing, with no helper, view, or lint rule. `ON DELETE CASCADE` only
fires on *hard* delete, so soft-deleting a bill leaves its payments live and countable.

Create `*_live` SQL views in migration 0001 and point the read path at them, so forgetting the filter
becomes impossible rather than merely discouraged. Back it with an eslint rule forbidding
`.from(<table>)` outside `src/db`.

### A6. `bills.status` persists a derived value
A stored `overdue` needs a sweep on every launch, timezone change, and clock change — and goes stale
if the user doesn't open the app, while `statusForDue()` computes the truth independently. Two answers
to one question. Keep only `unpaid`/`paid` in the column and derive the rest:
`WHERE deleted_at IS NULL AND status = 'unpaid' AND due_date < :today`.

### A7. §29 validation is not enforceable as written
- `nonNegativeCheck` emits `>= 0`; §29 says `> 0`. A ₱0.00 bill is accepted.
- `isoDateCheck` is a GLOB *shape* test: `2026-02-30` and `2026-13-45` pass every CHECK.
  `CHECK (date(col) IS NOT NULL)` rejects them.
- `currencyCheck` is `length = 3`, so `'xyz'` passes.

### A8. Drop 12 unusable `deleted_at` indexes
`deleted_at` is NULL for essentially every row, so a standalone b-tree on it narrows nothing — pure
write amplification on all 12 tables. The *composite* indexes that put it in an equality position are
correct and the dashboard will use them; make those partial (`WHERE deleted_at IS NULL`) instead.

---

## Group B — before Phase 2 feature work

### B1. The Drizzle adapter has never executed
No `getDb()` call exists outside `src/db`. The first Drizzle query in this codebase's life will run on
a user's phone, and the documented failure mode is a silent `[]`. Add a `__DEV__`-only round-trip
self-check at the end of `initDatabase()` — insert → select → delete — that throws on a wrong shape.
Cheapest insurance in the audit.

*(Correction to an earlier claim: op-sqlite 18.1.4 **does** ship `executeAsync`/`executeRawAsync`
— `functions.ts:140,143`, re-added upstream for Drizzle. They're absent from the shipped `.d.ts`, which
is what caused the confusion. Only the synchronous `execute().rows._array` path needed bridging.)*

### B2. op-sqlite throws at module scope
`functions.ts:20-38` throws during module evaluation when the native module is absent. The import chain
`_layout.tsx → @/db → client.ts` means the root layout fails to evaluate, so `assertSQLCipher()`'s
helpful message never runs and `AppErrorBoundary` — defined inside the failed module — cannot catch it.
Use `await import()` inside `openDatabase()`, and import error classes from `src/db/errors.ts` directly.

### B3. A wrong key surfaces as a generic error with an unwinnable retry
SQLCipher doesn't verify the key at `open()` — the first *read* does, which here is
`PRAGMA journal_mode = WAL`. It throws SQLITE_NOTADB → "could not start… try again", and Try again can
never succeed. Probe with `SELECT count(*) FROM sqlite_master` right after open and map the failure to
`DatabaseKeyUnavailableError`.

### B4. Two divergent calendar-date implementations
`src/db/time.ts` and `src/theme/format.ts` are both barrel-exported, so feature authors will use
whichever they import first. They disagree: `fromISODate('bogus')` yields `"NaN-NaN-NaN"` written
straight at a CHECK-constrained column, while `toLocalDate('bogus')` returns `null`; `'0099-01-01'`
silently becomes 1999 in one and is rejected by the other. Delete `time.ts`'s date functions and
re-export `format.ts`'s. One implementation of the invariant this project calls its highest risk.

### B5. The logger leaks amounts in release builds
`{ billMinor: 154900 }` matches no key rule (`amount|price|total|cost|balance|subtotal`) and is under
the 1,000,000 numeric threshold, so it prints verbatim — and `log.error` is not a no-op in production.
Same for `{ due: 3450 }`, `{ monthly: 149900 }`, `{ name: subscription.name }`, and relative media
paths like `receipts/img_1.jpg`.

Invert to an allowlist: only `SAFE_KEYS` pass a value through; everything else gets a placeholder.
Also guard `src/db/log.ts`, which has no production check at all.

### B6. No virtualized list primitive
`src/components/ui/` ships `Screen` (a ScrollView) and nothing else, and the dashboard already
`.map()`s six unbounded arrays inside it. Every Phase 2–6 author will copy that pattern because it is
the only one on offer. Add `<List/>` (FlatList + themed separator/empty/skeleton) before Phase 2, and
cap dashboard sections in SQL rather than JS.

### B7. The 100x money error is unguarded
`<Amount/>` takes a bare `number` under two interchangeable names (`value`, `minor`), both optional.
`<Amount value={1499} />` meaning ₱1,499 renders **₱14.99**, silently, forever. Thread a branded
`MinorUnits` type from the schema through `DashboardData` to `AmountProps`, and drop the alias.

---

## Group C — polish

- **No lint config exists.** `no-console`, the `db.transaction` ban, the `new Date(<string>)` ban and the
  `deleted_at` rule are all prose in comments. Highest leverage per unit of effort in the whole audit.
- `Row` sets `accessible` on the container with only `title` as the label, so VoiceOver reads
  "Netflix, button" — no amount, no due date. Compose the label from title + subtitle + `<Amount/>`'s
  own spoken label.
- Both buttons on `fallback-screen.tsx` are under the theme's own `MIN_TOUCH_TARGET = 44`, on the one
  screen a user reaches when something is already broken.
- `currentMonth()` is evaluated once at module scope, so an app resident across a month boundary shows
  the previous month.
- `RecentActivityItem.occurredAt` is typed as an ISO string while the schema stores epoch millis — a
  conversion boundary that invites the exact `new Date(iso)` bug the project forbids.
- Delete `hasDatabaseKey()` — unused, swallows a throw and returns `false`, which is precisely the shape
  that would justify regenerating a key.
- **There are no tests of any kind in the repository.** No runner, no `__tests__`, no `*.test.*`. The
  claimed 10-timezone verification of `format.ts` is not represented by anything committed.

---

## Verified clean

Offline invariant (grepped `fetch`, `XMLHttpRequest`, `WebSocket`, `NetInfo`, `axios`, every
`http(s)://` literal — nothing outside the logger's own scrubbing regexes). Key lifecycle: never
regenerates, and the key is stored *before* `open()`, so a crash between them is safe. Boot state
machine: the legal-transition table genuinely prevents both a late `succeed()` resurrecting a failed
boot and a React 19 StrictMode double-mount launching two migration runs. No `new Date()` on a calendar
string anywhere. Theme system: no raw hex outside `tokens.ts`, stable object identity, per-variant
font-scale clamps. `assertSQLCipher()` cannot be bypassed — it is the first statement in the only
caller of op-sqlite's `open()`.
