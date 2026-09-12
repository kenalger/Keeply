# Phase 6 — Documents

**Status: planned 2026-09-12, built in the same session.** The last unbuilt record kind, and the
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

| Step | Work | Done when |
| --- | --- | --- |
| **6a** | Data layer: types, sql, validation, queries, the expiry ladder | Tested against a real migrated database, timezone-swept, mutation-verified |
| **6b** | File layer: store / unlink / exists for images and PDFs | A picked file survives a cold boot; a missing one renders "unavailable", never a crash |
| **6c** | Screens: the tab becomes the list, plus add / detail / edit | Rendered on the device, every bucket visible |
| **6d** | Wiring: Home's expiring section, the reminder queue, the reminder preview | A document reminder is actually scheduled; three placeholders deleted |

---

## 4. Not in this phase

Multi-page documents · OCR or any extraction (§36 — and it would need a network or a model) ·
sharing a document out of the app · document categories beyond §14's eight · reminders per document
(`ReminderEntity.leadTimes` is honoured by the planner but nothing in the app writes one, and that
is still true after this phase — see CLAUDE.md's convention list).
