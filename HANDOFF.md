# Keeply — Handoff

**State at this commit:** `tsc --noEmit` 0 · `eslint .` 0 errors · `npm test` **752/752**.
Runs on the iOS Simulator. Phases 1–4 complete (receipts unverified on device), onboarding complete,
Phases 5–8 outstanding.

Read `CLAUDE.md` for conventions before touching anything. `plan/goal.md` is the product spec.

---

## What works today

A private, offline-first iOS app you can actually use:

- **Encrypted vault.** SQLCipher via op-sqlite. Verified empirically — the on-disk header is random bytes,
  not `SQLite format 3`, and `sqlite3` refuses to open it. Key lives in the Keychain, device-only.
- **Excluded from iCloud backup** by a config plugin, verified by `xattr`
  (`com.apple.metadata:com_apple_backup_excludeItem`). A restored phone opens a *clean* app rather than a
  bricked one; portability is §20's encrypted export, which is not built yet.
- **Offline cold boot** with Wi-Fi off, verified: boots to Home in ~300ms.
- **Subscriptions** — CRUD, anchored recurrence, SQL-side normalized totals, list/detail/form screens.
- **Bills** — CRUD, payment history, derived overdue, ledger-anchored roll-forward.
- **Local notifications** — six-state permission model, 60-slot rolling window, rebuilt on boot,
  foreground, and any reminder-affecting settings change.
- **First-run wizard** — 6 steps, resumable, 56-entry Philippine catalogue, all importable.
- **Design system** — fully monochrome, deliberately de-decorated, full form layer, `ThemeLayout` spacing
  rules, measured contrast in both themes.

167 screenshots in `plan/screenshots/`, numbered by pass (`13-` monochrome, `14-` subscriptions,
`16-` wizard, `17-` layout pass).

---

## Start here

**1. Restore the specialist agents.** `.claude/agents/` holds five mobile specialists
(`expo-native-engineer`, `mobile-data-engineer`, `mobile-ui-engineer`, `mobile-feature-engineer`,
`mobile-qa-engineer`), each with web research enabled. **They only register at session start** — a session
that began before they existed cannot call them. Start a fresh session and they are available by name.

**2. Render Phase 4 and look at it.** Receipts is code-complete and green — data layer, camera capture,
storage, thumbnails, form, list, detail, filters, dashboard wiring — but **no screen has ever been
rendered**. The agent doing the visual pass stalled before capturing anything. Camera capture, thumbnail
generation, the missing-image state and the permission-denied paths are all unverified.

This matters more than it sounds. Rendering passes in this project have caught a six-screen-tall empty
dashboard, a reminder promise truncated to "Remind me 3 days before Converge Fi…", and a `SelectField`
that could not display its options **at all**. Green tests caught none of them. `mobile-ui-engineer` is
the right agent for this.

**3. Phase 8 (Backup) is load-bearing and scheduled last — consider moving it up.** The database is
deliberately excluded from iCloud backup, which is correct for privacy and means a restored phone opens
clean rather than bricked. But the replacement safety net is §20's encrypted export, which does not exist
yet. **Right now: lose the phone, lose the data.** That was fine while the app held test records; it stops
being fine the moment anyone puts real bills in it.

---

## Hard-won environment knowledge

**Do not re-derive these. Each one cost an agent run.**

- **Brief size stalls agents.** Three consecutive receipts agents stalled at exactly the same point,
  immediately after "I'll start by reading" — the brief said to read `src/features/bills/**` *in full*,
  which is **3,614 lines** before writing anything. Point agents at specific files and sections instead.
  `store.ts` (56 lines) and `index.ts` (186) are the pattern-defining ones.
- **CDP works on `127.0.0.1:8081` only**, never `localhost`. Metro's proxy compares the `Origin` header
  against its own `serverBaseUrl.origin`, so host *and* `Origin` must both be `127.0.0.1:8081`. The `ws`
  package is installed. This is the only reliable way to drive the app when the workstation is locked
  (a locked screen kills synthetic taps).
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
- **`node:sqlite` binds every JS number as REAL.** Production is safe only because the columns have
  INTEGER affinity and no query does arithmetic on a bound parameter.
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

---

## Recently closed (do not re-fix)

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
- **Phases 5–8 not started**: Vehicles, Documents, Security (biometric lock), Backup (encrypted export).
  Note the backup story is what makes the "excluded from iCloud" decision safe — until §20 ships, a lost
  phone means lost data.
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

```bash
npm start               # Metro against the installed dev build
npx expo run:ios        # full native build — needed only for native/config changes
npm run typecheck       # tsc --noEmit
npm run lint
npm test                # node --test, 686 tests
npm run db:generate     # drizzle-kit generate, after editing src/db/schema
```

Simulator in use: `BC119EA8-0D9A-4183-80F7-5123B0EAA301` (iPhone 17 Pro).
