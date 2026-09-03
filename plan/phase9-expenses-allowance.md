# Phase 9 — Expenses & Allowance

**Status: complete. Steps 0 and 9a-9f all done.** Screenshots in `plan/screenshots/19-*`. Written 2026-09-03 from the request: *"track my expenses —
what I bought, with my money — and let me set an allowance for the month, week, or daily."*

Read this before `plan/phases.md`; it changes the phase order.

---

## 1. What you already have, honestly

Half of this is built. Receipts (Phase 4) already stores exactly what "what I bought" needs:

| Field | Column | Notes |
| --- | --- | --- |
| What / where | `merchant` | required |
| How much | `amount_minor` + `currency` | integer centavos, `> 0` CHECK |
| What kind | `category` | food, grocery, transportation, shopping, electronics, healthcare, entertainment, household, vehicle, other |
| When | `purchase_date` | `YYYY-MM-DD`, local calendar date |
| Paid with | `payment_method` | free text — "GCash", "Cash", "BPI Debit" |
| Notes | `notes` | |
| Photo | `local_image_uri`, `local_thumbnail_uri` | **already nullable** |

The photo is already optional — the seeded data has a Grab expense with no image and the
list renders it with a placeholder, and `/receipts/new` opens the *form*, not the camera.
So a photo-less expense is not a new record type. It is the same record with a different
name on the front of it.

**What genuinely does not exist:**

1. An allowance — there is no place to say "I have ₱15,000 for September".
2. Spend-against-a-period — receipts totals are all-time (`₱4,591.00 · 5 receipts`),
   never "this week" or "what's left".
3. A framing where logging ₱60 for lunch feels like the point rather than a receipt you
   forgot to photograph.

This phase builds those three. It does not rebuild the ledger.

> ⚠️ **Caveat that sets the order of work.** No receipts screen has ever been rendered
> and looked at (see `HANDOFF.md` → "Render Phase 4"). This phase reframes and extends
> those exact screens. Do the Phase 4 visual pass **first** — building a second storey on
> a floor nobody has stood on is how the six-screen-tall empty dashboard happened.

---

## 2. Decisions, locked

Answered 2026-09-03. These are settled; the rest of the plan follows from them.

| Decision | Choice | Consequence |
| --- | --- | --- |
| What draws down the allowance | **Day-to-day expenses only** | Bills, subscriptions and vehicle costs are *committed money* — shown next to the allowance, never subtracted from it. A ₱3,500 Meralco bill does not blow up "₱4,200 left this week". |
| Ledger shape | **One ledger, renamed "Expenses"** | Table stays `receipts`. No second spending table, no total that has to sum two sources. |
| Period anchoring | **Calendar periods** | Monthly = 1st → last day. Weekly = Monday → Sunday. Daily = midnight → midnight, *local*. |
| Leftover money | **Resets each period** | "Left this week" depends only on this week. No running balance, no recompute of history. |

### Why one ledger and not an `expenses` table

Two tables would mean two totals, two filter implementations, two dashboard queries, two
sets of category rules, and a permanent question at the point of entry ("is this a receipt
or an expense?") that the user should never have to answer. The photo is one optional
field. Splitting on the presence of an optional field is splitting on nothing.

The cost is a rename that touches routes and copy. That cost is paid once, by `tsc`.

---

## 3. Data model

### 3.1 New table: `allowances`

```ts
// src/db/schema/allowances.ts
export const allowances = sqliteTable(
  'allowances',
  {
    id: idColumn(),

    /** 'daily' | 'weekly' | 'monthly' — the cadence money arrives on. */
    period: text('period').notNull().$type<AllowancePeriod>(),

    amountMinor: moneyMinorColumn('amount_minor').notNull(),
    currency: currencyColumn(),

    /** Inclusive local calendar date this amount starts applying. */
    effectiveFrom: dateColumn('effective_from').notNull(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('allowances_period_check', t.period, ALLOWANCE_PERIOD_VALUES),
    currencyCheck('allowances_currency_check', t.currency),
    positiveAmountCheck('allowances_amount_minor_check', t.amountMinor),
    isoDateCheck('allowances_effective_from_check', t.effectiveFrom),

    // §A2: partial, so a deleted allowance does not keep owning its slot.
    uniqueIndex('allowances_period_effective_from_unq')
      .on(t.period, t.effectiveFrom)
      .where(liveRows()),
    index('allowances_effective_from_idx').on(t.effectiveFrom).where(liveRows()),
  ],
);
```

Plus `allowances_live` in `views.ts`, and `ALLOWANCE_PERIOD_VALUES` in `enums.ts`.

### 3.2 Why a table and not an `app_settings` key

Because an allowance has history, and history must not be rewritten.

Store it as a single setting and this happens: in September you budget ₱10,000 and come in
₱800 under. In October you raise it to ₱12,000. Now September says you were ₱2,800 under —
a month you already lived through, restated by a number you changed afterwards. Every
report the app has ever shown for September becomes retroactively false.

A row per change, resolved by `effective_from`, makes the past immutable with no sweep, no
migration, and no background job:

```sql
SELECT * FROM allowances_live
 WHERE period = :period AND effective_from <= :periodStart
 ORDER BY effective_from DESC
 LIMIT 1;
```

`:periodStart` is the first day of the period being asked about — so *"what was my
allowance in February?"* is answered by the row that was in force in February, forever.

Note the ordering: `effective_from DESC`, not `created_at`. This is the T2 lesson from
`plan/phase2-3-remediation.md` — ordering a `LIMIT 1` by a column that does not move
returns the wrong row.

### 3.3 One cadence at a time

The user sets **one** allowance at **one** cadence. The other two views are *derived*, not
stored:

```
₱15,000 monthly  →  ~₱500 / day  ·  ~₱3,500 / week   (pace, not budgets)
```

Setting a weekly *and* a monthly allowance raises a question with no good answer — which
one is "remaining"? — so the schema permits rows of each period (history needs that when
you switch cadence) while the UI keeps exactly one cadence current. Switching cadence
writes a new row with today's period start as `effective_from`; the old cadence's rows stay
and keep answering questions about the past.

### 3.4 Currency

`currency` on the allowance must match the expenses it is compared against. MVP is PHP
only, so the comparison is guarded rather than converted: an allowance in one currency and
expenses in another produce "mixed currencies" copy, never a wrong subtraction. Same rule
the receipt totals already follow with their `primary` currency bucket.

---

## 4. The period engine

New file `src/features/allowance/period.ts` — **pure, no imports from `@/db`, no React
Native**, so `node --test` can run it directly. This is the single riskiest file in the
phase, and it is the one with the most tests.

```ts
export interface PeriodRange {
  readonly period: AllowancePeriod;
  readonly startIso: string;   // YYYY-MM-DD, inclusive
  readonly endIso: string;     // YYYY-MM-DD, inclusive
  readonly totalDays: number;
  readonly elapsedDays: number;  // including today, 1-based
}

export function currentPeriod(period: AllowancePeriod, now?: Date): PeriodRange;
export function periodContaining(period: AllowancePeriod, iso: string): PeriodRange;
```

Rules, each of which is a bug this repo has already paid for once:

- **Local, always.** Boundaries come from `todayCalendarString()` and calendar arithmetic
  on `YYYY-MM-DD`, never `new Date(iso)` (UTC midnight, wrong day in PH) and never
  SQLite's `date('now')` (UTC, flips a day early in Manila). The type-aware lint rule
  rejects the first; code review rejects the second.
- **Weeks start Monday.** One exported constant `WEEK_STARTS_ON = 1`, so a future
  "week starts Sunday" setting is a one-line change and not a search.
- **Month end is the real month end.** 28 / 29 / 30 / 31, derived, never assumed.
  February 2028 is a leap month and the tests say so.
- **`endIso` is inclusive** and every query that uses it says `BETWEEN :start AND :end`.
  Half-open ranges and inclusive ranges in the same codebase is how a day goes missing.

---

## 5. Queries

### 5.1 Spend within a period — almost free

`selectReceiptTotalsByCurrency` already accepts a date-range filter. The period query is
that call with `from: startIso, to: endIso`. No new SQL shape, no new index — the existing
partial index `receipts_purchase_date_idx` covers it.

### 5.2 The one summary object

```ts
export interface AllowanceStatus {
  readonly period: PeriodRange;
  readonly allowanceMinor: MinorUnits | null;   // null = none set yet
  readonly spentMinor: MinorUnits;
  readonly remainingMinor: MinorUnits;          // negative when overspent
  readonly currency: string;
  readonly mixedCurrencies: boolean;
  readonly expenseCount: number;
}
```

**One function computes this, and every surface reads it.** Home band, Money tab card and
the allowance screen must never each do their own arithmetic — two answers to one question
is how a dashboard starts lying (the same argument `enums.ts` makes about `overdue` not
being a stored status).

Overspend is a negative `remainingMinor`, formatted at the UI edge as **"₱420 over"** in
`theme.status.danger` — never a minus sign in front of a peso amount, which reads as a
refund.

---

## 6. UI

### 6.1 Rename: Receipts → Expenses

UI and routes; the table keeps its name.

| Touches | |
| --- | --- |
| Routes | `src/app/receipts/**` → `src/app/expenses/**` (5 files) |
| Push sites | `router.push('/receipts…')` — Money tab, Home, add sheet, capture, form |
| Copy | "Receipts" → "Expenses", "5 receipts" → "5 expenses", search placeholder |
| Kept as-is | `src/features/receipts/**`, `receipts` table, `receipts_live`, every test |

Keeping the feature directory and table named `receipts` is deliberate: renaming the data
layer would mean regenerating migrations for a cosmetic change, and migrations are the one
thing in this repo that must never be rewritten. The seam is the barrel export.

The photo stops being the headline: the `+` opens the form with the **amount field
focused**, and "Add photo" is a row inside it. Capture stays reachable, one tap away, for
the case it was built for — a paper receipt you want kept.

### 6.2 New screen: `/allowance`

- Cadence selector — Daily · Weekly · Monthly (segmented, three options, all visible;
  **not** a `SelectField`, which is the primitive that shipped unable to display its
  options at all).
- Amount field, money-typed, minor units.
- Derived pace line: *"About ₱500 a day."*
- Effective-from, defaulting to the start of the current period, with plain-language
  copy: *"Applies from Sep 1. August is unchanged."*
- History list — every past allowance and the period it covered. This is the visible
  payoff of §3.2 and the reason the table exists.

### 6.3 The allowance card

One component, three placements, one data source:

```text
┌────────────────────────────────────────┐
│  September                    12 days  │
│                                        │
│  ₱10,409                     of ₱15,000│
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░  31%   │
│                                        │
│  left to spend            ₱347 a day   │
└────────────────────────────────────────┘
```

- **Home**, above "This month" — the first thing you see.
- **Money tab**, above the three ledger rows.
- **Expenses list**, as the header where "What you have kept" is today.

States that must all be designed, not discovered: no allowance set · allowance set with
zero spend · normal · **overspent** · mixed currencies · period boundary (day 1 of a new
period, where "31%" of nothing must not divide by zero).

The meter is monochrome with the rest of the design system; the overspend state is the
one place status colour enters, via `theme.status`, never a raw hex.

### 6.4 Expenses list

Grouped by day with a per-day subtotal — *"Yesterday · ₱612"* — which is what makes a
daily allowance legible without arithmetic. Group headers are rendered inside the same
virtualized `<List/>`, never a `ScrollView` of sections: this is the list most likely to
reach a thousand rows.

### 6.5 Money tab — the Bills row is correct, leave it

An earlier draft of this plan called the Bills row's **"Coming next"** stale, on the
strength of `HANDOFF.md` listing Bills as complete. It is not stale. Bills has a data
layer, validation, SQL and notifications — and **no UI whatsoever**: there is no
`src/features/bills/ui` and no `src/app/bills`. The row has nowhere to lead, and
`available: false` is the honest state. Building those screens is its own piece of work,
not a line change, and it is not in this phase.

---

## 7. Notifications — deliberately not in this phase

An "80% of your allowance" nudge is the obvious next thing and it is not here. `§8` scopes
local notifications to *dated* things — bills, renewals, expiry — all of which schedule
against a known future date. A spend threshold has no date; it fires when a write happens,
which means either a background task (there is none, by design) or a check on write, which
can only notify you while you are already looking at the app.

Left out on purpose. Revisit after the allowance has been lived with for a period.

---

## 8. Tests

Every one mutation-verified — break it, watch it go red, restore. Four tests in this repo
once passed against deliberately broken code, which is why that rule exists.

| File | Covers |
| --- | --- |
| `tests/allowance-period.test.ts` | Boundaries in the same ten timezones `format-dates` uses (UTC, Manila, Kiritimati +14, Pago Pago −11, Kathmandu +05:45, Chatham +12:45, LA, NY, London, Sydney), both US DST transitions, "now" pinned at local 00:00 **and** 23:59, month ends 28/29/30/31, Feb 2028, the Monday/Sunday seam, a week spanning a month end, a week spanning a year end. |
| `tests/allowance-resolution.test.ts` | `effective_from` picks the row in force; a raise recorded today does not change last month; ordering by `effective_from` and not `created_at`; no allowance at all; a cadence switch mid-history. |
| `tests/allowance-status.test.ts` | Remaining arithmetic in minor units; exact-zero remaining; overspend; day 1 of a period (no divide-by-zero); mixed currencies refusing to subtract. |
| `tests/migration-sql.test.ts` (extend) | The new CHECKs, the **partial** unique index (insert, soft-delete, re-insert the same period+date — must succeed), `allowances_live` hiding tombstones. |
| `tests/receipts-queries.test.ts` (extend) | The period-ranged totals select from `receipts_live`, and `BETWEEN` is inclusive at both ends. |

Then the thing tests cannot do: render every state of the allowance card in both themes,
in the simulator, and look at it. Green tests caught none of the three worst bugs this
project has had.

---

## 9. Risks

1. **Timezones.** Period boundaries are precisely the class of bug that has already bitten
   this repo. Mitigated by the pure period module and the ten-timezone suite — which must
   be written *before* the SQL that consumes it.
2. **Two sources of truth for "remaining".** Prevented by §5.2: one function, three
   call sites.
3. **The rename leaving a dead route.** `tsc` catches typed pushes; a string literal in a
   `params` object is the one that gets through. Grep for `'/receipts` after the move.
4. **Building on unrendered screens.** See the caveat in §1. Phase 4's visual pass first.
5. **Backup.** Phase 8's export bundle must include `allowances`, or a restore returns a
   user's expenses without the budget they were measured against. Add it to the Phase 8
   checklist now, while it is cheap.
6. **Logging.** An allowance is an amount. `src/lib/log.ts` is an allowlist, so it is
   redacted by default — the risk is only a new `SAFE_KEYS` entry added carelessly.

---

## 10. Sequencing

The app stays runnable and green after every step.

| Step | Work | Done when |
| --- | --- | --- |
| ~~**0**~~ | ~~*Phase 4 visual pass* (pre-existing, blocking)~~ | **Done** — list, detail (with and without a photo), edit, new, capture rendered; screenshots `plan/screenshots/18-*`. Findings in §12. Camera preview and permission-denial remain unverifiable on the simulator. |
| ~~**9a**~~ | ~~`period.ts` + its tests~~ | **Done** — 22 tests across ten timezones, six mutations verified red. |
| ~~**9b**~~ | ~~Schema, migration, `allowances_live`, queries, `AllowanceStatus`~~ | **Done** — migration `0001_furry_boom_boom.sql`, 50 tests, thirteen mutations verified red. Applied on the device and confirmed by querying `sqlite_master`. |
| ~~**9c**~~ | ~~`/allowance` screen~~ | **Done** — cadence, amount, effective-from, history. Set ₱15,000 monthly on the device and it survives a cold boot. Both themes. |
| ~~**9d**~~ | ~~Allowance card; Home and Money placements~~ | **Done** — five of six states seen on the device (no-allowance, normal, overspent, loading, weekly-with-no-allowance). Mixed-currency is covered by tests only: the MVP is PHP-only, so it cannot be reached through the UI. |
| ~~**9e**~~ | ~~Expenses rename, day grouping, amount-focused quick add~~ | **Done** — routes moved to `src/app/expenses`, `grep "'/receipts"` is empty, day headers carry per-day totals, the form opens on the amount. The Bills row was left alone; see §6.5. |
| ~~**9f**~~ | ~~Visual sweep~~ | **Done** — both themes for the allowance screen, Home and the Expenses list; 14 screenshots at `plan/screenshots/19-*`. **Not covered:** the empty-database first-run state (this device has data, and clearing it means a Keychain reset), and the mixed-currency card (unreachable in a PHP-only MVP). |

Rough shape: 9a–9b is the careful half, 9c–9e the visible half, and the whole thing is
smaller than Phase 4 was because the ledger already exists.

### Where it slots

Recommend **before Phase 5 (Vehicles)** — it is what was asked for, and Vehicles adds a
second expense ledger that will want the same period arithmetic. Phase 8 (Backup) remains
the one that is scheduled last and load-bearing: right now, lose the phone, lose the data.

---

## 11. Not in this phase

Per-category budgets · envelope budgeting · income tracking or net balance · recurring
allowance auto-top-up · spend forecasting · charts (the meter is the only visual) ·
rollover (settled: resets) · bills and subscriptions drawing down the allowance
(settled: they do not) · spend notifications (§7) · multi-currency conversion.


---

## 12. What the Phase 4 visual pass found

Step 0, run 2026-09-03. Screenshots in `plan/screenshots/18-*`. The list, both detail
states, the edit form and the capture screen all render correctly in both themes; the
photo-less detail shows "No photo attached" with an icon, exactly as designed. Four things
are worth acting on, and all four are in this phase's path.

1. **The Notes card says "Notes" twice.** Section header "Notes", then a row labelled
   "Notes", then the value. Visible on every receipt that has notes. Cosmetic, one line.
2. **The empty photo well is ~250pt of nothing.** On a receipt with no photo, a quarter of
   the screen is an empty rounded rectangle pushing the amount and date below it. Fine
   while a receipt is a photo; wrong once an expense usually has none. It should collapse
   to a slim "Add photo" row when empty — §6.1's reordering, applied to the detail screen
   as well as the form.
3. **The new-expense form is photo-first, and the title scrolls away.** The photo well plus
   "Take a photo" and "Choose from library" fill the entire first screen; Amount — the only
   required field — sits at the fold, and because it auto-focuses, the keyboard opens and
   scrolls the screen title off the top entirely. The user sees a cut-off grey rectangle
   with no heading. This is precisely what §6.1 changes, and it is a Phase 4 defect on its
   own terms.
4. ~~**The Money tab still says Bills — "Coming next"**~~ — **withdrawn, this was wrong.**
   Bills has a data layer but no UI at all (no `src/features/bills/ui`, no `src/app/bills`),
   so the row has nowhere to lead and "Coming next" is accurate. See §6.5.

Not verified, and not verifiable here: the camera preview is a blank rectangle on the
simulator because there is no camera, and the permission-denied path never triggered
because permission was already settled. Both need a device or a keychain reset.


---

## 13. What the build actually found

Everything below was found by rendering the screen, not by a test. All are fixed.

| Where | What was wrong |
| --- | --- |
| Allowance card | The card's "₱535.71 a day" (what is left, over the days left) sat six rows above the form's "About ₱500.00 a day" (the flat pace). Both correct, neither labelled — the card appeared to contradict itself. The card now says "a day **from here**". |
| Allowance card | The overspend said "over" twice, stacked: once beside the figure and once beneath it, and dropped the one piece of context an overspend needs. Now "₱1,030.50 **of ₱15,000** / over your allowance". |
| Allowance card header | The doc comment claimed the overspent state was "the single place colour enters". It is not: `danger` is `#FFFFFF` on dark and `#000000` on light — maximum contrast, not red, about six values from `text`. Corrected, and the state is carried by the words. |
| Home | The card was the only block on the screen with no section header, so it read as part of the subscriptions group above it. Given one. |
| Home | With the header added, `ListBlock`'s default `section` gap stacked on the header's own `layout.heading` gap — the 40pt-of-dead-space bug, again. `gap="none"`. |
| Expenses list | The first day-grouping attempt put each subtotal *below* its day, where it sat between two cards and read as a heading for the wrong one. It is a day **header** now, and the rows no longer repeat the date it carries. |
| Expense detail | A photo-less expense opened on 250pt of empty rounded rectangle saying "No photo attached", with a note further down saying the same thing in words — the amount was below the fold. The well is not drawn when there is no photo. |
| Expense detail | "Notes" printed twice, one under the other (section header + row label). Worse, the note rendered in a `<Row/>`, whose subtitle is `numberOfLines={2}` — **any note longer than two lines was silently truncated with no way to read it**. Notes are prose now. |
| Expense form | Photo-first: the well and two photo buttons filled the entire first screen, the required amount sat at the fold, and because it auto-focuses the keyboard opened and scrolled the title off the top. Amount and merchant come first; the photo section follows. |

And one thing that was NOT wrong, reported as a bug and withdrawn: the Money tab's
Bills row. See §6.5.


---

## 14. Filtering and sorting

Added after the phase closed, on request.

**Expenses** — the sheet is now "Filter and sort":

| Control | Options |
| --- | --- |
| Sort by | Date (newest first) · Amount (largest first) · Name (A–Z) |
| Photo | Any · With photo · No photo — `hasImage`, which the data layer already supported and nothing exposed |
| Category, Purchase date range, Amount range | unchanged |

**Subscriptions** — sort joins the existing category filter in the same sheet (Due · Amount ·
Name). It went there rather than the header, which already carries a search field and the
active/paused control; a third row would push the subscriptions themselves below the fold on
every visit. `CategorySheet` takes `sort`/`onChangeSort` as OPTIONAL props, so the add/edit
form that shares the component is untouched.

### Two decisions

**Sort is not a filter.** It changes the ORDER of what matched, never what matched. So it is
excluded from `activeFilterCount()` (the badge would claim rows are hidden when none are),
excluded from `isFiltered()` (which picks the empty state's wording), and **"Clear all
filters" leaves it alone** — resetting the order someone chose because they cleared a
category answers a question nobody asked.

**Day grouping is gated on date order, and this is a correctness fix, not a preference.**
`groupByDay()` collects *consecutive* runs of one date. Sorted by amount, one day's expenses
scatter down the list, and each run would carry a partial sum wearing that day's date — not a
smaller total, a wrong one, and indistinguishable from a right one.

Verified by running it: sorted by amount, **Sep 3 appears at row 1 and again at row 5**, with
Sep 2, Aug 20 and Aug 29 in between. Grouping switches off, every row gets its own date back,
and the sort control's helper says it will happen before the user changes the order
(`plan/screenshots/21-expenses-sorted-amount-dark.png`).


---

## 15. The filter controls, restyled

`SegmentedField` gained a `variant`, rather than changing everywhere it is used.

| Variant | Where | Looks like |
| --- | --- | --- |
| `'segmented'` (default) | Allowance cadence, subscription billing cycle | Filled track, inverted selection — a **field**, among other fields |
| `'underline'` | Expenses Sort by · Photo, Subscriptions Show, Subscriptions sheet Sort by | A row of plain labels, a 2pt rule under the selected one. Nothing boxed, nothing filled |

### Why a variant and not a global change

Six usages, and they split two-and-four. The two are form fields: a billing cycle and an
allowance cadence are **values being set on a record**, and they sit among `TextField`s and
`DateField`s where a bare row of words reads as unlabelled and unfinished. The four are
filters — **which of the same things to look at** — which is what tabs mean everywhere else.

Styled the wrong way round, a form field says "switch view" when it means "choose a value",
and a filter claims to be data the user typed.

### Selection still survives greyscale

The design system is monochrome, so a selected state cannot lean on hue. The segmented
variant inverts. The underline variant carries **three** cues at once: the 2pt rule, a weight
change (`bodyStrong` against `body`), and full-strength ink against `textSecondary`. The rule
is a child of the segment rather than a border on it, so it is as wide as the *label* and not
as the label plus its 44pt touch padding.

Touch targets are unchanged at 44pt in both variants; only the drawing differs.

### The sheet

The subtitle is gone. It read "Every filter and the order are applied by the database on this
device" — true, and reassurance worth giving once, not every time someone changes a sort. Two
wrapped lines of it sat above the first control and pushed the whole sheet down; removing it
brings two more filter groups onto the first screen.

Screenshots: `plan/screenshots/22-*`, both themes.


---

## 16. Reminders became editable (§8, §15)

The four rows under More stated the defaults and could not change them. Their own footnote
said so — *"Editing the defaults arrives with settings persistence."* Persistence arrived
several phases ago; this is the editing.

New screen `/reminders`, reached from all four rows:

- **Bills · Subscription renewals · Document expiry** — five switches each (same day, 1, 3, 7,
  30 days before). Turning them all off is a valid answer and the section says "Off" rather
  than keeping a hidden default.
- **Delivered at** — the 24 local hours.
- **A permission banner**, above the controls, when iOS will not deliver. Without it every
  control on the screen is theatre: the preference saves, the queue rebuilds, and nothing
  arrives. The action is a prompt while the OS will still show one, and Settings once it will
  not — iOS shows its dialog exactly once, ever.

Nothing in the data layer changed. `toggleReminderLeadTime()` already wrote the preference,
`persist()` already saved it, and `REMINDER_AFFECTING_KEYS` already triggered
`syncAllReminders()` — the OS queue holds absolute instants, not a rule, so a changed lead time
reaches nobody until the queue is rebuilt.

### The bug this screen exposed — a lost setting

**`persist()` was fire-and-forget, so two quick writes could land out of order and the older
one could win.**

Observed on the device: toggling `30-days` then `same-day` left the store holding
`[same-day, 1-day, 3-days, 30-days]` while the database kept `[1-day, 3-days, 30-days]`. The
switch showed on. The next cold boot showed it off. Nothing errored, nothing logged — the
setting was simply gone.

It had always been reachable through the appearance and currency controls, but this screen
puts **fifteen switches in one scrolling list**, which makes tapping two in quick succession
completely ordinary.

Fixed with a write queue in `src/stores/settings-store.ts`: each write waits for the one
before it, so the last call still wins and wins with the newest value. It stays
fire-and-forget from the caller's side, so no screen got slower.

Verified: four rapid toggles across two different settings, then a cold boot — memory and disk
agree exactly. The same sequence lost a value before the fix.

Screenshots: `plan/screenshots/23-*`.


## 17. The reminders screen could not scroll — and the fix was to need less of it

**The bug.** `Screen`'s `scroll` prop defaults to `false` and the first version did not pass
it. Everything below the third section — including the delivery hour — was unreachable. The
tell was in my own verification: I "checked" the hour picker by temporarily deleting two
sections instead of scrolling to it, which should have said the screen does not scroll.

`scroll` is now on, and the comment at the call site says it is on for large text sizes rather
than because the content happens not to fit. A settings screen must never hold a control the
user cannot physically reach.

**The redesign.** Making it scrollable would have left a screen twice as tall as the phone:
fifteen `SwitchField` rows, about 1,400pt on an 874pt display. Chips instead — one wrapping
row of five per record kind — and the whole screen now fits with the delivery hour and the
footnote visible at once, at roughly a fifth of the height.

A switch is the right control for one independent setting and the wrong one for a SET. "How
much warning do I want?" is a question about a shape, and a column of switches makes you
assemble that shape one row at a time; five chips on a line answer it at a glance, and put the
three record kinds close enough together to compare.

### New primitive: `ChipField`

The design system had `SegmentedField` and `SelectField`, both "which ONE?", and nothing for
"which of these?". `ChipField` is that, reusing the pill/outline/inverted-fill language
`DateField` already draws for its date presets — a component now, instead of a fourth copy.

### Two things the render pass caught

1. **The fifth chip orphaned onto its own line** in every group. Chip padding was `space.md`;
   at `space.sm` with an `xs` gap all five fit.
2. **Selection changed the label's WEIGHT, so it changed the chip's WIDTH.** A wrapping row
   therefore reflowed as you tapped — choosing "1 day" could push "30 days" onto the next
   line, moving a chip you were aiming at. Weight is now constant and the fill alone carries
   the state, which is what `SegmentedField`'s own header argues for ("one device: the fill").
   `SegmentedField` can bold safely because each segment is a fixed share of a fixed track; a
   chip is as wide as its own label.

Before and after: `plan/screenshots/24-reminders-BEFORE-switches-dark.png` against
`24-reminders-chips-dark.png`.
