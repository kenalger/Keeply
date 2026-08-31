# Phase 2 & 3 Remediation

From the adversarial audit of subscriptions, bills, notifications, settings, onboarding and the screens.
Ordered by user impact. `tsc` 0 / `eslint` 0 / 678 tests passing was true throughout — none of these are
caught by those three signals, which is the point.

Findings marked **[repro]** were executed against the committed migrations via `node:sqlite`.

---

## Tier 1 — data loss, or a number the user will act on

### T1. A cancelled edit comes back and overwrites the record
`subscription-form.tsx:196,202-205,399,409-413`

The draft is keyed on `record.id` and always beats the freshly-read record; `clear()` runs on **success
only**, and Cancel deliberately keeps the draft. Edit Netflix → set ₱5.00 → **Cancel** → reopen: the form
shows ₱5.00 as if it were real. Change only the name and Save, and because the patch sends all nine fields
unconditionally, ₱5.00 is written.

Worse: pause a subscription, then open Edit. The stale draft holds `isActive: true`, so any save silently
un-pauses it and re-schedules its reminders.

`clearSubscriptionDraft` has **zero call sites app-wide** — there is no discard path at all.
**Fix:** re-seed when `record.updatedAt` is newer than the draft, or key the draft on `updatedAt`.

### T2. Home's upcoming renewals goes empty at ~25 subscriptions **[repro]**
`subscriptions/sql.ts` (`selectRenewalCandidates`) + `dashboard.ts:326`

Candidates are narrowed by `next_billing_date <= horizon` — which *any* past anchor satisfies — then
`ORDER BY next_billing_date ASC LIMIT 24`. So the limit keeps the **oldest anchors**, exactly the ones
most likely to project outside the window and be discarded in JS afterwards.

30 yearly subscriptions anchored in 2025 plus one monthly renewing **tomorrow** → `upcomingRenewals(30,
{limit:24})` returns **0 rows**. The renewal due tomorrow is invisible on Home.

**Fix:** order by the *projected* date, or drop non-normalizable rows in SQL before the LIMIT.
No test exceeds the limit — the bug lives precisely in the untested region.

### T3. Deleting the oldest ledger row drifts the bill series forever **[repro]**
`bills/sql.ts` (`ANCHOR_DATE_SQL`), `bills/queries.ts:893-906`

The anchor is `min(bill_payments_live.due_date)`. Bill anchored Jan 31, paid twice (→ Mar 31). Delete the
January row as a suspected duplicate → anchor becomes Feb 28 → the next payment lands **Apr 28, not Apr 30**,
and the series is demoted to the 28th permanently. A test asserts the anchor moves; none asserts what the
next `payBill()` produces. No UI shows the anchor or warns before the delete, and there is no undo.

### T4. A backwards due-date edit makes a bill permanently un-payable and permanently overdue **[repro]**
`bills/queries.ts:456-463`, `bills/validation.ts:388-391`

`nextPeriodDue = advanceToFuture(anchor, …, dueDate + 1)`. When `dueDate + 1 <= anchor` it returns the
anchor itself — occurrence 0, already in the ledger. Edit a twice-paid bill's due date backwards and every
subsequent `payBill` returns `already-paid` while the bill sits overdue on the dashboard forever, with no
in-app recovery.
**Fix:** refuse a `dueDate` patch at or before the newest ledger period, or floor `nextPeriodDue` at it.

### T5. `updateBillPayment` can create two live rows for one period **[repro]**
`bills/validation.ts:504-509`

`countPaymentsForPeriod` exists because there is no unique index on `(bill_id, due_date)` — but it guards
only `payBill`. Editing a payment's date onto an existing period yields two live rows; monthly spending
double-counts that period silently.

### T6. `updateBill({status:'paid'})` produces a dead-end bill **[repro]**
`bills/validation.ts:412-414`

Paid with no ledger row: leaves every total, leaves `remindableBills`, never advances, and **both**
`payBill` (`already-paid`) and `unpayBill` (`nothing-to-unpay`) refuse.
**Fix:** a bill patch should refuse `'paid'` — settling a period is `payBill`'s job.

---

## Tier 2 — the retention engine is wired but never runs

### T7. `rescheduleAll()` has zero production call sites
`notifications.ts:611-670`; boot wiring `_layout.tsx:113-149`

Referenced only in comments and tests. `AfterBoot` hydrates settings, primes defaults, resolves the
onboarding gate, watches permission — and never rebuilds the queue. Three silent consequences:

- **The rolling window never rolls.** Past 60 reminders the deferred ones are queued only if the user
  happens to edit each record.
- **Denied → granted never recovers.** A denial cancels everything; flipping permission back on re-queues
  nothing. The user turns reminders on and never receives one.
- **Settings changes never reach the OS queue.** A new delivery hour or lead-time set leaves the old
  triggers in place.

This is the whole retention thesis in `plan/onboarding.md` §5. Without it Keeply is a spreadsheet you must
remember to open.

### T8. Bills schedule OS notifications inside the open catalogue transaction
`onboarding/index.ts:154`, `bills/index.ts:90`, `bills/queries.ts:411-415,575`

`billsApiFor(store, port = notifications)` — the default binds the **real** port, and onboarding passes only
the store. Inside `inCatalogTransaction` the post-write `syncReminder` therefore runs while SQLCipher's
single write lock is held: permission reads and N bridge calls per bill, up to 100 bills. The comment at
`queries.ts:411` asserts the opposite contract and is false on this path. If a later bill fails validation,
the transaction rolls back while **already-scheduled reminders stay in the OS queue** for records that were
never saved.

`billsApiFor(txStore, undefined)` will not fix it — the default re-substitutes. Pass an explicit no-op port.
**Why tests miss it:** the harness builds the API with no `notifications` key at all, so `syncReminder`
returns immediately — it differs from production in exactly the field that causes the bug.

### T9. `noteScheduleResult` leaves the permission slice half-updated
`notification-store.ts:206-214` — sets `permission`/`canDeliver` but not `canPrompt`/`mustUseSettings`,
yielding a "Turn on reminders" button that calls a function which short-circuits and shows no dialog.
Reuse `applyPermission()`.

### T10. `withTransaction`'s depth guard rejects *concurrent* transactions, not just nested ones
`db/client.ts:426,469-479` — `transactionDepth` is a module-level counter, not async-context-local, so any
second `withTransaction()` entered while the first awaits throws "cannot be nested" even though op-sqlite's
lock queue would have serialised them. T8 widens the window from microseconds to hundreds of milliseconds.
**Fix:** queue rather than throw, or make the guard per-async-context.

### T11. A negative device clock locks the user inside the wizard forever
`settings/keys.ts:212-215`, `onboarding/queries.ts:849-882` — every completion path carries a timestamp that
fails `integerSetting(…, 0, MAX)`. Steps advance, completion never writes, every launch re-enters the wizard:
the exact broken half-state F7 forbids. **Fix:** clamp, or let completion land without `completed_at`.

---

## Tier 3 — crashes and dead ends

### T12. One corrupt row bricks the feature, with a retry that can never succeed **[repro]**
`subscriptions/queries.ts:122`, `bills/queries.ts:217`, `subscriptions/index.tsx:317-329`

A float in `amount_minor` passes the `> 0` CHECK (SQLite is dynamically typed). Then `getBill`, `listBills`,
`billTotals`, `listSubscriptions` and `subscriptionTotals` **all throw** — and the totals die too, because
integer division over a real returns a real. The only affordance is "Try again", which re-runs the identical
query. No path to see, edit or delete the offending row.

The codebase is inconsistent: the dashboard *skips* unreadable rows ("one bad row must not blank the
dashboard") while the list throws — so the same row leaves Home working and the list dead. Pick one.

### T13. A read failure on the edit screen claims the record was deleted
`subscriptions/[id]/edit.tsx:28-51` — `status === 'error'` is never checked and `value` stays `null`, so a
thrown read renders *"This subscription is gone — it was deleted"* over a record that exists. The sibling
detail screen gets this right.

### T14. A totals read failure vanishes silently
`subscriptions/index.tsx:219-256` — `.status`/`.error` never read; the cost card is simply omitted.
`money.tsx:175-187` is the correct pattern.

---

## Tier 4 — the form layer

- **T15. Selection-delete errors and clears the committed amount.** `money-input.ts:254-281` recognises only
  single-character edits, so a multi-char delete is judged as a paste: `applyAmountEdit('1,234,567','1,2367')`
  → `ambiguous-separators`, `emit(null)`. `'1,234,567'→'1,567'` survives, so it fails *intermittently*.
- **T16. Save replaces an accurate parse error with a false one.** Any null amount gets "Enter an amount
  greater than zero", including one that is null because parsing failed. Same block wipes other field errors.
- **T17. No caret management in the amount field** — no `selection`/`onSelectionChange` anywhere in
  `components/ui`. Mid-string correction of an amount is effectively impossible. Needs a device to confirm.
- **T18. A resumed `'new'` draft saves a renewal date in the past** — computed once at mount, never re-derived.
- **T19. Pagination re-fetches every page from offset 0** — ~31,000 sequential round-trips across a 10,000-row
  scroll. Needs keyset pagination.
- **T20. "+N more" on Home undercounts past 24**, and there is no route from that section to a full list.

---

## Latent / lower

Currency errors render nowhere; `AmountField` ignores a currency change (a 100× misread the moment a second
currency exists); Home drops per-item currency; `refresh`/`prompt` set `busy` with no `finally`; two
diagnostic logs are redacted into uselessness; the onboarding records counter is bumped outside its
transaction; `openNotificationSettings` is not on the onboarding port, so a screen cannot act on
`mustUseSettings`; **reminder defaults are display-only — persistence shipped but nothing calls `update()`**,
so §8's global default is uneditable and More's footnote is stale; `currentMonth()` has no midnight
re-render trigger; segmented options are 38pt against a 44pt minimum; `<List/>` discards `previous.value` on
a refresh failure and blanks a populated list.

---

## Verified clean

The **recurrence engine** — no drift, non-termination or timezone dependence was constructible. The
**catalogue** (56 entries, no duplicate ids, no amount prefill, every category a real enum). The **settings
codecs** (every key round-trips; `Number('')` and `Number(' 9 ')` both closed). The **onboarding state
machine** (no stranding state constructible). **Virtualization** — every list is a `FlatList`. **Dashboard
aggregation** — three bounded parallel queries, no reduce/sort over rows, no N+1. **Privacy** — no name,
amount, note, path or URI reaches any log call; the notification payload is structural only. **`*_live`
views** — 24/24 SELECTs across all raw-SQL modules; base tables appear only in INSERT/UPDATE. **No
`new Date(<string>)` and zero network primitives anywhere in `src/`.**
