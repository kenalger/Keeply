# Keeply — Resource Brief for Gemini

This file is a self-contained briefing on what Keeply is, how it is built, and the rules any
contributor (human or AI) must follow. Read it before proposing or writing code.

Deeper sources, in order of authority:

| File | What it holds |
| --- | --- |
| `plan/goal.md` | The full product spec (§1–§37). Section numbers like "§19" refer to it. |
| `plan/phases.md` | Phase breakdown, locked stack, cross-cutting invariants. |
| `plan/phase*.md` | Per-phase plans, decisions, and outcomes. |
| `HANDOFF.md` | Current state of the build, known gaps, hard-won environment facts. |
| `CLAUDE.md` | Repo conventions, lint rules, commands. Binding for all contributors. |

---

## 1. What the app is

**Keeply is an offline-first personal life & expense manager for iOS (and later Android).**
It keeps, in one private place on the phone:

1. **Subscriptions** — Netflix, Spotify, gym, iCloud… with billing cycles and renewal reminders.
2. **Bills** — electricity, water, internet, rent, credit card… fixed or variable amounts, with a
   payment history and paid / unpaid / overdue state.
3. **Expenses (formerly "Receipts")** — day-to-day spending, optionally with a receipt photo.
4. **Allowance** — a daily / weekly / monthly budget that day-to-day expenses draw down.
   Bills and subscriptions are committed money and do **not** draw it down.
5. **Maintenance (formerly "Vehicles")** — anything that needs looking after: vehicles, appliances,
   home & property, electronics. Costs, service history, next-due by date or mileage, and renewals
   (insurance, registration, warranty). Odometer, fuel efficiency and cost-per-km are vehicle-only.
6. **Documents** — passports, licences, IDs, policies, certificates, with optional expiry dates,
   an expiry ladder (expired · today · 7 · 30 · 60 · 90 days · later · none), reminders, and a local
   scan/PDF attachment.

Plus: a Home dashboard (monthly spending, upcoming payments, upcoming expirations, due for service,
recent activity), local notifications, a biometric app lock, an encrypted backup/restore, and a
first-run onboarding wizard with a Philippine catalogue of common subscriptions and bills.

**Primary market: the Philippines.** Currency defaults to PHP (₱). Dates are interpreted in the
user's local time zone.

### The promise

> Your data stays on your phone. No account, no server, no upload.

Every design decision follows from that sentence.

---

## 2. Non-negotiable rules

1. **No feature may require network connectivity.** There is no backend and no account. Every
   CRUD write, search, dashboard calculation, notification and media capture happens on-device.
   A `fetch`, a connectivity check, or a spinner waiting on a server is a bug. (Lint enforces this:
   `fetch`, `XMLHttpRequest`, `WebSocket`, `axios`, netinfo are all banned.)
2. **Media never leaves the device.** No uploads, no third-party AI/OCR, no analytics on user content.
3. **Nothing is published off this machine.** No hosted pages, share links or external docs for
   plans, reports or screenshots. Plans live in `plan/*.md`, screenshots in `plan/screenshots/`.
4. **Do not commit unless explicitly asked.** Make changes, verify, report.
5. **Out of scope for the MVP:** cloud sync, accounts, banking integrations, server-side media,
   AI extraction. The schema is shaped so sync *could* be added later — do not build it now.

---

## 3. Tech stack

| Concern | Choice |
| --- | --- |
| Runtime | Expo SDK 57 **dev client** (not Expo Go) · React Native 0.86 · React 19.2 + React Compiler |
| Language | TypeScript 6, strict |
| Navigation | Expo Router, file-based, routes in `src/app` |
| Database | `@op-engineering/op-sqlite` with **SQLCipher** (AES-256 whole-DB encryption) |
| Query layer | **Drizzle ORM** + `drizzle-kit` generated SQL migrations in `drizzle/` |
| Key storage | Expo SecureStore (Keychain / Keystore), `WHEN_UNLOCKED_THIS_DEVICE_ONLY` |
| State | Zustand (UI/session state); the database is the source of truth |
| Styling | Hand-built design system: tokens + `StyleSheet`, no UI library |
| Notifications | `expo-notifications`, local only (push entitlement is stripped by a plugin) |
| Media | `expo-camera`, `expo-image-picker`, `expo-file-system` (app sandbox) |
| Auth | `expo-local-authentication` (Face ID / Touch ID / passcode) |
| Tests | Node 24 built-in test runner with native TS type stripping — no Jest, no simulator |

SQLCipher needs a native build, so **Expo Go will not run this project.** Use `npx expo run:ios`.

---

## 4. Repository layout

```
src/
  app/            Expo Router routes
    (tabs)/       index (Home), money, maintenance, documents, more
    subscriptions/ bills/ expenses/ maintenance/ documents/   list · [id] · new
    allowance/ reminders/ backup/ security.tsx onboarding.tsx add.tsx
  db/             SQLCipher client, key management, migration runner, Drizzle schema
    schema/       subscriptions, bills, receipts, allowances, maintenance, documents,
                  settings, views (the *_live views), columns, enums
  features/       Per-domain logic: subscriptions, bills, receipts, allowance,
                  maintenance, documents, backup, security, settings, onboarding
  components/ui/  Primitives: Screen, Card, Row, Amount, AmountField, DateField,
                  SelectField, ChipField, Sheet, EmptyState, Badge, Skeleton, …
  stores/         Zustand: boot, app-lock, settings, notification, onboarding, drafts, ui
  lib/            log (redacting), errors, recurrence, reminders, notifications,
                  dashboard, search, hooks
  theme/          tokens, palette, ThemeProvider, formatters
drizzle/          Generated migration SQL — committed, never hand-edited
plugins/          Local Expo config plugins (backup exclusion, local-only notifications)
tests/            node --test suites, lint fixtures
plan/             Spec, phase plans, screenshots
```

`ios/` and `android/` are generated by `npx expo prebuild --clean` and gitignored. Never hand-edit
them — native changes go in `app.json` or a plugin under `plugins/`.

---

## 5. Data conventions

- **Money is integer minor units** (centavos) in columns named `*_minor`, plus a `currency` code
  defaulting to `'PHP'`. Never floats, never formatted strings. Format only at the UI edge via
  `<Amount />` / `formatMoney`. Totals never silently sum across currencies.
- **Calendar dates** (due, expiry, purchase) are `TEXT` `YYYY-MM-DD`, parsed as *local* dates.
  `new Date('2026-10-12')` is UTC midnight and shifts the day in Manila — lint bans it.
- **Timestamps** (`created_at`, `updated_at`) are integer epoch millis.
- **Every row** has a UUID `id`, `created_at`, `updated_at`, nullable `deleted_at` (soft delete).
  Reads go through `live.*` views, never `schema.*` tables (lint-enforced outside `src/db`).
- **Transactions** use `withTransaction()` from `@/db`, never drizzle's `.transaction(`.
- **Imports** go through `@/db`; importing `@/db/schema`, `client`, `key` or `migrate` directly is banned.
- **Colors** come from `theme.status[key]` / tokens. No raw hex in `src/app` or `src/components`.
- **Logging** goes through `src/lib/log.ts`, which redacts by key name. Never log file paths,
  `file://` URIs, document/policy/plate numbers, or amounts. `console.*` is banned elsewhere.
- **A missing local file renders "Image unavailable"** — never a crash.
- **Optional amounts** (a variable bill) render an em dash, not ₱0.00, and totals say how many
  items they left out.
- **Optional expiry dates** (a birth certificate) sort last and are never scheduled as reminders.
- **Document numbers are masked** (`**** **** 1234`) and are never a search predicate.

---

## 6. Security & privacy model

- **Encrypted at rest:** the whole database is SQLCipher. `assertSQLCipher()` fails the boot if the
  build silently fell back to plaintext SQLite. The `"op-sqlite": { "sqlcipher": true }` key in
  `package.json` is what selects it.
- **Device-bound key:** minted on first launch into the Keychain/Keystore, never logged, never shown.
- **Not in iCloud / device backups, on purpose.** The DB lives in
  `Library/Application Support/Keeply/` (iOS, flagged `NSURLIsExcludedFromBackupKey` at launch by
  `plugins/with-database-backup-exclusion.js`) or `no_backup/Keeply/` (Android). File and key stay
  together, so a restored phone opens a clean app instead of an undecryptable one.
- **iOS Data Protection:** `completeUnlessOpen` for the database directory (held open for the life
  of the process); `complete` for `receipts/` and `documents/` media.
- **Portability is user-driven:** an encrypted backup bundle (itself a SQLCipher database keyed by a
  passphrase) exported via the share sheet, and a restore that stages, swaps, migrates and only then
  deletes the old data — recoverable if interrupted.
- **App lock:** biometric/passcode with a grace period; the navigation tree is not mounted while
  locked. An opaque privacy cover goes up on `inactive`. The lock **fails open** when it cannot be
  satisfied (no enrolment, no passcode) — a lock nobody can open would permanently strand the user's
  only copy of their data, and SQLCipher protects it regardless.
- **Key rotation is deliberately not built** — see `plan/phase7-security.md` §3.

---

## 7. Notifications

Local only. Reminder offsets (same day, 1 / 3 / 7 / 30 days before) are configurable per kind
(bills, subscriptions, documents, maintenance). A 60-slot rolling window is rebuilt on boot, on
foreground, and on any reminder-affecting settings change. The reminder screens preview the user's
*real* next item using `planRemindersFor()` — the same function `rescheduleAll()` runs — so the
preview can never promise a reminder the OS queue does not hold.

---

## 8. Build status (as of 2026-09-25)

**All phases 1–9 are built** and exercised on the iOS Simulator.

| Phase | State |
| --- | --- |
| 1 Foundation | Complete |
| 2 Subscriptions | Complete |
| 3 Bills | Complete, incl. payment corrections |
| 4 Receipts → Expenses | Complete |
| 5 Maintenance | Complete (5a–5e) and wired into Home/Money |
| 6 Documents | Complete, incl. the "this expired — what now?" prompt |
| 7 Security | Complete; key rotation deliberately deferred |
| 8 Backup / Restore | Complete; round-trip verified |
| 9 Expenses & Allowance | Complete |
| Onboarding wizard | Complete |

Notable open items (full list in `HANDOFF.md` → "Known gaps"). None is a half-built feature;
each is either hardware-gated or a deliberate product decision with its reasoning written down:

- **Never run on a physical iPhone.** Data Protection enforcement, camera capture, permission-denied
  paths and the Files picker's taps can only be proved on a device.
- **Android has never been run** (no SDK installed on the build machine).
- Documents: no camera viewfinder screen (the hook is wired), no in-app PDF viewer (a native dependency).
- T17 in `plan/phase2-3-remediation.md`: caret management in the amount field; needs a device.
- Deliberately deferred, with reasons in the phase plans: key rotation (§7), an allowance spend
  nudge and per-category budgets (§9), per-document reminder overrides (§6), scheduled backups (§8),
  a cost updating an item's odometer (§5).
- `compareBundle` refuses a squashed migration history as `bundle-newer` — wrong-but-safe; this
  project has never squashed.

---

## 9. Commands

```bash
npm run typecheck       # tsc --noEmit
npm run lint            # eslint . — must exit 0
npm test                # node --test over tests/ (no simulator, no native modules)
npm run db:generate     # drizzle-kit generate, after editing src/db/schema
npx expo run:ios        # build + launch the dev client
npx expo prebuild --clean --platform ios   # after any app.json / plugins / op-sqlite change
```

Machine quirks: CocoaPods needs `export PATH="$HOME/.gem/ruby/2.6.0/bin:$PATH"`; port 8081 must be
free (another project's Metro there produces a misleading `PlatformConstants` invariant error);
the first iOS build takes ~15 minutes.

Anything imported by a test must load in plain Node — no `react-native`, no `expo-*`, no op-sqlite.

---

## 10. How to contribute well

- Read `CLAUDE.md` and the relevant `plan/phase*.md` before changing a domain.
- Keep logic pure and testable in `src/features/*` / `src/lib/*`; keep screens thin.
- After a schema change: edit `src/db/schema`, run `npm run db:generate`, commit the generated SQL,
  never edit it by hand. Paged lists need a matching `*_page_*_idx` (the `query-plans` test checks).
- Before calling work done: `typecheck`, `lint` and `test` all pass, and the change was exercised in
  the simulator where it affects UI.
- When in doubt, choose the option that keeps data on the device and never loses it.
