# Phase 5 — Maintenance (replaces "Vehicles")

**Status: 5a–5d done — you can record costs, services and renewals against an item, and see what it has cost. 5e (reminders) outstanding.** Written 2026-09-03, from: *"instead of vehicles, make it maintenance. because
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
| **5e** | Reminders section (incl. the deferred `entity_type` rename, §9); Home and Money wiring | Round trip by hand on the simulator |

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

The distance is `max(odometer) - min(odometer)` over the cost rows that carry one, and the numerator
is every cost dated inside **that same window**. Dividing the all-time total by the measured distance
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
