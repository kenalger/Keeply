# Phase 8 — Backup / Restore

**Status: complete. 8a–8e done, export and import both, verified on the device.**
Written 2026-09-03 after Phase 9 put real records in the app; 8c added 2026-09-04.

Why now rather than last: the database is deliberately excluded from iCloud backup (§19, §A4), which is
right for privacy and means a restored phone opens *clean* rather than bricked. The replacement safety
net is §20's user-driven encrypted export — and until it exists, **lose the phone, lose the data.**
That was tolerable while the app held test rows. It stopped being tolerable the moment an allowance and
a month of expenses went in.

---

## 1. The format: the bundle IS a SQLCipher database

Not JSON, not a zip, not a custom container. An export is a second SQLCipher database file, keyed with
the user's passphrase, written by SQLCipher's own `sqlcipher_export()`.

```sql
ATTACH DATABASE ? AS backup KEY ?;   -- the user's passphrase
SELECT sqlcipher_export('backup');
DETACH DATABASE backup;
```

### Why

- **The crypto is already here and already audited.** SQLCipher 4 derives the file key from the
  passphrase with PBKDF2-HMAC-SHA512 at 256,000 iterations and encrypts pages with AES-256-CBC. That is
  the same implementation protecting the live database on this device. Writing a bundle format on top
  of `expo-crypto` would mean hand-rolling a KDF and a cipher mode — `expo-crypto` offers hashing and
  random bytes and **no AES, no PBKDF2** — which is the worst kind of code to hand-roll.
- **No new dependency and no native rebuild.** Anything else (a JS AES library, a zip writer) is a new
  package, and anything native is `prebuild --clean` plus a 15-minute build.
- **The format is self-describing.** Import validation is `SELECT` statements against a real schema,
  not a parser over a blob. "Is this a Keeply backup?" is answerable; "is this bundle newer than this
  app?" is answerable from the migrations table it carries.
- **It round-trips exactly.** No serialiser to drift from the schema, no type coercion at the boundary,
  no `MinorUnits` becoming a float on the way through JSON.

### Verified, not assumed

`sqlcipher_export` is a SQLCipher extension, not core SQLite, so its presence in *this* build was
checked on the device before any of this was designed:

```
attach:  ok
export:  ok
rows:    11 receipts readable through the attached alias
detach:  ok
```

and the resulting file, checked from the host:

```bash
head -c 16 probe-export.kpl | xxd   # ea85 b281 ba93 da50 …  — not "SQLite format 3"
sqlite3 probe-export.kpl 'select count(*) from receipts;'
# Error: in prepare, file is not a database (26)
```

Random header, 303KB of real data, and plain `sqlite3` cannot open it. The same two checks
`CLAUDE.md` prescribes for the live database.

---

## 2. What is in it, and what is not

§20 lists the contents and says **"Receipts metadata"** and **"Documents metadata"** — not the files.
So v1 is metadata only, and the UI says so in words rather than letting the user discover it on a new
phone.

| In | Out |
| --- | --- |
| Every table, via `sqlcipher_export` — subscriptions, bills, payments, receipts, allowances, maintenance, documents, notification and app settings | Receipt photos and document scans (the bytes in the sandbox) |
| Tombstones (`deleted_at` rows), because a sync queue will want them (§21) | The SQLCipher key. It never leaves the Keychain and is never in the bundle — the bundle has its own key, derived from the passphrase. |
| `__drizzle_migrations`, so an import can tell whether the bundle is older, newer or the same | Anything derived. No cached totals, no computed status. |

**A restored expense whose photo is gone renders "Image unavailable".** That is a state the app already
has and already tests, and it is the honest one — the record *did* have a photo. Nulling the URI on
import would say "no photo attached", which is a different and false claim. The import summary says how
many rows are affected before the user commits.

---

## 3. The passphrase

- Chosen by the user, entered twice on export, once on import.
- **Keeply never stores it, never logs it, never puts it in a route param.** Not in SecureStore either
  — a passphrase kept by the app on the device it protects a backup *of* defeats the point. What the
  *user* chooses to do with it, including saving it in their own password manager, is theirs; see §8.
- **Not recoverable.** There is no server and no escrow, so a forgotten passphrase is a lost backup.
  The export screen says that before the button, not after.
- A wrong passphrase on import is indistinguishable from a corrupt file — SQLCipher fails to read the
  header either way. The message says both possibilities rather than guessing.

---

## 4. What can and cannot be tested

Honest split, and it mirrors `src/db/client.ts` being untested by design.

**Testable in plain Node (`node --test`):**

- Bundle naming and timestamping.
- Passphrase *policy* (length, whitespace, confirmation match) — pure functions.
- Manifest / compatibility rules: given the bundle's migration list and the app's, decide
  `same` / `bundle-older` / `bundle-newer` / `not-keeply`.
- The import summary arithmetic: row counts per table, how many photos will be missing, and how
  many rows belong to a table this build has retired.
- The table-name → user-facing-word mapping (`bill_payments` → "payments"), which is where a typo
  silently omits a whole record kind from the summary.
- The verdict itself (`judgeBundle`): what is refused, what is merely flagged, and what is said.

**Not testable without a device**, because `node:sqlite` is plain SQLite with no SQLCipher:
`ATTACH … KEY`, `sqlcipher_export()`, and opening the bundle back. Those get the same treatment
`assertSQLCipher()` gets — an explicit runtime assertion plus an empirical device check recorded here.

---

## 5. Steps

| Step | Work | Done when |
| --- | --- | --- |
| ~~**8a**~~ | Format decision, device verification, pure policy layer + tests | **Done** — verified above; `src/features/backup/` policy module, tests green and mutation-verified. |
| ~~**8b**~~ | ~~`exportBundle(passphrase)` over `sqlcipher_export`~~ | **Done and verified on the device** — see §7. |
| ~~**8c**~~ | ~~`inspectBundle` / `restoreBundle`: open, validate, summarise, restore~~ | **Done and verified on the device** — see §9 for the mechanism and §10 for the checks. |
| ~~**8d**~~ | ~~Export screen under More~~ | **Done** — passphrase twice with a reveal toggle, the three caveats, share sheet on success, staged copy deleted on the way out. `plan/screenshots/20-*`. The restore screen is `src/app/backup/restore.tsx`, `plan/screenshots/27-*`. |
| ~~**8e**~~ | ~~Share sheet~~ | **Done** — the bundle goes straight to `Share.share()`; it is written to the cache, never beside the live database. |

---

## 6. Not in this phase

Automatic or scheduled backups · cloud destinations of any kind (§21 is explicitly future) ·
partial/selective restore · merge-on-import (v1 restores into an empty database or replaces wholesale;
conflict merging needs the sync design that §21 defers) · plaintext JSON export (§20 permits it only
behind an explicit user choice; there is no reason to build it before anyone asks).


---

## 7. Verified on the device

An export run through `exportBundle()` on the simulator, then checked from the host and from
inside the app.

| Check | Result |
| --- | --- |
| File written | `Keeply-backup-2026-09-03-1357.keeply`, 303,104 bytes |
| Name is a LOCAL timestamp | simulator clock 13:57 → `-1357`. A UTC stamp would have said 05:57. |
| Header | `0a5f 3c4b b2f0 c2c7 …` — random, not `SQLite format 3` |
| Plain `sqlite3` | `Error: in prepare, file is not a database (26)` |
| Plaintext leakage | `strings` over the whole file finds **no** merchant name — not "Jollibee", "SM Hypermarket", "Mercury Drug", "Grab" or "Ayala Mall" |
| Wrong passphrase | ATTACH **refused** |
| Right passphrase | opens: 11 expenses, 1 allowance, 3 subscriptions, 2 migration rows, and the merchant names read back correctly |

## 8. What the build found

Two defects, both caught by looking at the running app rather than by a test.

### A passphrase leak in error messages — fixed

op-sqlite echoes **bound parameters** into its error message:

```
Failed query: ATTACH DATABASE ? AS keeply_export KEY ?
params: /Users/…/Keeply-backup-….keeply, correct horse battery staple
```

The second parameter is the user's passphrase. The first version of
`exportEncryptedCopy()` attached that error as `cause`, which put the passphrase on React
Native's redbox in development and one careless `log.error(err.cause)` away from a device
log — for the single most sensitive string this app handles, protecting a complete copy of
everything the user owns.

It surfaced only because the raw driver error was read directly during verification. The app
logger would not have printed it (`describeError()` reads `error.message` and does not walk
`cause`, and `src/db/log.ts`'s `logFailure` prints an error *code* and never a message) — so
nothing would have gone wrong until someone changed one of those.

**Fixed:** the cause is dropped deliberately, with the reason written at the throw site.
Re-verified by forcing a failure: `{name: 'DatabaseInitError', message: 'Could not write the
backup', hasCause: false, leaksPassphrase: false}`.

### The three caveats were truncated — fixed

They were `<Row/>`s, whose subtitle is `numberOfLines={2}`. The most important sentence on the
screen rendered as *"…a forgotten passphrase means a backup nobod…"*. Exactly the same
primitive-misuse as the expense-detail notes field in Phase 9. They are prose blocks now.

### Not a defect, but recorded

iOS shows its **Passwords** bar over the passphrase field. `textContentType` is `'none'` and
`autoComplete` is `'off'`, but any `secureTextEntry` field is a password field to iOS, and
suppressing it needs `textContentType: 'oneTimeCode'` — which lies about the field. Left alone:
Keeply never stores the passphrase, and a user who puts it in their own password manager has
solved the likeliest way this feature fails them. The comment on `TextField`'s `passphrase`
content type says so rather than claiming a suppression that does not happen.


---

## 9. How a restore works, and the alternative that was rejected

A bundle is a whole SQLCipher database, so the restore is the export run backwards:

| | |
| --- | --- |
| **1. stage** | Open the bundle under the user's passphrase as its OWN connection, `ATTACH` a staging file keyed with THIS DEVICE's key, `SELECT sqlcipher_export('keeply_restore')`. |
| **2. swap** | Close the live connection, move `keeply.db` to `keeply.previous.db`, move the staging file in. |
| **3. open** | Prove the new file opens and the device key unlocks it. |
| **4. migrate** | `runMigrations()` brings an older bundle's schema forward with the real SQL. |
| **5. discard** | Only now delete `keeply.previous.db`. |

Everything expensive and everything likely to fail is in step 1, where failing costs nothing —
nothing has moved yet. Steps 3 and 4 are the proof the restore worked, and until both have
returned the previous database is still on disk and a failure puts it back. Step 5 is the point of
no return and it is deliberately last.

### Why not `DELETE` + `INSERT … SELECT` across an ATTACH

That is one SQL transaction and it looks safer. It is not, and the reason is in `drizzle/0002`:

```sql
DROP TABLE `vehicle_expenses`;  DROP TABLE `vehicle_insurance`;  DROP TABLE `vehicles`;  …
```

**Schemas do not only gain columns.** A bundle written by an older build can carry tables this
build has deleted, columns that were renamed, and none of the tables added since. Copying it
row-by-row into the *current* schema means hand-writing, forever, a second migration path that has
to agree with the real one — and every disagreement is silent data loss at the moment the user is
relying on us most.

Swapping the file means the restored database **is** the bundle, and the migrations that brought
this device forward bring it forward too. Rows from a retired table are dropped by the same SQL
that dropped them here. One migration path, and it is the tested one. `judgeBundle()` counts those
rows and says so before the user commits — the outcome is correct, but it must not be a surprise.

### The crash window, and the net under it

The swap is two renames. A process death between them leaves no `keeply.db`, and the next launch
would otherwise read that as "no database yet", mint a fresh key, and open a clean app over the
user's data. `recoverInterruptedRestore()` runs at the TOP of `openDatabase()` — before
`databaseFileExists()` is consulted — and moves `keeply.previous.db` back. The worst outcome of a
crash mid-restore is therefore that the restore did not happen, which the user can see and repeat.

### Why the bundle is opened as its own connection, not ATTACHed to the live one

The export has to use `ATTACH … KEY ?`, and §8 is the leak that cost: op-sqlite echoes bound
parameters into its error messages, and there the second parameter is the user's passphrase.
`open({ encryptionKey })` takes the key as a field of an options object, so on the import path the
passphrase is never a query parameter and is not reachable through an error at all. The one
`ATTACH` that remains, in step 1, binds the *device* key — so that call site drops its `cause` for
the same reason and says so.

### The passphrase is used twice, deliberately

`inspectBundle()` opens the file, reads it and closes it, writing nothing. `restoreBundle()` opens
it again and commits. A restore replaces everything, and the only defensible way to ask "are you
sure?" is with the contents of the actual file on screen — 12 expenses, 1 allowance, written by
this version. That question cannot be asked while holding the file open.

---

## 10. Verified on the device (8c)

Driven over CDP against the dev client on `BC119EA8`, on the database holding real test data.

| Check | Result |
| --- | --- |
| Export, then inspect | 3 subscriptions · 3 bills · 10 expenses · 1 allowance · 4 maintenance items, 4 migration rows |
| Photo caveat | 4 of 10 expenses name an image; the summary says so |
| **Wrong passphrase** | `BackupUnreadableError` — the message offers both causes, never guesses one |
| **A text file renamed `.keeply`** | Same error, same message. Indistinguishable, as it must be. |
| **A bundle claiming a NEWER schema** | Fabricated by inserting `9999_from_the_future` into an opened bundle's `__drizzle_migrations`. `canRestore: false`, `refusal: 'bundle-newer'`, and `restoreBundle()` threw rather than proceeding. |
| **The replace is real** | Added a marker expense (10 → 11), restored the 10-expense bundle, marker gone and every count back to the pre-marker value |
| **Interrupted restore** | Terminated the app, renamed `keeply.db` to `keeply.previous.db` by hand, relaunched: the file was put back and all 21 records were intact. Without the recovery step this is a fresh key over the user's data. |
| Disk after a restore | No `keeply.previous.db`, no `keeply.restoring.db` — `discardStagedCopy()` ran |
| Backup exclusion survives | `xattr` on the directory still carries `com.apple.metadata:com_apple_backup_excludeItem` — the restore replaces a file *inside* the stamped directory, so the attribute is not disturbed |
| Restored file is still encrypted | Header `b32f 07d1 055b 5f23 …` — random, not `SQLite format 3`; plain `sqlite3` returns `file is not a database (26)`; `strings` finds no merchant name |
| The file picker | `File.pickFileAsync` presents the iOS Files sheet. **expo-file-system 57 has a picker** — no new dependency and no `prebuild`. |

**Not verified:** choosing a file through the picker and completing a restore by hand. The
simulator reports zero windows to System Events, so the sheet cannot be tapped from here (see the
handoff). Everything behind the picker is verified above; what is untested is the two taps between
`pickFileAsync` and the URI it returns.
