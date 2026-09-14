# Phase 5 — Maintenance (replaces "Vehicles")

**Status: COMPLETE — 5a–5e.** Items, costs, services, renewals, analytics, screens, and reminders (`575aac3`, `17d1d03`). Written 2026-09-03, from: *"instead of vehicles, make it maintenance. because
it's maintenance but not focus on 1 field. let's add more, like what more requires maintenance."*

This supersedes `plan/phases.md` → "Phase 5 — Vehicles", and knowingly diverges from `goal.md`
§11–§13, which scope the domain to cars and motorcycles. The divergence is recorded in §7.

---

## 1. Why this is cheap to do now, and would not have been later

Phase 5 was never built. There is **no `src/features/vehicles`, no `src/app/vehicles` routes, and
no data** — only five empty tables created by migration `0000` and a placeholder tab.

So the schema can be reshaped properly rather than bolted onto. Had this arrived after Phase 5
shipped, the honest options would have been a second parallel ledger (the mistake §2 of the
expenses plan argues against) or a data migration of live records.

---

## 2. Decisions, locked

Answered 2026-09-03.

| Decision | Choice |
| --- | --- |
| Covers | **Vehicles · Appliances · Home & property · Electronics & devices** |
| Vehicle extras | **Kept, but only for vehicles.** Odometer, fuel efficiency and cost-per-km appear on a vehicle and nowhere else. |
| Tracks | **Service history + next due · Warranty expiry · Insurance & registration renewal · Running cost totals** |

### One ledger, a `kind` discriminator

The same argument the expenses plan makes. A separate `appliances` table beside `vehicles` means
two of every query, two totals, two reminder paths, and a permanent question at the point of entry.
An aircon and a motorcycle differ in *which fields are filled in*, not in what they are: a thing you
own, that costs money, that needs doing again.

Vehicle-only columns are nullable and only a vehicle's form offers them — exactly how
`local_image_uri` is nullable on an expense.

---

## 3. Schema: five vehicle tables become four general ones

| Was | Becomes | Change |
| --- | --- | --- |
| `vehicles` | `maintenance_items` | `type` → `kind` over four categories; `plate_number` → `identifier` (a plate OR a serial number — both sensitive); gains `purchase_date`; `current_mileage` stays, vehicles only |
| `vehicle_expenses` | `maintenance_costs` | `type` widens: fuel · service · repair · parts · insurance · registration · other |
| `vehicle_maintenance` | `maintenance_services` | unchanged in shape — a job done, and when the next one is due by date and by mileage |
| `vehicle_insurance` + `vehicle_registration` | `maintenance_renewals` | **merged.** Both were "a dated thing that expires and must be renewed", with a provider and a reference number. `kind` (insurance · registration · warranty) is the only thing that differed — and warranty, which the user asked for, is the same shape again |

Merging insurance and registration is the part worth defending: they were two tables with the same
six columns and different names. Warranty would have been a third. One table with a `kind` is one
expiry query, one reminder path, and one screen.

### Sensitive fields

`identifier` holds a plate number **or** a serial number. Both are §10 sensitive: masked in the UI
(`maskIdentifier`), never logged, never searched against — the same treatment `plate_number` had,
now applied to serials too, which is arguably more important since a serial is a warranty key.

---

## 4. What is vehicle-only, and how the app knows

`kind === 'vehicle'` gates exactly three things:

1. **Odometer fields** on the item and on a cost/service row.
2. **`next_service_mileage`** — "next due at 45,000 km".
3. **Fuel-efficiency and cost-per-km analytics**, which need litres and distance.

Everything else — service history, next-due dates, warranty, renewals, running totals — is identical
for an aircon and a car. A form asks for a plate and a mileage only when the kind is `vehicle`; an
appliance's form is shorter and has no empty vehicle fields staring at it.

---

## 5. Reminders

`maintenance_services.next_service_date` and `maintenance_renewals.expiry_date` are both dated
future events, which is exactly what §8's scheduler already handles. `notification_settings`'
`entity_type` still enumerates `vehicle_insurance`, `vehicle_registration` and
`vehicle_maintenance`. Those collapse to `maintenance_service` and `maintenance_renewal` — but
**not yet**: changing that CHECK breaks the dependent view under drizzle-kit's table rebuild.
See §9, and step 5e.

The reminders screen (§16 of the Phase 9 plan) gains a fourth section, and its lead times work the
same way.

---

## 6. Steps

| Step | Work | Done when |
| --- | --- | --- |
| ~~**5a**~~ | ~~Schema + migrations, `*_live` views, enums, tests~~ | **Done.** Migrations `0002` (drops) + `0003` (creates) applied on the device and confirmed by querying `sqlite_master`: four tables, four views, every index, and zero `vehicle*` objects left. 55 migration tests, four mutations verified red. |
| ~~**5b**~~ | ~~Data layer~~ | **Done.** Items in 5b; costs, services and renewals in 5c. |
| ~~**5c**~~ | ~~Costs, services and renewals: data layer, analytics and screens~~ | **Done.** 63 tests (30 records · 24 analytics · 9 litres), 20 mutations verified red. Rendered and driven on the device — see §11. |
| ~~**5d**~~ | ~~Screens~~ | **Done** — the tab IS the list (grouped by kind, searchable, filterable), plus add / detail / edit. Verified on the device: one item of each kind added, survives a cold boot. `plan/screenshots/26-*`. |

The **tab itself is already renamed** — label, wrench icon, empty state and the "what Keeply
tracks" list all describe the wider domain (`plan/screenshots/25-maintenance-tab-dark.png`). It
was part of 5a because leaving a tab called "Vehicles" over a maintenance schema is the kind of
drift that outlives the person who caused it.
| ~~**5e**~~ | ~~Reminders (incl. the deferred `entity_type` rename, §9)~~ | **Done.** A fourth reminder kind; `drizzle/0004` hand-authored with the view dance §9 predicted. 19 tests, 14 mutations red. Home and Money wiring NOT done — see §12. |

---

## 7. Where this leaves `goal.md`

§11–§13 describe a vehicle expense tracker and are now narrower than the product. They are not
edited — the spec is a record of what was asked for at the time, and rewriting it would erase the
decision. This file is the amendment, and `plan/phases.md` points here.

What survives from §11–§13 unchanged: the field list, the "never display a full plate
unnecessarily" rule, the five expense types (widened, not replaced), and every analytic — now scoped
to vehicles rather than assumed for everything.

---

## 8. Not in this phase

Photos of an item (a receipt for the service already carries one, via Expenses) · barcode or serial
scanning · manufacturer service schedules · parts inventory · anything that would need a network to
look up a model.


---

## 9. Two things the build turned up

### drizzle-kit cannot generate this in one step

Renaming five tables to four differently-shaped ones makes drizzle-kit ask, interactively, whether
each drop/create pair is a rename — and it needs a TTY, which this environment does not have.

Split into two unambiguous diffs instead: `0002` removes the vehicle tables and views, `0003` adds
the maintenance ones. That is also the more honest record of what happened — these are not renames,
the columns differ substantially, and the tables were empty.

### drizzle-kit's table rebuild breaks dependent views

The first attempt also renamed `notification_settings.entity_type`'s CHECK values from
`vehicle_insurance` / `vehicle_registration` / `vehicle_maintenance` to `maintenance_service` /
`maintenance_renewal`. SQLite cannot ALTER a CHECK, so drizzle-kit rebuilds the table — create new,
copy rows, drop old, rename — **without dropping the dependent `notification_settings_live` view
first**. The rename then fails:

```
error in view notification_settings_live: no such table: main.notification_settings
```

No code reads those values yet (grep: zero hits outside the enum), so the rename is deferred to step
5e, when reminders are actually wired and the view can be dropped and recreated around the rebuild in
one deliberate change. The reason is written at the enum.

**This will bite again** for any future CHECK change on a table that has a `*_live` view — which is
every table in this schema. Worth knowing before the next one.


---

## 10. Adding an item — what shipped

The tab is the list, so there is no landing screen in front of it. Two ways in: the **+** in the
header, or the empty state's button.

The form asks for **a kind and a name, and nothing else is required**. Everything else can be
filled in later from the detail screen — a form that demands a serial number before it will save
is a form people abandon, and the point of the record is the history you attach to it.

### The form changes shape with the kind

This is the whole reason one table with a `kind` beat two tables. Choose **Vehicle** and a
Vehicle section appears with a type and an odometer, and the identifier field is labelled "Plate
number". Choose **Appliance** and that section is GONE — not disabled, not greyed — and the
identifier becomes "Serial number".

`validateNewItem` and `validateItemPatch` enforce the same rule at the boundary: a non-vehicle's
`vehicleType` and `currentMileage` are **nulled, not refused**. Refusing would strand someone who
filled in a car and then changed the kind. Verified on the device — an appliance sent
`currentMileage: 5000` came back with `null`.

### What the build found

- **The detail screen printed `car`**, the stored enum, where it meant "Car". `VEHICLE_TYPE_LABELS`
  exists precisely so a screen never invents or leaks the schema's words; the row now reads through
  it, and being exhaustive it makes a new vehicle type a compile error rather than a lowercase slug.
- **The vehicle type control truncated to "Motorc…"**. Four options with "Motorcycle" among them is
  exactly the case `SegmentedField`'s own header warns about — *"past four options, or with labels
  longer than a word or two … `SelectField` is the right control"*. Taking the design system's
  advice rather than shortening the word.

### Still not addable *(closed by 5c — see §11)*

Costs, services and renewals. The detail screen says "Nothing recorded against it yet" rather than
showing a stubbed section — a "Coming soon" on a record someone just created is a promise made at
the worst possible moment.

---

## 11. What 5c built, and the decisions inside it

`4f48c95` (data layer) and `1924cd5` (screens). The tab called Maintenance can now record
maintenance.

### One ledger, written from three screens

A service's price and a renewal's premium are **not** columns on those tables. They are
`maintenance_costs` rows created in the same transaction and linked by `cost_id` — the §A3 rule the
schema header already stated, now actually exercised. `itemTotals()` stays a single `sum()` that
cannot double-count, and the user types the amount once, on the form they were already standing on.

The consequence is deliberate: **the detail record owns its cost row.**

| The user does | What happens to the ledger row |
| --- | --- |
| Types an amount on a service | Created, typed `service`, dated and shopped to match |
| Moves the service's date, shop or odometer | Moved with it |
| Clears the amount | Deleted — an ABSENT price, never ₱0 |
| Deletes the service | Deleted with it |
| Deletes the cost from the ledger itself | Survives as a service with no price |
| Then types an amount again | A **new** row — see below |

That last one is the trap. A soft delete cannot fire `ON DELETE SET NULL`, so `cost_id` still names
a tombstone; `updateCost` carries `WHERE deleted_at IS NULL`, so updating it matches zero rows and
the amount the user just typed vanishes with nothing failing. `liveCostId()` re-reads before
deciding, which turns that into "there is no cost here, write a new one". All six rows were driven
end to end on the device, not only under `node:sqlite`.

### Cost-per-kilometre measures the odometer's window, not the ledger's

The distance is the span of the odometer over the cost rows that carry one, and the numerator
is every cost dated inside **that same window**. (`max - min` is what this said until §13 found what
it does to a car whose instrument cluster was replaced; it is now the endpoints of the latest
monotonic run.) Dividing the all-time total by the measured distance
was the obvious alternative and is wrong: it charges kilometres nobody measured with pesos somebody
spent, so the rate falls every time a reading is recorded, for no reason the user did anything about.

The window's dates and distance come back with the rate, so the screen states them rather than
presenting a bare number. A service recorded with an odometer widens the window, because its linked
cost row carries the reading — which is how a service contributes without being entered twice.

`costPerKmMinor` sits beside the exact `costPerKm` because `<Amount/>` takes `MinorUnits`, and a
screen that rounds it itself has to cast past the brand that exists to prevent exactly that (§30).

### Fuel efficiency is the one analytic that is not SQL

Every other analytic is a fold over a set, which SQLite does better. This one is a walk along an
ordered sequence with a window whose ends are chosen by a predicate — expressible in SQL, and
expressible as something nobody could review. It lives in `computeFuelEfficiency()` with four named
ways to have nothing to say, driven by literal arrays.

The measurement runs from the first full tank to the last and counts the fuel put in **after** the
opening one. Including the opening tank's litres is the classic off-by-one that makes a car look
thirstier by exactly one tankful; the fixture that catches it is four elements long, and the mutation
was verified red.

Rows are ordered by **odometer**, not date: the reading is what the distance is measured with, and a
receipt found in a glovebox belongs where its odometer says it does.

### A gap is a named reason, never a blank

`AnalyticsGap` has seven values and `ANALYTICS_GAP_MESSAGES` turns each into one sentence saying what
to record next. Every owner is in one of those states for weeks, and a panel that simply disappears
cannot tell anyone what the missing ingredient is.

### Litres, and a claim that was withdrawn

`fuel_liters_milli` is an INTEGER a division reads, so a float there does not merely look wrong — the
row fails `typeof = 'integer'` in `selectFuelFills`, silently leaves the measurement, and the km/L
figure changes with nothing saying why. `parseLitres()` is digit-string arithmetic, like centavos.

The header originally claimed `Math.round(x * 1000)` gives wrong answers. **It does not**, at this
magnitude — a mutation swapping the methods survived the whole suite. The comment now says so, and
gives the real reason: the rounding version is correct only *because* the accepted range is narrow,
and a range is exactly the sort of thing a later change widens. Those bounds now have a test of their
own, so widening them is a decision rather than a one-character edit.

### Two things only the render found

Neither was visible from the test suite.

- **Every add form logged an error on open.** One route serves add and edit, keyed by an optional id,
  and a hook cannot be called conditionally — so the add path read id `''`, failed as `not-found`,
  and `log.error` counted it in LogBox. *An absent id means "adding", not "missing".*
- **`<Section/>` is still a dashboard heading.** `4ecb864` made `FormSection` and `ListSectionHeader`
  quiet eyebrows and left `Section` at 17pt primary — reasonably, since `Section` is the unit Home is
  built from. A detail screen with six of them reads as six equally loud slabs, the exact failure that
  commit describes. This screen uses `ListSectionHeader`, as bills' detail screen already did.
  **Anything that is not a dashboard should do the same.**

### Not in 5c

Reminders (step 5e, which still drags the `notification_settings.entity_type` rename and its
view-drop dance), Home and Money wiring, and per-item cost charts. The `dueNext()` read 5e needs is
built and tested.

---

## 12. What 5e built

`575aac3` (the reminder kind and the rename) and `17d1d03` (the maintenance side).

### One kind, two dated things

A service falling due and cover expiring share a lead-time setting but not an
identity. The reminder id is the **service or renewal ROW's** id, never the
item's: `cancelRemindersFor()` matches on it, and a car with a service due plus
three renewals expiring must not have cancelling one cancel all four.

One kind rather than two because a user thinking "remind me about the car" is
not thinking about which of them is due, and a settings screen with five kinds
on it is one nobody finishes reading. The body carries a single verb and the
projector composes a title that reads under it — "Oil change and filter for Vios
is due in 3 days", "Insurance for Vios is due in 7 days". Not `${item} ${label}`:
"Vios Oil change and filter" reads like a typo, and the fix is *not* to
lower-case the user's own words (§8's rule, which exists because it turns
"SSS ID" into "sss id").

### Both sources accumulate; only the latest is a deadline

A car serviced every six months has six service rows; a policy renewed three
times has three. The queries narrow to the item's latest service and the latest
renewal **of each kind** — taking the max across all renewals would report
insurance and lose the registration expiring a fortnight sooner. Reminding
someone about an oil change they had two years ago is the most annoying thing
this feature could do, and the kind of bug that makes people turn notifications
off rather than report them.

A retired item does not remind. The history stays — it is why the user knows the
last one lasted three years — but a sold car must not keep asking to be serviced.

### A chain link that says nothing is not the end of the chain

An audit found `selectNextService` took the newest service row outright, so
fitting **wiper blades** after an oil change made the oil change's "next due
1 March" vanish from the detail screen. The brand-new `selectRemindableServices`
had inherited the same hole within the hour, which would have cancelled the
reminder too. "Latest" now means *latest that names a next service*.

### The rename drizzle-kit cannot generate

§9 predicted, a month in advance, that renaming `entity_type`'s CHECK values
would fail with `error in view notification_settings_live: no such table`. It
was generated, run, and failed with exactly that.

`drizzle/0004` is therefore **hand-authored** — the only migration in this
project that is — and says so at length at the top. Two extra statements: drop
the view before the rebuild, recreate it after. The snapshot is untouched and
still correct, because it describes the END state.

Two values replaced three: `maintenance_renewals` already merged insurance and
registration into one table with its own `kind`, so a third entity type would be
a distinction the schema no longer makes.

### Not in 5e

**Home and Money wiring.** `remindableMaintenance()` is built and tested and
nothing outside the reminder queue and the settings preview reads it. Home has
no "due for service" section, and Money does not show what maintenance is
costing this month. That is the natural next slice for this domain.

---

## 13. The odometer regression

A QA audit fed the analytics four readings from one car — `120000`, `121000`, `0`, `500` — the
shape an instrument cluster leaves behind when it is replaced. `max - min` reported **121,000 km**
for a car that had done about 1,500, and the fuel walk, which ordered fills by odometer, printed
**`1008.3 km/L`**. Both stated it as fact. Nothing was flagged, because nothing had been asked.

### Accept the reading, narrow the measurement

The alternative was to refuse the entry: reject a reading lower than the one before it. That makes
the app refuse the truth. A cluster swap is real, a corrected typo is real, and the user is the one
holding the car — an app that argues with the dashboard is wrong more often than it is right.

So the reading is always accepted, and the **measurement** is what gets narrowed.
`latestMonotonicRun()` (`src/features/maintenance/odometer.ts`) sorts readings by date, cuts the
sequence wherever the odometer goes backwards, and returns only the last segment. Distance comes
from that segment's endpoints; the fuel walk runs inside it. Four readings become a run of two, and
the answers become 500 km and a number a car could actually achieve.

### By date, not by odometer

Sorting by odometer was the old fuel walk's ordering, chosen so a backdated glovebox receipt landed
where its reading said. Across a reset it interleaves two different meters into one nonsense
sequence — that is the mechanism that produced 1008.3. Date is the truth about *sequence*; the
odometer is the truth about *distance within a run*, and inside a run the two agree.

The cost of this is honest and small: **a backdated receipt whose reading contradicts its date now
stops the measurement** rather than being silently re-sorted into agreement. A genuine glovebox
receipt — older date, lower reading — still slots in and changes nothing, because it is monotonic.
Contradictory data (40,400 km in August, 40,000 in September) is data the app cannot reconcile, and
`tests/maintenance-analytics.test.ts` now pins both halves of that.

### The screen says so

`AnalyticsGap` gained `'reset-odometer'`, and when a run is not the whole history both
cost-per-km and km/L carry `afterReset: true`. The detail screen prefixes their subtitles with
`since the odometer reset`, so a figure that covers less than the user expects explains itself
instead of looking wrong.

### What no test can prove

`selectOdometerReadings` and `selectFuelFills` both `ORDER BY "cost_date" ASC, "id" ASC`, and
`latestMonotonicRun()` sorts by date itself — so a mutation putting the SQL back to
`ORDER BY odometer` leaves the whole suite green. It was tried; it survived. The ORDER BY stays for
determinism (two identical calls, two identical arrays) and is written down at both sites as not
load-bearing, the same treatment `extensionOfUri`'s redundant guard got. Seven of the eight
mutations in this area do fail a test, and each names one.

---

## 14. Three findings from the audits, and what each cost

The odometer regression (§13) was the one with a product decision in it. These three were smaller
but each one was wrong in a way the app stated confidently.

### A message that named a variable

Typing a decimal into a field labelled **Litres** answered:

```
fuelLitersMilli must be a whole number
```

Three generic helpers in `maintenance/validation.ts` and two in `documents/validation.ts` were
interpolating the field KEY into the sentence, while every hand-written message beside them was
already plain English. Maintenance and Documents render `error.message` directly under the input
that `error.field` names — unlike Bills, which has a `ui/messages.ts` and whose data-layer message
is explicitly developer-facing — so whatever the validator wrote was what the user read.

The message does not need the name, because the form has already put it under the right input. And
it cannot have it: `identifier` is labelled "Plate number" or "Serial number" depending on the
item's kind, so there is no fixed map from key to label at that layer. `counter()` also split into
three branches on the way — a fraction, a negative and an over-large value are three different
mistakes and now say so.

`tests/validation-messages.test.ts` drives every validator with bad input and rejects any message
containing a camelCase token or its own field key. Grepping for `` `${field}` `` would have passed
the day someone wrote `` `${name} is too long` ``.

### A total that counted what it had not added

`itemTotals()` summed ONE currency and counted ALL of them, so three ₱ costs and two $ costs
rendered as **"₱5,000.00 across 5 entries"**. There is no exchange rate on this device and no way
to get one (§1), so the answer is not to add them.

`costCount`, `damagedCount` and `otherCurrencyCount` now partition the ledger — every cost row is in
exactly one, and their sum equals `listCosts().total`, which a test asserts against a figure counted
by a different query. The card says what is not in the figure: *"2 entries in USD are not in this
total."* `describeSpend()` makes that decision, pure, because making it inline in the screen is what
produced the bug.

One honest wart, now written at the SQL: the primary currency is `ORDER BY total_minor DESC`, which
compares minor units across currencies (¥5000 outranks ₱1.00). It is a heuristic for "the currency
this item is mostly recorded in" and it never makes a total wrong — every total is reported with
its own currency.

### A search that stopped at z

`LIKE` folds case for ASCII and only ASCII, and `lower()` folds only ASCII too — so
`lower(x) LIKE lower(?)`, which Documents and Maintenance both used, was an elaborate way of writing
a plain `LIKE`. A receipt from `MUÑOZ MARKET` was not found by `muñoz`. No error, no hint, just a
row that was not there — the failure shape that makes someone believe the app lost their data.
Parañaque and Las Piñas are cities of about a million people each.

The usual fix is a `*_folded` column written by the app, because JavaScript knows Unicode and SQLite
does not. That is a migration on five tables, a second copy of every searchable string on disk, and
a write path that rots silently the day a patch updates `name` without refreshing the copy.

`GLOB` takes character classes and compares them by code point, which `LIKE` does not — so
`*[mM][uU][ñÑ][oO][zZ]*` works with no schema change and no write path at all. `src/lib/search.ts`
folds the needle in JavaScript and emits the pattern; all five features call it. `GLOB` has no
`ESCAPE` clause, so its three metacharacters are escaped as classes of their own (`[*]`, `[?]`,
`[[]`). The query plan is unchanged: `GLOB '*x*'` scans exactly as `LIKE '%x%'` did.

Two things this deliberately does not do. A letter whose other case is two characters (`ß` →
`SS`) stays literal, because `[ßSS]` is a class of three that matches one — a wrong answer is worse
than a missed one. And a term over 2,000 characters is truncated rather than thrown: SQLite refuses
a pattern over 50,000, and a truncated pattern returns a superset, which is a far better failure for
a search box than an exception.

The test that mattered most was the one that nearly did not exist. `globContains('🚗')` proves
nothing about how the string is walked — a surrogate half has no case and is not a metacharacter, so
splitting the pair and rejoining it returns the same text. A mutation to `.split('')` survived until
a **cased** astral character (Deseret U+10400/U+10428) was added at both the pattern level and
against real SQLite.

### What running it found that reading it did not

The three fixes above were verified on the simulator against op-sqlite's SQLCipher build, which is
a different SQLite from the `node:sqlite` the suite uses — `GLOB` folding `[ñÑ]` by code point was
a prediction until then. It holds: `muñoz` and `MUÑOZ` both find `MUÑOZ MARKET`, `PARAÑAQUE` finds
`Parañaque`, `škoda` finds `ŠKODA`, ASCII is unchanged, and a typed `*` matches only itself.

The spend card rendered as designed. One card lower, the screen showed **`2026` twice** under a red
*"Encountered two children with the same key"* toast. `selectTotalsByYear` groups by year AND
currency — it has to — so an item with ₱ and $ costs in one year returns two rows, and the screen
used the year as both the React key and the title. Unreachable until an item has two currencies,
which is the case the card above it had just been fixed for. `describeYearRows()` keys on
year-plus-currency and appends the currency to the subtitle only where a year repeats; a
single-currency item, which is nearly all of them, is not captioned with a code already beside the
amount.

`byType` has the same shape — grouped by type AND currency — and no consumer. Whoever renders it
needs the same key.


---

## 15. Home and Money

The wiring §12 left open. `remindableMaintenance()` was built, tested and read by nothing outside
the reminder queue; the Vehicle line on Home's "This month" card had been structurally zero since
Phase 2.

### The Vehicle line

`maintenanceTotals(fromISO, toISO)` is the one read in this feature that spans every item rather
than one. Three decisions in a small query:

**No `item_id`, no join to the item, no `is_active`.** A retired car's September fuel is still money
that left the account in September. `is_active` decides whether something asks to be *serviced*; it
is not a claim that its history did not happen. What IS excluded is a deleted item's costs, and that
exclusion belongs to the `*_live` view's live-parent rule rather than to anything this query says.

**`primary` is the DEFAULT currency, not the largest.** `byCurrency` is ordered by minor units
descending, so ₱1.00 and US$90.00 puts USD first — and taking the first row would hand Home 9,000
minor units of dollars, which `<Amount/>` renders under a peso sign as ₱90.00. A 90x error in the
wrong currency, stated as fact. It is zeroed rather than absent when there are no peso rows, because
Home renders four fixed buckets and a missing one collapses a row.

**Receipts categorised `vehicle` stay in "Other", and that is now a decision rather than an
oversight.** A receipt and a maintenance cost are different records in different tables. The one
thing a user can actually do wrong is enter the same purchase as both; today that lands once in
Other and once in Vehicle, where the two figures at least disagree visibly. Moving them would put
the same peso in the same line twice, which looks correct and is not. Re-bucketing receipts is a
receipts decision, and `receiptSums.byCategory` already has the numbers when it is made.

### Due for service

One section, holding services falling due and cover expiring, between Expiring documents and
Upcoming subscriptions. The late ones stay in it rather than moving to "Overdue": that section is
money owed, and a car whose service is a fortnight late is a different kind of late from a bill.
`attentionCount` counts them, so the header cannot say "all caught up" over a list of things that
are not.

The rows carry **no amount**, and `hasNoRecords` is what that broke: its money test could not see
them, so an install whose only record was a car with a service due reported "never recorded
anything" and got the first-run screen. The test for that is in `tests/dashboard-sections.test.ts`.

### Two words in two shapes

The first draft titled the row with `maintenanceReminderEntity().title` — the notification's whole
sentence — so that a lock screen and Home could never call the same thing by two different names.
On the device both rows truncated: *"Oil change and filter…"*, *"Insurance for Vios zz…"*.

A lock screen has no context and needs the sentence. A row under a "Due for service" header has a
subtitle. So `maintenanceDueLabel()` now exposes the *word* — "Oil change and filter", "Insurance" —
and the notification composes its sentence from it while the row puts the item in the subtitle. One
source for the wording, which is what actually had to be shared; two layouts, which never did.

### Home was watching two domains and reading five

Found while wiring this. `useDashboardData` re-read on the `subscriptions` and `receipts` revisions
only, so paying a bill, filing a document or recording a service left Home showing the state before
it until something unrelated happened to a subscription. Every read now has a watcher beside it.

### The pure half had to come out first

`attentionCount` forgetting a section is invisible in a screenshot and fatal to the point of the
screen — and no test could reach it, because importing `@/lib/dashboard` pulls in every feature
barrel and through them op-sqlite and expo-file-system, which `node --test` cannot load.

`src/lib/dashboard-shape.ts` now holds the types, the two dev fixtures, the three predicates and the
month arithmetic; `dashboard.ts` holds the hook and the reads and re-exports all of it, so screens
still import from one place. `monthBounds` came out with it and is now tested — it decides the
window for the receipt totals *and* the maintenance totals, and an off-by-one there makes both
figures quietly short by a day in a way that looks like the user simply spent less.

---

## 16. Scale: paging indexes, debounced search, data protection

Three asks — caching, rate limiting, encryption — and in an app with no server two of them mean
something different from what they mean in a web service. What each turned out to be:

### Caching → indexes, because the page was the cache miss

`EXPLAIN QUERY PLAN` over every list query in the app said `USE TEMP B-TREE FOR ORDER BY` for **all
fifteen of them**. SQLite can only walk an ORDER BY for free when an index matches it
column-for-column, direction-for-direction and collation-for-collation; otherwise it reads every
matching row, sorts the lot in a temporary B-tree, and throws all but the forty a page asked for
away. The answers were right. The cost grew with the table.

That is the worst shape a performance bug can have here: invisible on ten fixture rows, invisible in
every other test, and arriving years later as "it got slow" on the device holding the most data.

`drizzle/0005` adds seventeen partial `*_page_*_idx` indexes, one per ORDER BY a screen can ask for.
They are declared as `sql` fragments rather than `.on(t.column)` because the direction and the
collation are the entire point — an index on `name` cannot order `name COLLATE NOCASE`, and one on
`(purchase_date)` cannot resolve the tiebreakers after it. Two carry a leading expression,
`("expiry_date" is null) asc`, which is the nulls-LAST rule: SQLite puts NULLs first in an ASC index
and "no expiry" has to sort after every real date.

Measured through the real `selectReceipts`, page cost goes from growing to flat:

| rows | before | after |
| --- | --- | --- |
| 1,000 | 0.050 ms | 0.042 ms |
| 10,000 | 0.068 ms | 0.036 ms |
| 50,000 | 0.179 ms | 0.037 ms |

The absolute numbers are small today and that is the point — this is an asymptotic fix, not a
speed-up. What it trades is write time: a bulk insert of 50,000 rows goes 137 ms → 219 ms, and a
single insert 0.0039 ms → 0.0077 ms. For an app where a user records a few rows a day and a bulk
insert happens once, at restore, that is the right side of the trade.

`tests/query-plans.test.ts` is the guard, and it asserts the PLAN rather than a timing — a stopwatch
on fixture rows is a coin flip on CI and says nothing about a hundred thousand. Its second half
DROPS all seventeen indexes and asserts every plan goes back to sorting, which proves both that the
guard can fail and that no index in the set is dead weight.

Verified on the device against op-sqlite's own SQLCipher build, not just `node:sqlite`: migration
0005 applied to a database with data in it, all seventeen indexes exist, and
`SCAN receipts USING INDEX receipts_page_date_idx` is what the real engine reports.

### Rate limiting → debouncing the one read that cannot use an index

There is no network and no server, so the only thing worth limiting is work the app gives itself.
After 0005, **search is the only read left in the app that cannot use an index**: `GLOB '*term*'`
has no left anchor, so it reads every live row and always will. It was running on every keystroke —
a six-letter word cost six list queries and six counts, five of them already stale on arrival.
`useAsyncRead` discarded the stale results correctly; not running them is the fix.

`useDebounced` (200 ms) sits between the state and the query in all five search boxes. The field
stays bound to the raw value, so typing is instant. The empty-state predicates were moved onto the
debounced value too — "Nothing matches that search" against a search that has not run yet is a
screen contradicting itself for 200 ms. On the expenses screen ONLY `search` is debounced: a
category chip is a decision the user already made and applies on the tap.

Measured on the device by wrapping the store's `all()`:

| | queries | reads |
| --- | --- | --- |
| one settled change | 5 | 1 |
| 5 keystrokes, 80 ms apart (typing) | 5 | **1** |
| 5 keystrokes, 400 ms apart (deliberate) | 25 | 5 |

Which is the whole design: a pause means "I meant that", an inter-key gap does not.

### Encrypting → the database already was; the media was not

The database has been SQLCipher-encrypted with a device-bound Keychain key
(`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) since Phase 1, and the app-lock's attempt throttling is the OS's
own biometric lockout, which is the correct place for it — reimplementing either would be worse than
what is there. Neither needed work.

The gap was the **media**. Receipt photos, passport scans and IDs sat under iOS's default protection
class, `CompleteUntilFirstUserAuthentication`: encrypted at rest, but readable from the first unlock
after a reboot until the phone powers off.

`plugins/with-database-backup-exclusion.js` already runs Swift at launch against exactly that
directory for the backup exclusion, so the protection class is set in the same place, for the same
"before op-sqlite opens the file" reason. **Two different classes, deliberately:**

- The **database** directory gets `completeUnlessOpen`. Not `complete` — op-sqlite holds `keeply.db`
  open for the life of the process, and `complete` evicts the file key when the phone locks, so a
  user who locks their phone with Keeply backgrounded would come back to an I/O error from below
  SQLCipher with no useful message. `completeUnlessOpen` protects the file at rest and keeps an
  already-open handle alive across a lock, which is precisely this file's lifecycle.
- **Media sub-folders** get `complete`. Those files are opened on demand and closed again, never
  held, so the strongest class costs nothing and means a locked phone cannot be made to give up an
  ID photo even with the filesystem in hand.

Two honest limits, both written at the plugin. The media sub-folders are created by JavaScript, so
they are stamped on the *next* launch rather than the one that created them — media written today
inherits `completeUnlessOpen` from the parent until then, which is still stronger than the OS
default it replaces. And **none of this is verifiable on the simulator**, which stores protection
classes and never enforces them: a simulator test proves the attribute was set and nothing about
what it does. That one needs a physical device.
