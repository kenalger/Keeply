# Phase 3c — Bills, the screens

**Status: done.** Written 2026-09-04. The data layer landed in Phase 3 and sat
unreachable for five phases; this is the UI over it.

Bills had the largest amount of finished, tested work in the repo that nobody
could open: CRUD, payment history, derived overdue, ledger-anchored recurrence
roll-forward, reminders, `bills-*.test.ts` — and no `src/features/bills/ui`,
no `src/app/bills`, and a Money tab row that said "Coming next".

---

## 1. What was built

| | |
| --- | --- |
| `src/features/bills/ui/labels.ts` | Category labels and icons, cycle copy, the due countdown, the state→token map. Pure. |
| `src/features/bills/ui/messages.ts` | `BillError` → a sentence a person can act on. Pure. |
| `src/features/bills/ui/hooks.ts` | List, totals, one record, the payment ledger, upcoming. Revision-driven. |
| `src/features/bills/ui/mutations.ts` | The writes, each publishing staleness. |
| `src/features/bills/ui/draft.ts` | Draft provenance (T1). Pure. |
| `src/features/bills/ui/bill-form.tsx` | Add / edit. |
| `src/features/bills/ui/filter-sheet.tsx` | §23 category filter and sort. |
| `src/stores/bill-draft-store.ts` | Half-finished forms, outside the React tree. |
| `src/app/bills/{_layout,index,new}.tsx`, `src/app/bills/[id]/{index,edit}.tsx` | The screens. |

Money's bills row now carries `billTotals()` and leads to the list.

---

## 2. The decisions worth keeping

### The amount is optional, and that is the whole of §7

Every other money form in this app refuses to save without a number. This one
must not. §7's variable bill — electricity, water, a phone bill — is one the
user *cannot* estimate, and forcing a figure makes them invent one. An invented
₱1,500 is worse than a blank, because it then feeds the totals and the
reminders as though it were real.

So `amountMinor` is `MinorUnits | null` end to end, and every screen that
renders one has to answer "what if there isn't one":

- a list row and the detail card show **an em dash**, never `₱0.00` — zero is a
  specific false claim about an electricity bill, the dash says "not known" in
  the width a number would have taken;
- `billTotals()` reports `unknownAmountCount` and the list says it out loud,
  because a total that quietly omits a bill is worse than one that admits it;
- "The amount varies" is a first-class switch, and turning it on changes what
  the amount field *claims*: "Amount" becomes "Expected amount".

### Paying is not a switch on the edit form

Settling a period writes a ledger row, moves the due date to the next
occurrence and re-schedules the reminder — one `payBill()` transaction. A
"paid" toggle on the form would offer a second, lossy way to do it that skips
the ledger and leaves the due date behind. Paying happens on the detail screen,
against the period, which is what a payment belongs to.

**The roll-forward is announced.** After paying, the record the user was
looking at shows a different date. Without a sentence about it that reads as
the tap having gone to the wrong bill, so `rolledForward` and `previousDueDate`
become "Meralco is settled for September 30. The next one is due October 30."

### `repeat` is reserved

The icon set has no droplet and no handset. The first draft gave `phone` the
`repeat` glyph — which is *Subscriptions'* own mark, on the tab row and on
every subscription row. A Globe Postpaid row and a Netflix row became
indistinguishable at a glance. Two rules now, pinned by a test:

1. no glyph may mean two things — `repeat` belongs to `subscription` alone;
2. a wrong-but-specific glyph is worse than a generic one, so `water` and
   `phone` take `tag` rather than something confidently unrelated.

### Draft provenance matters more here than it did for subscriptions

T1 again, but the sequence is ordinary rather than contrived. A subscription's
record only moves when the user edits it; a **bill's record moves on its own** —
`payBill()` advances `dueDate` and flips `status`, and it is reachable from the
list, the detail screen and the Money tab. So:

```
open the edit form, get distracted, go back
mark the bill paid from the list          (dueDate: Oct 12 -> Nov 12)
open the edit form again, change the name, save
```

Without provenance that save writes `dueDate: Oct 12` back, un-rolling the
period the user just settled and leaving a ledger row for a period the bill is
waiting on again. `pickDraft()` compares `basedOnUpdatedAt` and drops the stale
draft.

### The list is opened to find out what is late

Not "what do I pay" — that is the Money tab's question. So the default sort is
by due date with overdue first, and **the overdue count is in the header even
when the filter is hiding it**: a bills list that says nothing about three late
payments because the user happened to be looking at "Paid" is the one failure
this screen cannot have.

### The status tokens already existed

`billStatusKey()` maps onto `theme.status`' own keys — `overdue`, `dueToday`,
`upcoming`, `paid` — rather than a new success/danger/warning vocabulary. A
late bill and an expired document should be the same red, and they are only the
same red if they ask for the same token. The first draft invented four new
names; `StatusPill` refused them at the type level, which is the design system
working.

### One fix outside the UI

`src/features/bills/index.ts`'s notification port was a bare pass-through, so
every `ScheduleResult` a bill write produced was discarded. `/reminders` renders
exactly what that result carries — permission state, pending count, the 60-slot
horizon — so its figures were stale until the next `syncAllReminders()`. The
port now calls `noteScheduleResult`, which is what subscriptions does at its own
notification boundary.

---

## 3. Tests

54 new, in `tests/bills-labels.test.ts`, `bills-messages.test.ts` and
`bills-draft.test.ts`. **932 total, all green.**

The UI layer is testable at all because `labels.ts` imports `@/theme/format`
rather than `@/theme` (the barrel exports `ThemeProvider`, which reaches
react-native) and `messages.ts` imports `../types` and `../validation` rather
than the `@/features/bills` barrel (which binds statements to op-sqlite). The
existing `bills-*.test.ts` files already reach for deep paths for the same
reason.

Thirteen mutations were verified red. Two found real gaps rather than confirming
existing cover:

- **`bundleIsEmpty` had no per-kind test** (found during Phase 8c, same
  session) — dropping one `+` from a sum left the suite green.
- **`DRAFT_FIELDS` was validated by a test that iterated it.** Removing
  `dueDate` from the list changed nothing, because the loop simply stopped
  checking it. The assertion now derives the expected set from the draft
  object's own keys, so a missing entry fails.

---

## 4. Verified on the device

Driven over CDP against the dev client on `BC119EA8`.

| Check | Result |
| --- | --- |
| Money tab | Bills row live: "3 unpaid · ₱6,199.50", chevron, opens the list |
| List | Totals card, state filter, three bills, "Estimated" captions on the variable ones |
| Detail | Expected ₱3,500 with the estimate caveat, period facts, empty-history copy |
| Mark paid (variable) | Recorded ₱4,120.75; rolled Sep 30 → Oct 30; status back to unpaid |
| Ledger | Newest first, expected ₱3,500 against actual ₱4,120.75 / ₱2,980.50 |
| Undo | Rewound Dec 30 → Nov 30, removed the row, `lastPaid` fell back to the previous period |
| `nothing-to-unpay` | Refused on a bill with no history |

**Not verified:** anything requiring a tap. The simulator reports zero windows
to System Events, so the `Alert` confirmations on Mark paid, Undo and Delete
were exercised through the mutation layer they call, not through the dialog.
The dialogs themselves are unrendered.

---

## 5. Left open

- **Editing a recorded payment.** `saveBillPaymentEdit()` and
  `deleteBillPayment()` are wired and exported, and the `anchor-row` refusal has
  its sentence, but no screen calls them — a ledger row is not tappable yet.
  That is the natural next slice: the detail screen already has the rows.
- **`useAsyncRead` is now duplicated five times** (subscriptions, receipts,
  allowance, maintenance, bills). It was duplicated four times before this
  phase; extracting it is a worthwhile cleanup across all five at once, not a
  change to smuggle into one of them.
- **Bills are not on Home.** `useUpcomingBills()` exists and is exported for it.
