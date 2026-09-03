# Phase 8 — Backup / Restore

**Status: 8a, 8b and 8d (export half) done. Import (8c) is the open half.** Written 2026-09-03, after Phase 9 put real records in the app.

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
| Every table, via `sqlcipher_export` — subscriptions, bills, payments, receipts, allowances, vehicles, documents, notification and app settings | Receipt photos and document scans (the bytes in the sandbox) |
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
- The import summary arithmetic: row counts per table, how many photos will be missing.

**Not testable without a device**, because `node:sqlite` is plain SQLite with no SQLCipher:
`ATTACH … KEY`, `sqlcipher_export()`, and opening the bundle back. Those get the same treatment
`assertSQLCipher()` gets — an explicit runtime assertion plus an empirical device check recorded here.

---

## 5. Steps

| Step | Work | Done when |
| --- | --- | --- |
| ~~**8a**~~ | Format decision, device verification, pure policy layer + tests | **Done** — verified above; `src/features/backup/` policy module, tests green and mutation-verified. |
| ~~**8b**~~ | ~~`exportBundle(passphrase)` over `sqlcipher_export`~~ | **Done and verified on the device** — see §7. |
| **8c** | `importBundle(uri, passphrase)`: open, validate, summarise, restore | A wiped app restores every record from a bundle. |
| ~~**8d**~~ | ~~Export screen under More~~ | **Done** — passphrase twice with a reveal toggle, the three caveats, share sheet on success, staged copy deleted on the way out. `plan/screenshots/20-*`. The import screen waits on 8c. |
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
