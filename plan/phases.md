# Keeply — Implementation Phases

Derived from `goal.md`. The app stays runnable after every phase.

## Locked Tech Stack

| Concern | Decision |
| --- | --- |
| Runtime | React Native + Expo (dev client, **not** Expo Go) |
| Language | TypeScript (strict) |
| Navigation | Expo Router (file-based, bottom tabs) |
| Database | `@op-engineering/op-sqlite` with **SQLCipher** (AES-256 whole-DB encryption) |
| Query layer | **Drizzle ORM** + `drizzle-kit` generated SQL migrations |
| Encryption key | Generated on first launch, stored in **Expo SecureStore** (iOS Keychain / Android Keystore) |
| State | **Zustand** (UI/session state) + Drizzle live queries (server-of-truth data) |
| Styling | Hand-built design system: theme tokens + `StyleSheet`, no UI library |
| Notifications | `expo-notifications` (local only, no push server) |
| Media | `expo-camera`, `expo-image-picker`, `expo-file-system` (app-sandbox storage) |
| Auth | `expo-local-authentication` (Face ID / Touch ID / device passcode) |
| Currency | PHP (₱) only; numeric storage, formatting at the UI edge |
| Cloud | **None.** No backend, no account, no network dependency in MVP. |

Dev target is the iOS Simulator (Xcode 26.6 present). Android builds via EAS when an SDK is installed.

---

## Phase 1 — Foundation  ← *current*

**Deliverable: a runnable offline shell.** Five tabs, themed, with an encrypted database that migrates on boot.

- Expo + TypeScript project, path aliases, strict lint/tsconfig
- Expo Router bottom-tab navigation: Home / Money / Vehicles / Documents / More
- op-sqlite + SQLCipher client; key generated once and held in SecureStore
- Full Drizzle schema for all 13 tables (§22) + generated migration 0000
- Migration runner executed on app boot, behind a splash gate
- Design system: light/dark tokens, typography scale, spacing, primitives
- Zustand stores + app-bootstrap state machine
- Error boundary, redacting logger (never logs file paths, document numbers, amounts)
- Empty states on every tab

**Done when:** app launches in the simulator in airplane mode, creates its encrypted DB, runs migrations, and renders all five tabs in both light and dark mode.

## Phase 2 — Subscriptions
CRUD, categories, billing cycles (weekly/monthly/quarterly/yearly/custom), next-billing-date recurrence engine, monthly/yearly normalized totals, renewal notifications, search + active/inactive filter.

## Phase 3 — Bills
CRUD, fixed vs variable amounts, `bill_payments` history, paid/unpaid/overdue state machine, recurrence roll-forward, due-date notifications, filters.

## Phase 4 — Receipts
Camera + library capture, image written to app sandbox with thumbnail generation, metadata in SQLite, missing-file tolerance ("Image unavailable"), merchant/category/date-range/amount filters, spending summaries.

## Phase 9 — Expenses & Allowance  ← *done, built out of order*

Set an allowance daily / weekly / monthly; day-to-day expenses draw it down, bills and subscriptions do
not. Calendar periods, no rollover, one cadence at a time. `allowances` is a history table resolved by
`effective_from`, so changing the budget never restates a month already lived. Receipts became
"Expenses" — same table, same totals, photo optional, list grouped by day. Full plan and outcomes:
`plan/phase9-expenses-allowance.md`.

## Phase 5 — Maintenance  *(was "Vehicles" — see `plan/phase5-maintenance.md`)*
Anything that needs looking after: **vehicles, appliances, home & property, electronics**. One item
table with a `kind`, one cost ledger, service history with next-due by date or mileage, and one
renewals table covering insurance, registration **and warranty**. Odometer, fuel efficiency and
cost-per-km are kept but scoped to vehicles alone. Schema and migrations (`0002` drops the five
vehicle tables, `0003` creates the four maintenance ones) are **done**; the feature and UI layers
are not.

## Phase 6 — Documents
Document CRUD, local file/PDF attachment, expiry bucketing (expired / today / 7 / 30 / 60 / 90 days), expiry notifications, masked document numbers (`**** **** 1234`).

## Phase 7 — Security
Biometric app lock with passcode fallback, background-blur privacy screen, key rotation, sensitive-field handling audit, privacy settings, permission-denial recovery paths.

## Phase 8 — Backup / Restore
Encrypted export bundle (metadata + optional media), passphrase-derived key, import validation and decrypt, restore workflow with conflict handling, explicit opt-in for any plaintext export.

---

## Cross-cutting invariants (enforced every phase)

1. No network call is required for any CRUD, search, calculation, or notification.
2. Media never leaves the device. No uploads, no third-party AI, no analytics on user content.
3. Money is stored as numbers, never as formatted strings.
4. Every table carries a UUID `id`, `created_at`, `updated_at` — shaped so a sync queue can be bolted on later.
5. A missing local file is a rendering state, never a crash.
6. Lists are virtualized; images are thumbnailed and never all resident in memory.
