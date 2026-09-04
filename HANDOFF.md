# Keeply — Handoff

**State at `a87182c`.** `tsc --noEmit` 0 · `eslint .` 0 errors · `npm test` **960/960**.
Runs on the iOS Simulator.

> **Six commits are UNPUSHED** (`edda5d1..a87182c`). `git log origin/main..HEAD` to see them.
> Nothing is half-finished — each one is green on its own — but `origin/main` is six behind.

This session: restore (Phase 8c), the Bills screens (Phase 3c), the reminders rework, and a
design pass that reached the whole app.

| Phase | State |
| --- | --- |
| 1–4 Foundation · Subscriptions · Bills · Receipts | Complete **and rendered**, Bills included. |
| Onboarding | Complete |
| 9 Expenses & Allowance | **Complete** |
| 8 Backup | **Complete.** Export and restore, both verified on the device. |
| 5 Maintenance *(was Vehicles)* | Schema, item data layer and screens done. **Costs, services and renewals have tables but no API.** |
| 6 Documents · 7 Security | Not started |

Read `CLAUDE.md` for conventions before touching anything. `plan/goal.md` is the product spec.

---

## What works today

A private, offline-first iOS app you can actually use:

- **Encrypted vault.** SQLCipher via op-sqlite. Verified empirically — the on-disk header is random bytes,
  not `SQLite format 3`, and `sqlite3` refuses to open it. Key lives in the Keychain, device-only.
- **Excluded from iCloud backup** by a config plugin, verified by `xattr`
  (`com.apple.metadata:com_apple_backup_excludeItem`). A restored phone opens a *clean* app rather than a
  bricked one; portability is §20's encrypted export, **which now round-trips**.
- **Offline cold boot** with Wi-Fi off, verified: boots to Home in ~300ms.
- **Expenses & allowance (Phase 9).** Set an allowance daily / weekly / monthly; the card on Home, the
  Money tab and `/allowance` all read one `AllowanceStatus`, so they cannot disagree. Only day-to-day
  expenses draw it down — bills and subscriptions are committed money and are never subtracted. The
  allowance is a **history** table resolved by `effective_from`, so raising it in October cannot restate
  September. Receipts is now "Expenses" (routes `src/app/expenses`, table still `receipts`), the list is
  grouped by day with per-day totals, and the form opens on the amount.
- **Maintenance (Phase 5).** Anything that needs looking after — vehicles, appliances, home,
  electronics. One `maintenance_items` table with a `kind`; the form CHANGES SHAPE with it, so an
  aircon never sees an odometer field. Add / list / detail / edit / delete all work and survive a cold
  boot. What you cannot yet record is the maintenance itself — see Known gaps.
- **Encrypted backup, both directions (Phase 8).** A backup IS a SQLCipher database, written by
  `sqlcipher_export()` and keyed with a passphrase, then handed to the share sheet and deleted from the
  cache. **Restore is the same thing backwards**: open the bundle under its passphrase, export it into a
  staging file keyed to THIS device, swap it in, reopen, run migrations, and only then delete what was
  there before. Verified end to end — a marker record added after the backup was gone afterwards, a
  wrong passphrase and a tampered "newer" bundle were both refused, and a restore interrupted between
  the two renames was repaired on the next launch with every record intact. `plan/phase8-backup.md`
  §9–§10.
- **Editable reminders, one kind at a time, with a real preview.** `/reminders` is an overview
  stating all four answers; `/reminders/bills` (and `/subscriptions`, `/documents`) each edit
  exactly one kind. Each of those screens is three things in the order the question is asked: the
  answer as a quantity ("3 reminders before a bill is due, each at 9:00 AM"), the chips, and then
  **the proof** — the user's real next bill with the actual dates the notifications will land on,
  drawn on a rail that ends at the due date. The preview rows come from `planRemindersFor()`, the
  same function `rescheduleAll()` runs, so a preview cannot promise a reminder the queue does not
  hold. More's four reminder rows deep-link straight to their own kind.
- **Subscriptions** — CRUD, anchored recurrence, SQL-side normalized totals, list/detail/form screens.
- **Bills** — CRUD, payment history, derived overdue, ledger-anchored roll-forward, **and screens**:
  list with §23 filters, add/edit, and a detail screen that settles a period. The amount is
  OPTIONAL end to end (§7's variable bill), so every screen renders an em dash rather than ₱0.00 and
  the totals say how many bills they left out. Marking paid writes the ledger row, rolls the due
  date forward and says so in words; undo rewinds both. `plan/phase3-bills-ui.md`.
- **Local notifications** — six-state permission model, 60-slot rolling window, rebuilt on boot,
  foreground, and any reminder-affecting settings change.
- **First-run wizard** — 6 steps, resumable, 56-entry Philippine catalogue, all importable.
- **Design system** — greyscale plus ONE accent, full form layer, `ThemeLayout` spacing rules, and
  contrast that is now actually measured (`tests/theme-contrast.test.ts`) rather than claimed.

224 screenshots in `plan/screenshots/`, numbered by pass (`13-` monochrome, `14-` subscriptions,
`16-` wizard, `17-` layout pass, `18-` the Phase 4 render, `19-` Phase 9, `20-` Phase 8,
`21-` filters/sort, `22-` the underline control, `23-24-` reminders, `25-26-` Maintenance,
`27-` restore, `28-31-` Bills, `32-38-` reminders, `39-41-` the accent).

**They are NOT in git** — 54MB, deliberately untracked, as in every previous session.

---

## Start here

**1. Restore the specialist agents.** `.claude/agents/` holds five mobile specialists
(`expo-native-engineer`, `mobile-data-engineer`, `mobile-ui-engineer`, `mobile-feature-engineer`,
`mobile-qa-engineer`), each with web research enabled. **They only register at session start** — a
session that began before they existed cannot call them. Start a fresh session and they are available
by name.

**2. Build maintenance records (Phase 5c). The biggest hole in the product.** The tab is called
Maintenance and you cannot record any maintenance. Items exist; the thing you attach to them does
not. `maintenance_costs`, `maintenance_services` and `maintenance_renewals` have tables, views and
migration-level tests, but no API and no screens — so the detail screen honestly says "Nothing
recorded against it yet" rather than stubbing a section. This is what turns a list of possessions
into a history, and it is the last domain where finished schema is unreachable.

Note it drags **step 5e** with it: `notification_settings.entity_type` still names the old vehicle
tables, and fixing that needs the drizzle-kit view-drop dance in Known gaps.

**3. Then Documents (Phase 6), the last unbuilt record kind.** Everything around it already exists
and points at it — the tab, the reminder settings screen, `documentReminderLeadTimes`, the expiry
status tokens. It is the only kind whose reminder preview says "arrives in a later update".

**4. Small, high-value, any time.** Each is an hour or two and each closes something that currently
reads as broken: a ledger row on the bill detail screen is not tappable (`saveBillPaymentEdit()` is
wired and exported); bills are absent from Home (`useUpcomingBills()` exists for exactly that); and
`useAsyncRead` is now copied into five features and wants extracting across all five at once.

**Still unverified on a device:** camera capture and the permission-denied paths. The simulator has no
camera, so the viewfinder is a blank rectangle, and permission was already granted here. Those need a
real device or `xcrun simctl keychain <udid> reset`. Also **the two taps inside the file picker** —
`File.pickFileAsync` presents correctly and everything behind it is verified, but the Files sheet
cannot be tapped from here (Simulator reports zero windows), so choosing a file by hand is untested.

---

## Hard-won environment knowledge

**Do not re-derive these. Each one cost an agent run.**

- **Brief size stalls agents.** Three consecutive receipts agents stalled at exactly the same point,
  immediately after "I'll start by reading" — the brief said to read `src/features/bills/**` *in full*,
  which is **3,614 lines** before writing anything. Point agents at specific files and sections instead.
  `store.ts` (56 lines) and `index.ts` (186) are the pattern-defining ones.
- **CDP works on `127.0.0.1:8081` only**, never `localhost`. Metro's proxy compares the `Origin` header
  against its own `serverBaseUrl.origin`, so host *and* `Origin` must both be `127.0.0.1:8081`. The `ws`
  package is installed. It is the only way to drive the app here — see "Driving the simulator without
  taps" under Commands, which has the whole recipe worked out.
- **Avoid `simctl openurl`.** iOS 26 raises an "Open in Keeply?" confirmation owned by SpringBoard, not the
  app. Terminating the app does not dismiss it and it reappears over whatever resumes. It has permanently
  stuck three agents; clearing it needs `xcrun simctl shutdown` / `boot`.
- **Deleting the app does not clear the Keychain.** Use `xcrun simctl keychain <udid> reset` to exercise a
  genuine first launch, or the "new install" you are testing silently reuses the old key.
- **Never cut the network to test offline mode from inside an agent** — one killed its own API connection
  doing exactly that. Wrap it in a single shell command with a watchdog:
  `( sleep 90; networksetup -setairportpower en0 on ) & trap 'networksetup -setairportpower en0 on' EXIT`.
- **`npx expo run:ios` is almost never needed.** JS-only changes reload through Metro. A rebuild costs
  10+ minutes and pulls the simulator out from under any other agent using it.
- **Only one agent can drive the simulator at a time.** Parallelise by file ownership, and give at most one
  agent the device.

## Library facts verified against installed source

- **op-sqlite 18 ships no Expo config plugin.** SQLCipher is a compile-time flag read from the app's own
  `package.json` (`"op-sqlite": { "sqlcipher": true }` — see `op-sqlite.podspec:54`). A plain build
  *accepts* an `encryptionKey` and silently ignores it, which is why `assertSQLCipher()` exists.
- **Drizzle's `db.transaction()` is not atomic here.** It dispatches `begin`/`commit` without awaiting, so
  an async body runs *after* COMMIT and a throw never triggers ROLLBACK. `KeeplyDatabase` is
  `Omit<…, 'transaction'>` so it will not compile; use `withTransaction()` from `@/db`.
- **`flexBasis: 'auto'` does not override `flex: 1` in Yoga.** `Node::processFlexBasis` treats `auto` the
  same as unset and falls through to the `flex > 0` branch, returning `points(0)`. Only overriding `flex`
  itself works — hence `<List fill={false}/>`.
- **`expo-notifications` reports `.provisional` and `.ephemeral` as `undetermined`.** Reading the top-level
  status alone re-prompts a user whose reminders already arrive, and on iOS that prompt fires once ever.
- **op-sqlite echoes BOUND PARAMETERS into its error messages** (`Failed query: … params: …`). For most
  statements that is merely a privacy smell; for `ATTACH DATABASE ? … KEY ?` the second parameter is the
  user's backup passphrase. `exportEncryptedCopy()` therefore throws WITHOUT a `cause` — deliberately,
  with the reason at the throw site. Never re-attach a driver error there.
- **`sqlcipher_export()` IS available in this build** and produces a genuinely encrypted file (random
  header, `sqlite3` refuses it, no merchant name in `strings`). Verified on device; see
  `plan/phase8-backup.md` §7.
- **`node:sqlite` binds every JS number as REAL.** Production is safe only because the columns have
  INTEGER affinity and no query does arithmetic on a bound parameter.
- **drizzle-kit needs a TTY** when a diff contains both drops and creates — it asks whether each
  pair is a rename. Split the change into two generates (drops, then creates) instead.
- **drizzle-kit's SQLite table rebuild does NOT drop dependent views.** Any change to a CHECK
  constraint rebuilds the table (SQLite cannot ALTER one) and the following `ALTER TABLE … RENAME`
  then fails with `error in view <table>_live: no such table`. Every table here has a `*_live` view,
  so this applies to all of them. Drop and recreate the view around the rebuild by hand when it
  comes up — see `plan/phase5-maintenance.md` §9.
- **expo-file-system 57 HAS a file picker.** `File.pickFileAsync({ mimeTypes: '*/*' })` — static, on
  `File`. No `expo-document-picker`, no new dependency, no `prebuild`. It presents the iOS Files sheet
  and hands back a temporary COPY of the chosen file, which is what a restore wants: the user's own
  file is never opened or locked. Filter by MIME type and `.keeply` greys out — iOS has no UTI for it.
- **`sqlcipher_export()` takes the target as its ONE argument and copies from that connection's
  `main`.** So the reverse of the export is not a two-argument call: open the BUNDLE as its own
  connection, ATTACH the destination to *it*, and export. Verified on device.
- **Open a bundle with `open({ encryptionKey })`, never `ATTACH … KEY ?`.** Same passphrase leak as
  §8 of the phase plan — op-sqlite echoes bound parameters into error messages, and `ATTACH` binds the
  passphrase. `open()` takes it as an options field, so it is not reachable through an error at all.
- **SQLite `date()` normalises rather than rejects**: `date('2026-02-30')` is `'2026-03-02'`. The CHECK that
  actually works is `col IS NULL OR date(col) IS col`.

---

## Conventions that are load-bearing

Every one of these exists because of a specific bug. `CLAUDE.md` has the full list.

- **Money is integer minor units** in `*_minor` columns. `MinorUnits` is branded, so
  `<Amount value={1499}/>` meaning ₱1,499 is a compile error rather than a silent ₱14.99.
- **Calendar dates are `YYYY-MM-DD` text**, parsed as *local* dates. `new Date('2026-10-12')` is UTC
  midnight and lands on the wrong day in PH time. A type-aware lint rule rejects it.
- **Reads go through `*_live` views**, never base tables — `ON DELETE CASCADE` does not fire for a soft
  delete. Base tables are the write path only.
- **A list skips an unreadable row and reports `damagedCount`; a single-record read still throws; and
  delete never maps the row**, so a damaged record is always removable.
- **Recurrence is anchored**: every occurrence is `anchor + k cycles` from the original anchor, and a
  computed date is never fed back in. That is what stops Jan-31 monthly drifting to the 28th forever.
- **A block owns the gap above itself, never below.** RN does not collapse margins; a bottom margin plus
  the next block's top padding produced 40pt of dead space under every header.
- **Never log** a file path, URI, document/plate/policy number, amount, record name, or whole row.
  `src/lib/log.ts` is an allowlist — only `SAFE_KEYS` pass a value through.
- **Every new test must be mutation-verified.** Break the behaviour, confirm the test goes red, restore.
  Four tests in this repo passed against deliberately broken code before this was enforced.
- **Settings writes are QUEUED, not fire-and-forget.** `update()` and `toggleReminderLeadTime()` still
  return immediately (§25 — a preference must not make the UI wait), but `enqueuePersist()` chains them
  so two taps a frame apart cannot land out of order. Removing the queue silently loses settings; see
  Recently closed.
- **Day grouping only applies in date order.** `groupByDay()` collects CONSECUTIVE runs, so sorted by
  amount the same date appears in several places, each run carrying a partial sum wearing that day's
  name. The expenses list drops grouping rather than showing it wrong, and the sort control says so
  before you change the order.
- **`SegmentedField` has two variants and they are not interchangeable.** `'segmented'` (filled track)
  is for **setting a value on a record** — it sits among `TextField`s and must read as a field.
  `'underline'` (a row of labels with a rule) is for **choosing which of the same things to look at** —
  a sort order, an active/paused filter. A form field styled as tabs says "switch view" when it means
  "choose a value".
- **Per-record reminder overrides DO NOT EXIST.** `ReminderEntity.leadTimes` is honoured by
  `resolveLeadTimes()` and covered by `tests/notifications-plan.test.ts`, but nothing in the app
  ever sets it — `billReminderEntity()` and its subscription twin both omit it. Do not write UI copy
  that promises it until a form actually writes one.
- **A bill's amount may legitimately be `null`, and `₱0.00` is never a substitute.** §7's variable
  bill is one the user cannot estimate; forcing a figure makes them invent one, and an invented
  ₱1,500 then feeds totals and reminders as though it were real. Screens render an em dash; totals
  report `unknownAmountCount` rather than folding a blank in as zero.
- **A bill's record moves WITHOUT the user editing it.** `payBill()` advances `dueDate` and flips
  `status`. That is why draft provenance (T1) matters more for bills than for subscriptions: a draft
  seeded before a payment and saved after it un-rolls the settled period. `pickDraft()` in
  `src/features/bills/ui/draft.ts`.
- **A test must never iterate the list it is validating.** `DRAFT_FIELDS` was checked by a loop over
  `DRAFT_FIELDS`, so deleting an entry changed nothing and the mutation passed. Derive the expected
  set from the data's own shape instead.
- **Status colours come from the tokens that already exist** — `overdue`, `dueToday`, `upcoming`,
  `paid`, `inactive`. Inventing a success/danger/warning vocabulary means a late bill and an expired
  document are different reds. `StatusPill` rejects unknown keys at the type level.
- **Colour means "interactive or selected", and nothing else.** The app is greyscale apart from one
  accent (`#175CD3` light / `#8AB4F8` dark), spent on the primary button, a chosen chip, the active
  tab, a focused field and the caret. Status stays greyscale ON PURPOSE: the moment a hue also means
  "overdue", it stops reliably meaning "tap this". `tests/theme-contrast.test.ts` enforces both
  directions — every non-accent token must be greyscale, and the accent must not have drifted back
  to grey.
- **The palette lives in `src/theme/palette.ts`, not `tokens.ts`.** `tokens.ts` imports react-native
  for `Platform.select`, so nothing in it can be loaded by `node --test`. The colours are pure data
  and the one part of the theme with a property worth asserting, so they were extracted.
- **A section title is an EYEBROW, not a heading.** `FormSection` rendered its title as
  `subheading` — 17pt semibold in the primary text colour, the same weight and colour as the
  content beneath it. That left two hierarchy levels (the 28pt page title, and everything else at
  full strength) where a legible screen needs three or four, and every screen read as a stack of
  equally loud slabs with no focal point. It is now 13pt uppercase tracked in `textTertiary`. The
  rule: a signpost must be quieter than what it points at.
- **A restore swaps the FILE; it never copies rows into the current schema.** `drizzle/0002` DROPs
  five tables, so a bundle can carry tables this build no longer has and lack tables it does. Copying
  row-by-row means a second migration path that must agree with the real one forever. Swapping the
  file and running the real migrations means there is one path, and it is the tested one.
  `recoverInterruptedRestore()` at the top of `openDatabase()` is what makes the two-rename window
  survivable — remove it and a kill mid-restore mints a fresh key over the user's data.
- **A chip's label weight never changes with selection.** A chip is as wide as its own text, so bolding
  the chosen one reflows a wrapping row *as you tap it*. The fill carries the state. `SegmentedField`
  can bold safely because each segment is a fixed share of a fixed track; `ChipField` cannot.

---

## Recently closed (do not re-fix)

Newest first, labelled by the commit that closed them — "this session" stopped being a useful
label four commits ago.

### `a87182c` · one accent colour, and contrast that is measured

- **The app has a colour.** Greyscale everywhere, plus one accent (`#175CD3` light / `#8AB4F8`
  dark) spent only on interactive-or-selected: the primary button, a chosen chip, the active tab, a
  focused field, the caret. Every consumer already read `theme.color.accent`, so it was three values
  per theme and nothing else.
- **"Measured contrast in both themes" was a claim with nothing measuring it.** Checked by hand once
  and trusted through every palette edit since. Survivable while everything was grey — a wrong grey
  is obvious — and not survivable with a hue, because two blues that look identical in a mockup can
  differ by 3:1 against a card. `tests/theme-contrast.test.ts` now measures it, both directions.
- **The palettes moved to `src/theme/palette.ts`** so `node --test` can reach them; `tokens.ts`
  imports react-native for `Platform.select`.

### `4ecb864` · the hierarchy the screens were missing

- **A section title was competing with its own content.** `FormSection` rendered it at 17pt semibold
  in the PRIMARY text colour — so every screen had two hierarchy levels where a legible one needs
  three or four, and resolved into equally loud grey slabs with no focal point. Now a 13pt uppercase
  tertiary eyebrow, in `ListSectionHeader` too. This was never a one-screen problem: it improved the
  export form and the Bills list as much as it improved reminders.
- **The reminder screen lost its hero card** — a third full-width slab holding one number, which put
  the answer above the question. The count is one line under the chips now.

### `9c4098b` · reminders show what the settings will actually do

- **The per-kind screen was honest but inert.** It named the intervals and left the user to imagine
  the consequence. It now closes with the real next record and the dates its notifications will land
  on. The rows are `PlannedReminder`s from `planRemindersFor()` — the scheduler's own planner —
  because a preview doing its own date arithmetic is a second implementation of the DST-safe
  lead-time maths, free to drift silently.
- **`subscriptionReminderEntity()` extracted** from `ui/mutations.ts`, mirroring bills'
  `billReminderEntity()`. The preview and the scheduler must project a record the same way, or the
  preview shows reminders that will never be placed.
- **Each kind names its own event.** One shared verb produced "Subscription due Sep 30", which is
  not how anyone describes a renewal. `eventLead` / `eventLabel`, pinned by tests that also fix the
  casing rules — `beforeWhat` is always mid-sentence, `eventLead` always starts a line.

### `86f9341` · one reminder screen per record kind

- **`/reminders` was all three kinds on one page**: fifteen chips under three headings. Everything
  was reachable and it was still the wrong shape, because setting a reminder is a decision about ONE
  kind of thing and the screen made you read the other two to find it. Now an overview stating all
  four answers, plus `/reminders/[kind]`. `src/features/settings/reminder-kinds.ts` keeps the slugs
  and the setting keys in step — a wrong setting key means a screen headed "Bills" silently editing
  document reminders.
- **An unknown slug renders "No such reminder" rather than falling back.** A default would let
  `/reminders/nonsense` quietly edit real bill reminders under a header saying something else.
- **A false claim removed, from two screens.** "Any single bill, subscription or document can
  override these" — it cannot. See the convention above; nothing sets `ReminderEntity.leadTimes`.

### `18edc4e` · Bills screens (Phase 3c)

- **Bills has a UI.** See `plan/phase3-bills-ui.md` for the decisions; the summary is in
  "What works today".
- **`repeat` was being spent twice.** The first icon map gave `phone` the `repeat` glyph, which is
  Subscriptions' own mark — a Globe Postpaid row and a Netflix row were indistinguishable at a
  glance. `repeat` is now reserved for `subscription`, pinned by a test, and the categories with no
  glyph in the set (`water`, `phone`) take the generic `tag` rather than something confidently wrong.
- **Every bill write was discarding its `ScheduleResult`.** `src/features/bills/index.ts`'s
  notification port was a bare pass-through, so `/reminders` kept showing counts from the last boot
  until `syncAllReminders()` happened to run. It calls `noteScheduleResult` now.

### `094c8ee` · restore from an encrypted backup (Phase 8c)

- **Restore built.** `inspectBundle()` reads a bundle without writing anything; `restoreBundle()`
  stages → swaps → opens → migrates → discards, in that order, so the previous database is still on
  disk until the new one has proved it opens. `plan/phase8-backup.md` §9–§10 has the mechanism, the
  rejected alternative, and every device check.
- **`BundleCounts.vehicles` was stale** — the table has been `maintenance_items` since `0003`, so the
  summary was reading a key nothing writes and would have reported "0 vehicles" forever. Renamed, and
  the mapping from table name to user-facing word is now its own tested function
  (`countsFromTables`), because `bill_payments` vs `billPayments` is a typo that silently drops a
  whole record kind from the summary.
- **`bundleIsEmpty()` had no test that every kind counts.** Found by mutation-verifying: dropping
  `maintenanceItems` from its sum left the suite green. A backup holding only maintenance items would
  have been refused as "empty". Test added; the mutation now fails.
- **The handoff claimed allowances were missing from the export.** They were not — `sqlcipher_export`
  copies whole tables, and `summariseBundle` already named them. Withdrawn.

### `bfefae8` · the session before this one

- **A lost setting.** `persist()` in `src/stores/settings-store.ts` was fire-and-forget, so two quick
  writes could complete out of order and the older one win. Observed on the device: toggling two
  reminder lead times left the store holding four values and the database holding three — the switch
  showed on, the next cold boot showed it off, nothing errored or logged. Fixed with a write queue.
  Reachable before this session through appearance and currency, but the reminders screen puts fifteen
  switches in one list, which makes it ordinary.
- **A passphrase in an error message.** op-sqlite echoes bound parameters into its errors, and for
  `ATTACH DATABASE ? … KEY ?` the second parameter is the user's backup passphrase.
  `exportEncryptedCopy()` now throws WITHOUT a `cause`. Re-verified by forcing a failure.
- **A note field that silently truncated.** Expense notes rendered in a `<Row/>`, whose subtitle is
  `numberOfLines={2}` — anything longer was cut with no way to read it. Notes are prose now.
- **A form whose required field sat below the fold.** `/expenses/new` opened photo-first; the amount
  auto-focused, so the keyboard scrolled the title off the top. Amount and merchant come first.
- **A settings screen that could not scroll.** `/reminders` omitted `Screen`'s `scroll` prop, so the
  delivery hour was unreachable. (That file has since become `src/app/reminders/index.tsx`; the
  `scroll` prop is still what makes it reachable at an accessibility text size.)
- **Nine Phase 4 defects** found by rendering screens that had never been looked at — listed in
  `plan/phase9-expenses-allowance.md` §13.

### Earlier

T1 · T2 · T3 · T4 · T5 · T6 · T7 · T8 · T12 · T13 · T14 in `plan/phase2-3-remediation.md`. Highlights:

- **T1** — a draft now records the `record.updatedAt` it was derived from and is trusted only while that
  matches, so an abandoned draft can no longer outrank the database. Cancel discards (with a confirmation
  when there is something to lose); navigating away still keeps the draft, because stepping out of a form
  is not a decision and pressing Cancel is. `pickDraft`/`isDraftDirty` live in
  `src/features/subscriptions/ui/draft.ts` — a `.ts` file, because `node --test` strips types but cannot
  transform JSX, and logic deciding whether a user's data survives should not need a mounted screen to test.
- **T7** — `rescheduleAll()` had **zero** production callers; the retention engine never ran. Now called on
  boot, on foreground, and after any reminder-affecting settings change, via `src/lib/reminders.ts`.
- **T12** — a float in `amount_minor` passes the `> 0` CHECK and used to throw from every read *including
  both deletes*, leaving a record the user could neither see nor remove. Policy now: a list skips and
  reports `damagedCount`, a single-record read still throws, and **delete never maps the row**.
- **T2** — the renewal-candidate query ordered by the anchor, which never moves, so `LIMIT` kept the oldest
  series and dropped renewals due tomorrow. Thirty old yearlies plus one due tomorrow returned **zero**.

## Known gaps, deliberately open

- **13 lower-tier audit findings** in `plan/phase2-3-remediation.md` (Tier 4 form-layer items and the
  latent list): amount-field selection-delete clearing a committed value, pagination re-fetching from
  offset 0, no caret management, `+N more` undercounting past 24.
- **A recorded payment cannot be edited from a screen.** `saveBillPaymentEdit()` and
  `deleteBillPayment()` are wired and exported and the `anchor-row` refusal has its sentence, but a
  ledger row on the bill detail screen is not tappable yet. The natural next slice.
- **Bills are not on Home.** `useUpcomingBills()` exists and is exported for exactly that.
- **`useAsyncRead` is duplicated FIVE times** (subscriptions, receipts, allowance, maintenance,
  bills) — ~60 lines of subtle concurrency logic (generation counter, cancellation) copied per
  feature. Worth extracting across all five at once; not worth smuggling into one of them.
- **Phase 9 leftovers**: no spend notification (deliberate — see the phase plan §7), no per-category
  budgets, no rollover.
- **Maintenance records do not exist.** `maintenance_costs`, `maintenance_services` and
  `maintenance_renewals` have tables, views and migration tests, but no API, no screens and no
  analytics (cost-per-km, fuel efficiency). Items can be added; what happens to them cannot.
- **The `notification_settings.entity_type` enum still names the old vehicle tables**
  (`vehicle_insurance`, `vehicle_registration`, `vehicle_maintenance`). Renaming them changes a CHECK,
  which SQLite can only do by rebuilding the table — and drizzle-kit's rebuild does not drop the
  dependent `notification_settings_live` view first, so the generated RENAME fails. No code reads
  those values, so it waits for step 5e. The reason is written at the enum.
- **Phases 6–7 not started**: Documents, Security (biometric lock). The onboarding wizard already
  RECORDS that the user asked for an app lock, and More says "Soon" — a stated promise with nothing
  behind it.
- **`app.json` needs the Android notification icon wired.** The asset exists at
  `assets/images/notification-icon.png` (96×96, white-on-transparent, verified legible at 24px). It must sit
  **before** `./plugins/with-local-only-notifications` so the entitlement strip runs last, and needs a
  `prebuild --clean` to confirm ordering. Without it Android renders the app icon as a white blob.
- **The app icon is still Expo's default template.** `assets/images/icon.png`, `assets/expo.icon/` and the
  Android adaptive layers are all scaffold defaults. Invisible until submission day, then blocking.
- **Untested by design**: `src/db/client.ts`, `migrate.ts`, `key.ts` import op-sqlite and expo-secure-store,
  which cannot load under plain Node. `withTransaction()`'s atomicity rests on the lint rule and the
  type-level `Omit`, not a test.
- **Android has never been run.** No SDK installed; all Android claims are static verification only.
- **One contrast exception**: the card outline is 1.23:1 light / 1.42:1 dark. Deliberate — no information is
  carried by the boundary alone, and it matches iOS grouped-list convention.

## Commands

### Driving the simulator without taps

`Simulator.app` here reports **zero windows** to System Events, so AppleScript clicks and synthetic taps
are not available at all. Drive the app over CDP instead — it worked reliably for the whole of Phase 9:

- `curl -s -H "Origin: http://127.0.0.1:8081" http://127.0.0.1:8081/json/list` to find the target.
- Connect with `ws` (installed), passing `Origin: http://127.0.0.1:8081`. Host **and** Origin must both
  be `127.0.0.1`, never `localhost`.
- `Runtime.evaluate` does **not** honour `awaitPromise` here — a promise comes back as a Hermes
  `{_A,_x,_y,_z}` object. Stash the result on a global and poll it in a second call.
- Metro's module registry is reachable: `__r.getModules()` returns a **Map**. Scan it for a module whose
  exports match what you need (`e.router && e.useRouter` for expo-router, `e.getDb`, `e.bumpRevision`,
  a feature's API). This is how to navigate, seed data and read the database from outside the app.
- A raw drizzle handle needs `bindStatement()` (exported from `@/features/subscriptions`) — `db.all()`
  takes a drizzle `SQL`, not `{sql, params}`.
- An unhandled rejection inside an eval raises a LogBox toast that `__expo_dev_resetErrors()` does not
  clear. Relaunch the app. Before blaming the app for a toast, check it is not yours.

```bash
npm start               # Metro against the installed dev build
npx expo run:ios        # full native build — needed only for native/config changes
npm run typecheck       # tsc --noEmit
npm run lint
npm test                # node --test, 960 tests
npm run db:generate     # drizzle-kit generate, after editing src/db/schema
```

Simulator: `BC119EA8-0D9A-4183-80F7-5123B0EAA301` (iPhone 17 Pro). **Shut down** at the end of this
session — `xcrun simctl boot <udid>` then `open -a Simulator` brings it back, and the dev client is
still installed, so no rebuild is needed. Metro was left running on 8081; `npm start` if it is gone.

The app on that simulator holds real test data: an allowance, a month of expenses, four
maintenance items (a Vios, an aircon, a water heater, a laptop), three subscriptions and three
bills. **Meralco now carries two months of payment history** (₱4,120.75 and ₱2,980.50 against a
₱3,500 estimate) and has rolled forward to November — added while verifying Phase 3c, and worth
keeping: it is the only record in the database that renders a ledger. Useful for rendering passes, and
worth knowing before you assume an empty database.
