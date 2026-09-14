# Phase 6 — Documents

**Status: COMPLETE. 6a–6d built and rendered 2026-09-12** (`9780019`, `43afd97`, `0d8542f`, `fa6e73d`). The last unbuilt record kind, and the
only one the shipped app already makes a promise about and cannot keep: `/reminders/documents`
says *"Documents arrive in a later update."*

Implements `goal.md` §14 (the tracker), §15 (the expiry ladder and its alerts) and §16 (file
storage stays on the device).

---

## 1. What is already waiting for this

Unusually much. Phase 6 is less "build a domain" than "fill four holes that were cut to its shape".

| Already exists | Where |
| --- | --- |
| The table, its CHECKs, the `documents_live` view, both partial indexes | `src/db/schema/documents.ts`, migration `0000` |
| `DOCUMENT_TYPE_VALUES` — eight types | `src/db/schema/enums.ts` |
| `ReminderEntity` with `kind: 'document'`, and the "a deadline with no money" shape | `src/lib/notifications-plan.ts` |
| `documentReminderLeadTimes` and a whole settings screen editing them | `src/stores/settings-store.ts`, `src/app/reminders/[kind].tsx` |
| `ExpiringDocumentItem` and a Home slot hard-coded to `[]` | `src/lib/dashboard.ts:497` |
| `expired` / `expiringSoon` / `valid` status tokens, contrast-tested | `src/theme/palette.ts` |
| `maskIdentifier()` — `**** **** 1234` | `src/theme/format.ts` |
| A tab whose header comment names the function this phase replaces | `src/app/(tabs)/documents.tsx` |

So the work is a data layer, a file layer, screens, and **removing four placeholders** — each of
which is a small lie the app currently tells.

---

## 2. Decisions, locked

### An expiry date is OPTIONAL

A birth certificate does not expire. Neither does a diploma, a marriage certificate, or a TIN.
Forcing a date would make people invent one, and an invented date then fires a notification.

This is the same argument §7 makes for a bill's amount, and it gets the same treatment: the column
is nullable, screens render the absence rather than a placeholder, a document with no expiry sorts
**last**, never reminds, and is never counted in "expiring soon". The type list makes this concrete
— `government_id` and `certification` frequently have no expiry at all.

### One file per document, and no thumbnail

A passport scan is one file. A gallery would need an ordering, a cover, and a delete-one flow, for
a case (multi-page contracts) that §14's field list does not describe.

**And no thumbnail.** Receipts generate one because §33 is about a journal of 400 photos in a
virtualized list; a document list is tens of rows browsed by NAME and DATE, and the useful glyph on
a row is the document's type, not a grey rectangle of a passport page. Skipping it avoids either
duplicating `receipts/ui/storage.ts`'s hard-won `expo-image` decode trick or prematurely extracting
it from shipped, verified code. The detail screen shows the file full size.

The consequence, accepted: if documents later want thumbnails, the extraction happens then, with two
real callers to shape it.

### Images and PDFs, both local, both the same column

`local_file_uri` + `file_mime_type` are already in the schema. A scan is an image, a policy is often
a PDF, and both are "the bytes behind this record". `file_mime_type` is what the detail screen
branches on — an image renders, a PDF gets an icon and its filename.

Bytes live in `Keeply/documents/`, beside `Keeply/receipts/`, **under the same directory the backup
exclusion is stamped on** (§19/§A4). That is the whole reason receipts' folder is there and not in
`Documents`, and a passport scan is the most §10-sensitive file this app will ever hold.

### The document number is masked everywhere except one screen

`maskIdentifier()`, exactly as a plate or serial is treated in Maintenance — shown in full nowhere,
and the list and search never touch it (§14, §23). A search box that can match a passport number is
a way to probe for one.

### §15's ladder is a bucket function, not six queries

Expired · today · 7 · 30 · 60 · 90 · later · none. One pure function over a local calendar date,
tested across the ten timezones `format-dates` already uses — `new Date('2026-10-12')` is UTC
midnight and lands on the wrong day in PH time, which for a countdown is an off-by-one the user sees.

The list is GROUPED by bucket rather than filtered to one, because §15's value is the ladder itself:
"two expired, one this week, four this quarter" is the answer, and a filter chip would make the user
ask the question six times.

---

## 3. Steps

| Step | Work | Done |
| --- | --- | --- |
| ~~**6a**~~ | ~~Data layer + the expiry ladder~~ | **Done.** 42 tests, 17 mutations red. Ladder swept across ten timezones at local 00:00 and 23:59, both US DST transitions, a leap day. |
| ~~**6b**~~ | ~~File layer~~ | **Done.** 14 tests, 7 mutations red. Verified on the device: PDF/JPEG/PNG resolved, `.docx` refused, all landing in the backup-excluded directory. |
| ~~**6c**~~ | ~~Screens~~ | **Done.** 9 tests, 4 mutations red. All eight rungs rendered on the device. `plan/screenshots/43-*`. |
| ~~**6d**~~ | ~~Wiring~~ | **Done.** 4 tests, 3 mutations red. Five real document reminders in the OS queue; three placeholders deleted. |

---

## 4. Not in this phase

Multi-page documents · OCR or any extraction (§36 — and it would need a network or a model) ·
sharing a document out of the app · document categories beyond §14's eight · reminders per document
(`ReminderEntity.leadTimes` is honoured by the planner but nothing in the app writes one, and that
is still true after this phase — see CLAUDE.md's convention list).

---

## 5. What the build settled, and what it found

### The three decisions held

All three of §2's decisions survived contact with the code, and two of them
turned out to be load-bearing in ways the plan only half-anticipated.

**An optional expiry date** has *three* separate places to get quietly wrong,
not one. It sorts LAST (SQLite orders NULL first ascending, so "never expires"
would otherwise sit above a licence running out next month); it is not
"expiring within 30 days"; and it is never handed to the reminder queue. Each
has its own test, and `documentReminderEntity()` returns `null` rather than
inventing a date — a reminder about a deadline that does not exist is one the
user can do nothing about and cannot turn off except by deleting a record they
want to keep.

**No thumbnail** was right and cost nothing. The list is browsed by name and
expiry, the row's glyph is the document's type, and skipping it avoided both
duplicating receipts' `expo-image` decode trick and prematurely extracting it.

**The ladder as a bucket function** paid for itself immediately: the tab, the
detail screen's pill and Home's section all read the same eight rungs, and the
section list is derived from `EXPIRY_BUCKETS` so a rung cannot exist without a
section to render in.

### The one thing that HAD to be shared

`Library/Application Support/Keeply` — the directory the iOS backup exclusion
is stamped on. Receipts resolved it privately; documents needed the same
resolution, and a second copy is the one duplication in this codebase that
cannot be allowed. The attribute covers the subtree; a folder created anywhere
else is backed up to iCloud with **no error, no log line and no screen that
would show it**. §16 says a passport must not be uploaded to a backend, and a
nightly iCloud backup is a backend.

So `src/lib/private-directory.ts` owns it and both features ask for a
subfolder. Verified on disk, the way CLAUDE.md asks:

```
xattr -l "$C/Library/Application Support/Keeply"
  com.apple.metadata:com_apple_backup_excludeItem: com.apple.MobileBackup
ls "$C/Library/Application Support/Keeply/"
  documents  keeply.db  keeply.db-shm  keeply.db-wal  receipts
```

### §14 is enforced where it can be, not where it is convenient

The number is stored, shown masked on exactly one screen, and is a predicate in
no query. The list test asserts on the statement TEXT as well as behaviourally,
because an `OR document_number LIKE ?` bolted into the search builder would pass
every other test in the file. The reminder projector's test serialises the whole
entity and greps it, so a field added later cannot smuggle one onto a lock
screen. And the search box says "Document numbers are never searched" out loud —
the promise is otherwise invisible, and someone who types one deserves to know
it did nothing rather than conclude the search is broken.

### Four things only the render or a mutation found

- **"Driver's licence / Driver's licence".** The row subtitle is the type, and
  people name a passport "Passport" — the commonest row this list will ever draw
  was saying nothing twice. Omitted when the name already is the type.
- **A redundant guard in `extensionOfUri`.** A mutation proved no input could
  tell the explicit "a dot in a directory name is not an extension" check apart
  from the character class that already rejects it. The branch is gone; an
  untested branch that looks load-bearing is worse than a line of explanation.
- **A fixture that agreed with its own mutation.** "Order within a section is
  preserved" used ids `first`/`second`, which a sort by id reproduces exactly.
  The ids now run backwards against every obvious sort.
- **A projector test that never tested what it claimed.** No fixture set both
  an issue date and an expiry date, so `issueDate ?? expiryDate` sailed through.
  A reminder scheduled against an issue date fires years late, or never.

Two claims about SQLite were also corrected in passing: `PRAGMA writable_schema`
does **not** disable a CHECK (`ignore_check_constraints` does — the constraints
are a real backstop, and a damaged-row test has to work to get past them), and
`document_number` being *selected* is fine; what §14 forbids is matching on it.

## 6. Not in this phase, and now visible

- **Nothing opens a PDF.** An attached PDF gets a mark and a sentence. Nothing
  installed can render one, and adding a renderer is a native dependency.
- **The camera is wired but unexercised.** `useDocumentAttach` exposes
  `requestCamera` and `store`; no screen drives a viewfinder yet, because the
  simulator has no camera and receipts' capture screen is receipt-shaped.
  Choosing a photo and choosing a file both work.
- **Per-document reminder overrides still do not exist** — unchanged by this
  phase, and still true of every record kind.
- **`strayDocumentFiles()` has no caller.** It is offered for a deliberate
  cleanup, not a launch sweep: a sweep that runs at boot can delete a file a
  half-finished form is about to reference.

---

## The expiry prompt: three answers instead of an edit form

Before this, the only thing a user could do about an expired passport was tap the pencil and change
a date field. That is the right tool for "I typed the wrong year" and the wrong one for everything
that actually happens to an expired document — so opening one now asks, and the three answers are
the three real outcomes.

| Answer | What it does |
| --- | --- |
| **I've renewed it** | Opens a date field in the sheet, then moves the expiry and clears the prompt state |
| **Still sorting it out** | Records `in_progress` and goes quiet for 7 days. Still counted as expired everywhere — the user asked for time, not silence |
| **I don't need this any more** | Records `retired`. The row and its scan stay; only its DEADLINE retires |
| **Not now** | Records that this expiry was asked about, and claims nothing about the document |

### Asking once, with no flag to reset

`renewal_prompted_for` stores the **expiry date** the prompt was last opened for, not a boolean.
Renew the document and its `expiry_date` no longer equals that, so the next expiry asks again by
itself — nothing has to remember to clear anything, which is the failure a boolean would have.

After the prompt has been answered or dismissed it stops auto-opening, and a
*"What do you want to do?"* button takes its place on the expired card. "Not now" means not now.

### One suppression mechanism each, which a test had to teach me

The first version set `renewal_prompted_for` on **every** answer. That silently killed the feature it
had just promised: "ask me again in a week" would never fire, because `promptedFor` suppresses that
expiry *forever* and outlives any snooze. The test that caught it is the one asserting the two halves
of the module agree — a snooze that nothing reads back the same way is a snooze that does nothing.

So: dismissing is suppressed by `promptedFor`, being in progress by the snooze date, being retired by
the state. None of them shadows another.

### Retiring changes what other screens do, or it is a button that does nothing

`selectExpiring` and `selectExpirySummary` both exclude `renewal_state = 'retired'`. The summary's
`total` and `undated` deliberately do **not** — they answer "what do you have", and a retired
passport is still one you have. Only the two deadline counters drop it.

### The migration drizzle-kit could not generate, again

`drizzle/0006` is the **second** hand-authored migration in this project. The generated table rebuild
was broken three ways, each observed before the file was written: the copy `SELECT`s the new columns
from the old table (`no such column`), the `DROP VIEW` lands after the rename (§0004's trap, in the
same shape), and `0005`'s paging indexes come back with their whole SQL fragment quoted as one
identifier.

None of it was needed. `ALTER TABLE ADD COLUMN` takes a CHECK constraint — verified, the constraint
fires on a bad INSERT afterwards — fills existing rows from the DEFAULT, leaves every index alone and
never renames the table. The view is dropped and recreated only because its column list has to grow.
`ADD COLUMN` appends, so the schema declares the three columns after `deleted_at` to match.

---

## The migration runner was skipping by timestamp

Found while verifying the above on the device, and it is the most serious thing in this section.

`runMigrations` decided "already applied" by comparing each journal entry's `when` against the newest
`created_at` in `__drizzle_migrations` — a timestamp standing in for identity. Regenerating a
migration file gives its entry a **new** `when` while the database still holds the old one against
the same tag, so the entry stops looking applied, runs a second time, and dies on
`index ... already exists`. That rolls back **and aborts the loop**, so every later migration is
blocked too.

Exactly that happened: `0005` was regenerated during this work, re-ran, failed, and `0006` never got
the chance. **Nothing reported it.** The app kept working because `mapDocumentRow` tolerated the
missing column and returned `'none'` — so the screen looked right and the database was three columns
short. A write would have been the first thing to fail, in front of a user.

The fix is to skip by **tag**, which is what the table already records, what drizzle's own runner
compares, and the one thing that cannot drift. A tag in the database but not in this bundle is
ignored rather than fatal — that is a downgrade, and refusing to boot is a worse answer than running
what this build knows.

The decision moved to `src/db/migration-order.ts` so it could be tested at all: `migrate.ts` imports
the generated bundle, which imports `_journal.json`, which plain Node will not load. Deploying the
fix repaired the device by itself — `0006` applied on the next launch with nothing touched by hand.
