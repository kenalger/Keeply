# Keeply

Offline-first personal life & expense manager: subscriptions, bills, receipts, vehicle expenses, document expiry.
Full product spec: `plan/goal.md`. Phase breakdown and stack rationale: `plan/phases.md`.

## Output stays on this machine

Never publish an Artifact, a hosted page, a share link, or anything visible outside this machine.
Reports, plans and handoffs are files in this repo (`plan/*.md`, `HANDOFF.md`) or terminal output.
Screenshots live in `plan/screenshots/`, on disk.

This is the user's explicit instruction, and it follows from the product: an app whose promise is
"your data stays on your phone" should not have its screens and plans published to a hosted page.

## The one rule

**No feature may require network connectivity.** There is no backend and no account. Every CRUD write,
search, dashboard calculation, notification, and media capture happens on-device. If you find yourself
adding a `fetch`, a connectivity check, or a loading spinner that waits on a server, it is wrong.

Media (receipt photos, document scans, IDs) never leaves the device. No uploads, no third-party AI,
no analytics on user content.

## Stack

Expo SDK 57 (dev client, **not** Expo Go) · React Native 0.86 · React 19.2 with React Compiler ·
TypeScript 6 strict · Expo Router (file-based, routes in `src/app`) ·
`@op-engineering/op-sqlite` with **SQLCipher** · **Drizzle ORM** + drizzle-kit migrations ·
Zustand · hand-built design system (`StyleSheet` + tokens, no UI library).

SQLCipher requires a native build, so **Expo Go will not run this project**. Use `npx expo run:ios`.

## Layout

```
src/
  app/          Expo Router routes. (tabs)/ = Home, Money, Vehicles, Documents, More
  db/           SQLCipher client, key management, Drizzle schema, migrations
  theme/        Design tokens, ThemeProvider, formatters
  components/ui Reusable primitives (Screen, Card, Row, Amount, EmptyState, …)
  features/     Per-domain logic (subscriptions, bills, receipts, vehicles, documents)
  stores/       Zustand stores
  lib/          Logger, errors, env
drizzle/        Generated migration SQL — commit these, never hand-edit
plan/           Product spec and phase plan
```

## Conventions

- **Money is integer minor units** (centavos) in columns named `*_minor`, plus a `currency` code
  defaulting to `'PHP'`. Never store floats. Never store formatted strings like `"₱1,500.00"`.
  Format only at the UI edge, via `<Amount />` / `formatMoney`.
- **Calendar dates** (due, expiry, purchase) are `TEXT` `YYYY-MM-DD`. **Timestamps**
  (`created_at`, `updated_at`) are integer epoch millis. Parse `YYYY-MM-DD` as a *local* calendar
  date — `new Date('2026-10-12')` is UTC midnight and shifts the day in PH time.
- Every row: UUID `id`, `created_at`, `updated_at`, nullable `deleted_at` (soft delete, so an
  optional sync queue can be added later without a migration).
- Status colors come from `theme.status[key]`. Never reach for a raw hex in feature code.
- Never log file paths, `file://` URIs, document/policy/plate numbers, or amounts. Use `src/lib/log.ts`,
  which redacts by key name.
- Encryption keys live in SecureStore (Keychain/Keystore) only. Never hard-coded, never logged.
- A missing local file renders "Image unavailable" — it is never a crash.
- **Every create, edit and delete is seen.** A write goes `setBusy('Saving…')` →
  `await holdBusy(write)` → `setBusy(null)` in `finally`, and the screen passes `busy` to its
  `FormScreen` / `Sheet` / `Screen`, which mount the `BusyOverlay`. `holdBusy` keeps the outcome
  back for at least 400ms so the overlay registers and never flickers. No form owns its own
  spinner, and nothing is disabled-only (a 40% button reads as broken, not busy).
- **Reads go through `readAll()`, writes through `withTransaction()`.** A read outside a
  transaction runs on a second, read-only SQLCipher connection and never blocks the JS thread; a
  feature's live store `all` is `readAll(text, params)`. A read INSIDE `withTransaction()` uses the
  transaction, so it sees its own uncommitted rows. Never call `executeSync` for a read from
  feature code, and never `BEGIN` on the read connection — `readAll` refuses both.
- **Loading indicators are delayed, never immediate.** Reads here finish inside a frame or two, so
  a skeleton drawn at once is a one-commit flash. Every `Skeleton` reserves its box on mount and
  paints 150ms later (`useDelayedTrue`), so anything built from `Skeleton*` — `List loading`, a
  detail screen's `SkeletonList`, a card's placeholder — inherits the delay. Never a raw
  `ActivityIndicator` — `Button loading`, `Skeleton*`, `List loading` or `BusyOverlay`. Boot shows
  `LoadingScreen`, which draws the splash's mark at the splash's size so the hand-off from native
  is invisible.

## Where the data lives — and why it is not in a backup

**Decision (§19, §A4): user data does not ride an iCloud or device backup.** The SQLCipher key is
minted into the Keychain/Keystore as `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it never leaves the handset
it was created on. If the *database* travelled without it — iCloud backup, device-to-device migration,
a Finder restore — the new phone would hold an encrypted file nothing on it can decrypt, and Keeply
would boot into an unrecoverable error on a device the user believes they just restored. Keeping file
and key together (both device-bound) means **a restored phone opens a clean app**. Portability is
§20's user-driven encrypted export, not a silent OS copy.

| | Path | How it stays out of backups |
| --- | --- | --- |
| iOS | `Library/Application Support/Keeply/keeply.db` | `NSURLIsExcludedFromBackupKey` on the directory, set at launch by `plugins/with-database-backup-exclusion.js` |
| Android | `<dataDir>/no_backup/Keeply/keeply.db` | `getNoBackupFilesDir()` — excluded by the platform, no manifest change needed |

Paths are derived from the constants op-sqlite reports from native code (`IOS_LIBRARY_PATH`,
`ANDROID_FILES_PATH`), never by string surgery on a Documents path. The folder name `Keeply` appears in
**two** places and they must match: `DATABASE_DIRECTORY` in `src/db/client.ts` and the `directory`
option passed to the plugin in `app.json`.

### Data Protection: two classes, on purpose

The same launch hook sets the iOS Data Protection class, because it is the same directory and the
same "before op-sqlite opens the file" constraint. Without it everything takes the OS default,
`CompleteUntilFirstUserAuthentication` — readable from the first unlock after a reboot until the
phone powers off, which is weaker than a passport scan deserves.

| | Class | Why this one |
| --- | --- | --- |
| `Application Support/Keeply` (the database) | `completeUnlessOpen` | op-sqlite holds `keeply.db` OPEN for the life of the process. `complete` evicts the file key on lock, so a backgrounded app would hit an I/O error below SQLCipher on return. `completeUnlessOpen` keeps an already-open handle alive across a lock. |
| `…/Keeply/receipts`, `…/Keeply/documents` (media) | `complete` | Opened on demand, never held. The strongest class costs nothing and means a locked phone cannot be made to give up an ID photo. |

**Not verifiable on the simulator** — it stores protection classes and never enforces them. A
simulator check proves the attribute was set and nothing about what it does; read it back on a
device with `FileManager.attributesOfItem(atPath:)[.protectionKey]`.

Verify the iOS exclusion empirically — a plugin that compiles but sets nothing is the failure mode:

```bash
C=$(xcrun simctl get_app_container <UDID> com.keeply.app data)
xattr -l "$C/Library/Application Support/Keeply"      # com.apple.metadata:com_apple_backup_excludeItem
head -c 16 "$C/Library/Application Support/Keeply/keeply.db" | xxd   # must NOT be "SQLite format 3"
```

On Android the equivalent check is that the generated manifest's `fullBackupContent` /
`dataExtractionRules` (`@xml/secure_store_backup_rules`, from expo-secure-store) contain only
`sharedpref` `<include>` rules — an `<include>` turns Auto Backup into an allowlist, so the app's
files are not backed up at all.

## Commands

```bash
npx expo prebuild --clean --platform ios   # regenerate ios/ from app.json (destroys ios/)
npx expo run:ios        # build + launch the dev client (required; Expo Go won't work)
npm start               # metro, once a dev client is installed
npm run typecheck       # tsc --noEmit
npm run lint            # eslint . — must exit 0; see "Lint rules" below
npm test                # node --test over tests/ — no simulator, no native module
npm run db:generate     # drizzle-kit generate, after editing src/db/schema
```

### Lint rules

`eslint.config.js` is `eslint-config-expo/flat` plus the rules that encode this
project's own invariants. Each one carries a `message` explaining *why*, because
the point is to teach the invariant, not to be satisfied:

| Rule | What it stops |
| --- | --- |
| `new Date(<string>)`, `Date.parse()` | UTC-midnight parsing shifting a due date by a day. Both the literal form and — via type information — `new Date(bill.dueDate)`. |
| `.transaction(` outside `src/db` | drizzle's non-atomic `transaction()`. Use `withTransaction()` from `@/db`. |
| `console.*` outside `src/lib/log.ts`, `src/db/log.ts` | An unredacted amount or file path in a device log. |
| `.from(schema.*)` outside `src/db` | Reading tombstones. Read from `live.*`. |
| Importing `@/db/schema` / `client` / `key` / `migrate` | Bypassing `@/db`, the whole contract. |
| Raw hex colors in `src/components/**`, `src/app/**` | Colors invisible to the theme. Use `theme.status[key]`. |
| `fetch` / `XMLHttpRequest` / `WebSocket` / `axios` / netinfo | The offline-first invariant (§1, §25, §34). |
| `AsyncStorage` | Plaintext storage of receipts and IDs (§2). |

Type-aware linting is on (`projectService`), so the first run in a session takes
a couple of seconds. `tests/fixtures/lint/` holds deliberate violations of every
rule; `tests/lint-rules.test.ts` runs the real config over them and fails if a
rule stops firing — or starts firing on correct code.

### Tests

`npm test` runs Node 24's built-in runner over `tests/**/*.test.ts`, with Node's
own TypeScript type stripping. No Jest, no Babel, no Metro, no simulator: the
suite covers pure logic and SQL, which is where this project's risk actually is.

```bash
npm test                                            # everything
node --import ./tests/hooks/resolve-ts.mjs --test tests/money.test.ts   # one file
npm run test:watch
```

- `format-dates` / `recurrence-boundaries` — calendar dates across ten
  timezones (UTC, Manila, Kiritimati +14, Pago Pago −11, Kathmandu +05:45,
  Chatham +12:45, LA, NY, London, Sydney), both US DST transitions, "now"
  pinned at local 00:00 and 23:59, month-end and leap-day arithmetic.
- `money` — `minorUnits()`, the major/minor boundary, `formatMoney`.
- `log-redaction` / `log-dev` / `db-log` — the redacting loggers, with
  `log-redaction` running as a **release build** (`__DEV__` undefined), which is
  where `log.error` is live.
- `migration-sql` — `drizzle/*.sql` applied to a real database via `node:sqlite`:
  CHECK constraints, partial unique indexes, the `*_live` views, cascades.
- `lint-rules` — the lint config itself.
- `query-plans` — `EXPLAIN QUERY PLAN` over every paged list, asserting none
  answers a page with `USE TEMP B-TREE FOR ORDER BY`. A plan, not a stopwatch:
  timing on fixture rows is a coin flip on CI and says nothing about a hundred
  thousand. It fails when an ORDER BY gains a term and its `*_page_*_idx` in
  `src/db/schema/` does not — widen the index, do not delete the case. Its
  second half drops all seventeen indexes and asserts every plan regresses,
  which proves the guard can fail and that no index in the set is dead weight.
- `keyset` / `keyset-pages` / `query-plans-keyset` / `paged-list` — keyset paging:
  cursor encoding with NULL sort keys, ties, NOCASE and Unicode; every list × every
  sort × every filter paged at sizes 1/2/3/7/40 against real SQLite over the committed
  migrations and compared with one full read; every continuation's plan is an index
  seek with no temp B-tree; the paged-list controller (no overlapping reads, superseded
  reads discarded, `loadMore` queued) and its statement counts.
- `coalesce` / `at-least` / `theme-contrast` — one reminder rebuild in flight plus one
  trailing; the ≥400ms hold behind `holdBusy()`; every text, chip, outline and fill pair
  in both themes measured against WCAG, and fills against the island they sit on.
- `read-gate` — the read connection's open/close state machine (a close racing an open
  voids the open's ticket), and the statement rule behind `readAll()`: one SELECT or
  WITH with a matching parameter count; writes, `BEGIN`, pragmas, `ATTACH` and a smuggled
  second statement are refused, and all 67 SELECTs the features build are admitted.

`tests/hooks/resolve-ts.mjs` teaches Node the `@/` alias and extensionless
imports; `tests/node-types.d.ts` requests `@types/node` for the program.
Anything imported by a test must be loadable in plain Node — no `react-native`,
no `expo-*`, no op-sqlite.

### `npx expo run:ios` — non-obvious setup on this machine

1. **CocoaPods is not on `PATH`.** It is installed as a user gem against the system Ruby,
   so `pod` only resolves after:
   ```bash
   export PATH="$HOME/.gem/ruby/2.6.0/bin:$PATH"
   ```
   Without it `expo run:ios` fails at the pod-install step. (That Ruby is 2.6, which lacks
   `Array#filter_map`; Expo's "precompiled modules" reader logs `Failed to read spm.config.json`
   for every module and falls back to building from source. Harmless, just slower.)

2. **Port 8081 must be free.** If another project's Metro is already listening there,
   `expo run:ios` reuses it and the dev client downloads *that project's* bundle — which
   surfaces as `Invariant Violation: TurboModuleRegistry.getEnforcing('PlatformConstants')`,
   not as a port error. Check with `lsof -nP -iTCP:8081 -sTCP:LISTEN`, or pass
   `--port 8082` and start Metro with `npx expo start --port 8082`.

3. First build is ~15 min (everything compiles from source). Later builds are incremental.

## Generated native directories

`ios/` and `android/` are **generated output** (both are gitignored) and must never be
hand-edited: `npx expo prebuild --clean` deletes and rewrites them. Anything that has to reach
native code belongs in `app.json` (config-plugin props / `ios.infoPlist`) or in a local plugin
under `plugins/`. Two things live outside `app.json` by necessity:

- **SQLCipher** is selected by the top-level `"op-sqlite": { "sqlcipher": true }` key in
  **`package.json`** — op-sqlite ships no config plugin, and both `op-sqlite.podspec` and its
  `android/build.gradle` read the app's own `package.json`. Removing it silently downgrades the
  app to plaintext SQLite; `assertSQLCipher()` in `src/db/client.ts` is what catches that.
- **`plugins/with-local-only-notifications.js`** strips the `aps-environment` entitlement that
  the auto-applied `expo-notifications` plugin adds. Keeply schedules local notifications only
  and has no push server, so it must not request a push entitlement.
- **`plugins/with-database-backup-exclusion.js`** injects Swift into
  `AppDelegate.application(_:didFinishLaunchingWithOptions:)` that creates
  `Library/Application Support/Keeply` and sets `NSURLIsExcludedFromBackupKey` on it. It has to be
  native and it has to run at launch: no installed module binds that attribute, and it is a *runtime*
  flag on a *runtime* directory, so it cannot be expressed in `Info.plist` or entitlements. Launch is
  before any JS, so the directory exists and is stamped before op-sqlite ever touches it. The plugin
  throws — rather than skipping quietly — if the AppDelegate is not Swift or its anchors are missing.

Any change to `app.json`, `plugins/`, or the `op-sqlite` key requires
`npx expo prebuild --clean --platform ios && npx expo run:ios`.

## Not in the MVP

Cloud sync, accounts, banking integrations, server-side media, AI extraction. See `plan/goal.md` §36.
Schema is shaped so sync *can* be added later; do not build it now.
