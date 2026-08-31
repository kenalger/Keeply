# Phase 2 — Subscriptions

Goal: a user can add, edit, pause and delete a subscription, see normalized monthly/yearly totals,
and get a local reminder before each renewal. All offline.

Phase 1 shipped an app you cannot put data into — there are no input primitives. So Phase 2 opens
with the entry layer, which every remaining phase also needs.

## Round 1 — three parallel tracks

### A. Form primitives + Sheet  → `src/components/ui/**`
The design system has `FieldLabel`/`HelperText`/`ErrorText` and no inputs. Build:

`TextField` · `AmountField` · `DateField` · `SelectField` · `SegmentedField` · `SwitchField`
`Sheet` (bottom sheet) · `FormScreen` · `FormSection` · `FormActions`

**`AmountField` is the important one.** It takes and emits `MinorUnits` from `@/db` — never a float,
never a formatted string. The user types "1,499.50", the field emits `149950`. Parsing happens once,
at this boundary, so no float can reach the data layer (§30, and the audit's 100× finding).

§28 sets the bar: a common record created in **under 20 seconds**. That is a keyboard-type decision on
every field, a sane default on every field, and field order matching how a person actually reads a
subscription off a bank statement.

### B. Recurrence engine + subscription queries  → `src/lib/recurrence.ts`, `src/features/subscriptions/**`

```ts
// src/lib/recurrence.ts — pure, no DB, no React
nextOccurrence(fromISO, cycle, customDays?): string
advanceToFuture(fromISO, cycle, customDays?, todayISO?): string
monthlyEquivalentMinor(amountMinor, cycle, customDays?): MinorUnits
yearlyEquivalentMinor(amountMinor, cycle, customDays?): MinorUnits
```

Recurrence is where date bugs live. Monthly from **Jan 31** must resolve deterministically; Feb 29 must
not throw; a cycle must never silently drift. `tests/recurrence-boundaries.test.ts` already pins these
with a reference implementation — repoint it at the real module.

Queries read `live.*` views, never base tables, and aggregate **in SQL**:

```ts
listSubscriptions(filter)      getSubscription(id)      createSubscription(input)
updateSubscription(id, patch)  setActive(id, active)    softDeleteSubscription(id)
subscriptionTotals()           upcomingRenewals(withinDays)
```

`₱12,000/year` displays a `₱1,000/month` equivalent (§6). Normalize in integer minor units and state
the rounding rule — 12,000 does not divide evenly by every cycle.

### C. Local notifications  → `src/lib/notifications.ts`

```ts
getPermissionStatus()  requestPermission()  scheduleRemindersFor(entity)
cancelRemindersFor(entityId)  rescheduleAll()
```

Device-local only, no server (§8). Lead times: same day / 1 / 3 / 7 / 30 days, global default with a
per-item override. Reschedule when a record changes, cancel when it is deleted or paused.

**A denied permission must never break the feature** — the subscription still saves, the reminder
just doesn't fire, and the UI says so honestly with a route to Settings. Android Doze and exact-alarm
limits are real; verify what SDK 57 actually guarantees rather than assuming.

## Round 2 — the feature, once the tracks land

Subscription list (search, category filter, active/inactive), add/edit form, detail view with
pause/resume/delete, the §28 add-item flow behind Home's "Add your first record", and Home's
`useDashboardData()` seam wired to real queries — replacing the hardcoded `EMPTY_DASHBOARD`.

## Definition of done

Airplane mode throughout. Add a subscription in under 20 seconds. Monthly and yearly totals correct
across mixed cycles. A renewal reminder fires locally. Pausing stops both the total and the reminder.
Deleting soft-deletes, and the row leaves every view and every total. `tsc`, `lint`, `test` clean.
