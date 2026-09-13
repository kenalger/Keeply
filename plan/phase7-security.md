# Phase 7 — Security

**Status: 7a–7d built 2026-09-13.** Key rotation deliberately deferred (§3). The last unbuilt phase, and the one the app has
been promising longest: the first-run wizard already asks whether to require a
biometric unlock and STORES the answer, while More shows a "Soon" chip beside it.

Implements `goal.md` §17 (app lock) and closes out §18–§19, most of which was
built in Phase 1 and has never been audited end to end.

---

## 1. What is already here

More than for any previous phase — the groundwork was laid deliberately.

| Already exists | Where |
| --- | --- |
| `appLockEnabled` and `appLockGraceSeconds`, persisted | `src/stores/settings-store.ts`, `src/features/settings/keys.ts` |
| The wizard step that sets them, and records the choice | `src/features/onboarding/ui/protect-step.tsx` |
| Device capability: hardware, enrolment, and what to CALL it | `src/stores/app-lock-store.ts` |
| `NSFaceIDUsageDescription`, a real Keeply-specific string | `app.json`, via **both** plugins' `faceIDPermission` |
| `USE_BIOMETRIC` / `USE_FINGERPRINT` on Android | the `expo-local-authentication` plugin |
| A boot gate with a `ready` state to hang a lock off | `src/app/_layout.tsx` |
| SQLCipher, a device-bound key, backup exclusion | Phases 1 and 8 |

**No native rebuild is needed.** `app-lock-store.ts`'s header says the Face ID
usage string "belongs in `app.json`, which is a native rebuild" — it was added
there at the same time, and the built `Info.plist` already carries it. Verified:

```
/usr/libexec/PlistBuddy -c "Print :NSFaceIDUsageDescription" ios/Keeply/Info.plist
→ Keeply uses Face ID to unlock the app so your bills, receipts, and identity
  documents stay private if someone else picks up your phone. …
```

So the work is the gate, the cover, the settings, and an audit.

---

## 2. What an app lock IS, and what it is not

This has to be stated because the app is about to make a promise with a lock
icon on it, and the honest version is narrower than it looks.

**It is a presence check.** It stops the person who picks up an unlocked phone
from reading your bills, your receipts and your ID numbers. That is a real and
common threat and the reason §17 exists.

**It is not what protects the data.** SQLCipher does, with a key that lives in
the Keychain as `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and never leaves the handset
(§18, §A4). Someone who copies `keeply.db` off the device gets random bytes
whether or not app lock is on. Turning app lock on does not make the database
safer; turning it off does not make it weaker.

Saying so matters for the next decision.

### The lock must never become a way to lose your own data

If the lock cannot be satisfied — no enrolled biometrics, no device passcode,
a sensor that has stopped answering — the app does **not** sit behind a wall it
cannot open. It unlocks, and says why.

The alternative is a user whose only copy of their records is unreachable
because they changed a phone setting. And it costs nothing real: the data at
rest is protected by a key they still cannot extract, and the lock was never the
thing protecting it. A lock that can brick the app is strictly worse than no
lock, and this is the one place where "fail open" is the safe direction.

What is NOT allowed is failing open silently. A cancelled or failed attempt
keeps the app locked and offers another try; only an *unsatisfiable* lock opens.

---

## 3. Decisions, locked

### The locked screen renders nothing of the app

Not a modal over the tree, not a blur over a live screen. The navigation tree is
not mounted at all while locked. A modal leaks content behind its scrim, in the
app switcher, and on any mis-tap that dismisses it — and "mostly covered" is not
a security property.

### The privacy cover goes up on `inactive`, not `background`

iOS takes the app-switcher snapshot during the `inactive` transition, before
`background`. A cover that waits for `background` is a cover that appears in
every screenshot except the one anybody sees. This is the single most common way
this feature is built wrong.

### The grace period is real, and it defaults to immediate

`appLockGraceSeconds` already exists and defaults to `0`. Answering a phone call
should not always mean re-authenticating, but the default is the strict one, and
the setting says in words what it does.

### Time is measured on a monotonic clock, never the wall clock

A grace period compared against `Date.now()` is a grace period a user can extend
by changing the device clock. `performance.now()` is monotonic and unaffected.

### Key rotation is NOT in this phase, and the reason is written down

`plan/phases.md` lists it. It is being deferred deliberately, not forgotten:

- The key is generated on-device, never transmitted, never displayed, and stored
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. There is no exposure event that rotation
  would respond to.
- Rotation means `PRAGMA rekey` over the whole database. Interrupted, it leaves
  a file whose key nobody holds — the exact unrecoverable state §19/§A4's whole
  design exists to prevent, and the one Phase 8's restore goes to great lengths
  to make survivable.
- §20's encrypted export already provides the "get my data out under a key I
  choose" capability that rotation is usually asked for.

It gets built when there is a threat it answers. Written at the key, not just
here.

---

## 4. Steps

| Step | Work | Done when |
| --- | --- | --- |
| ~~**7a**~~ | ~~The lock gate~~ | **Done.** 22 tests, 8 mutations red. Verified on device: `LockScreen` mounted, `AppStack`/navigator/tabs **not**. |
| ~~**7b**~~ | ~~The privacy cover, on `inactive`~~ | **Done.** Opaque, not a blur — see the component for why. |
| ~~**7c**~~ | ~~Settings~~ | **Done.** `/security`; the "Soon" chip is gone. `plan/screenshots/45-*`. |
| ~~**7d**~~ | ~~The §18/§19 audit~~ | **Done** — §6 below. Two findings, both fixed. |

---

## 5. Not in this phase

Key rotation (§3) · a Keeply-specific passcode separate from the device's (it
would be a second secret to lose, protecting data the device passcode already
gates) · screenshot prevention (`expo-screen-capture` is not installed, it is
trivially defeated by a second camera, and it would block the user's own
screenshots of their own records) · remote wipe (there is no server, by §1).

---

## 6. The §18/§19 audit (step 7d)

Done by sweeping every one of the **117 `log.*` call sites** in `src/`, every
metadata key any of them passes, and every screen that renders a sensitive
field. Findings are at the end; this table is the standing answer to "where is
this allowed to appear?"

### What is sensitive, and where it may be

| Field | Stored | Shown in full | Masked | Searched | Logged | Notification |
| --- | --- | --- | --- | --- | --- | --- |
| `documents.document_number` (§14) | yes | **never** | detail screen only | **never** | never | never |
| `documents.local_file_uri` (§16) | yes | never | — | never | never | never |
| `maintenance_items.identifier` — plate / serial (§11) | yes | **never** | detail screen only | **never** | never | never |
| `maintenance_renewals.reference_number` — policy, OR/CR | yes | **never** | its own edit field | **never** | never | never |
| `receipts.local_image_uri` / `_thumbnail_uri` (§10) | yes | never | — | never | never | never |
| Amounts (`*_minor`) | yes | freely — they are the product | — | by range | **never** | yes, with the record |
| Record names | yes | freely | — | yes | **never** | yes — §8 requires it |
| Backup passphrase (§20) | **never** | while typing | — | — | **never** | — |
| The SQLCipher key (§18) | Keychain only | **never** | — | — | **never** | — |

"Masked" is `maskIdentifier()` — `**** **** 1234`, last four only.

### How the rules are actually enforced

Not by discipline. Each has a mechanism, and each mechanism has a test:

| Rule | Enforced by |
| --- | --- |
| Only structural keys reach the console | `SAFE_KEYS` **allowlist** in `log.ts` — a denylist let `billMinor`, `due`, `monthly` and `name` through once |
| A string on a safe key is still scrubbed | `redactText` runs on allowlisted values too |
| No `console.*` outside the loggers | eslint rule, with `tests/lint-rules.test.ts` over deliberate violations |
| A number is never searched on | the search builder omits the column; asserted on statement TEXT, not just behaviour |
| `log.info` / `warn` / `debug` vanish in release | no-op functions; `tests/log-redaction.test.ts` runs as a release build |
| Media stays in the backup-excluded directory | one resolver, `src/lib/private-directory.ts` |

### What the audit found

**1. op-sqlite's echoed parameters could leak a short document number.** The
driver appends `params: […]` to its error messages, and those parameters are the
row. Phase 8 hit this with the backup passphrase and fixed it at one call site
by throwing without a `cause`.

Proved it was still open elsewhere: `P1234567` and `ZZ9988776` were caught by
the identifier patterns, but **`AB12CD` came through intact** — two letters, two
digits, two letters matches none of them, and real membership numbers look like
that. A long statement was saved only by `MAX_STRING_LENGTH`, which is
truncation, not redaction, and not a property to depend on.

Fixed generally rather than per-call-site: everything after `params:` is
dropped. Widening the identifier heuristics would have started redacting
ordinary words, and the statement text — which is what actually says what went
wrong — sits before the marker and survives.

**2. The reminder queue's own diagnostic printed six `[redacted]` placeholders.**
Of the seven keys on `reminders: queue rebuilt`, only `permission` was
allowlisted. The one line that would explain why reminders are wrong explained
nothing. Each of the others is a COUNT — how many were placed or dropped, never
which record — so they are allowlisted now, and `log.info` is a no-op in release
anyway.

**3. Everything else came back clean.** No call site passes a record, a name, an
amount, a URI or an identifier. The twelve metadata keys in use across the whole
app are `reason`, `count`, `permission`, `code`, `to`, `from`, `keys`,
`scheduled`, `entities`, `cycle`, `busy`, `attempt` — every one structural, and
each verified against the allowlist rather than assumed.

### Still open, deliberately

- ~~`describeError` does not walk `cause`~~ — **closed.** It was load-bearing
  and undocumented; it now says so at the function and has a test that attaches
  a real container path as a cause and asserts it does not print.
- **Unicode search is case-sensitive** (`lower()` is ASCII-only in SQLite).
  Project-wide, not a security issue, noted in the Phase 6 audit.
