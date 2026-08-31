# Onboarding & Retention — where Keeply loses people

Design analysis, not measured data. Keeply has no users and no analytics yet (and §19 means it will
never have much). These are reasoned judgments about *this* app's specific shape, to be revised the
moment real behaviour contradicts them.

---

## 1. The honest problem

Keeply's value is **deferred and invisible**. A subscription tracker pays off weeks later, as a late
fee that didn't happen or a licence that didn't expire. But the cost is **immediate and manual** —
the user must type in everything the app will later remind them about.

That inversion is what kills this entire product category:

```
Effort:  ███████████░░░░░░░░░░░  all of it, on day one
Value:   ░░░░░░░░░░░░░░░░███████  weeks later, and invisible when it works
```

Nothing about the offline-first architecture changes this. A private local vault that is *empty* is
worth exactly as much as a cloud one that is empty. So onboarding's job is **not** to explain Keeply.
It is to collapse the effort and pull the payoff forward into the first two minutes.

## 2. The seven friction points, worst first

**F1 · The empty vault.** A new user lands on "You're all caught up" — technically true, completely
valueless. The dashboard is designed to answer "is there anything I need to deal with today?" and on
day one the answer is a shrug. *This is the moment most users leave and do not return.*

**F2 · Blank-form data entry.** "Add subscription" → eight empty fields. Doing that six times is
ten minutes of typing before anything is useful. Every field is a chance to quit.

**F3 · Recall failure.** Even a motivated user cannot list their own subscriptions from memory. Ask
someone what they pay for monthly and they'll name three of nine. The app cannot see their bank
account (§36, deliberately), so **it must supply the memory** — a list to tap, not a field to fill.

**F4 · Notification permission asked at the wrong moment.** On iOS the prompt happens **once**, ever.
Asked on screen one, before any value exists, it is a coin flip — and a denial is permanent. Yet
notifications *are* the entire retention engine: without them Keeply is a spreadsheet the user must
remember to open. This is the single highest-leverage decision in the app.

**F5 · Unproven trust.** Keeply asks for receipts, IDs, licence numbers, plate numbers. "Private" on
a marketing screen is worth nothing; every app claims it. Trust has to be *demonstrated* before the
user will put real data in — and the sensitive modules (Documents, Receipts) are the ones that
suffer most when it isn't.

**F6 · No reason to open the app.** Once set up, Keeply correctly demands no attention. That is the
product working — and also why it gets uninstalled during a storage cleanup six weeks later. The app
must occasionally *show its work*.

**F7 · Setup abandoned halfway.** Any wizard that must be finished to be useful will be abandoned by
people interrupted at step three, who then return to a broken half-state.

## 3. What onboarding must do

Not a feature tour. Tours are skipped, and a skipped tour teaches nothing. **A working setup, in
under two minutes, ending on a dashboard with the user's own data in it.**

```
1  Promise        One screen. No account, no signup, works offline. Then get out of the way.
2  Pick areas     Subscriptions / Bills / Vehicles / Documents. Multi-select, all optional.
                  Personalises everything after, and lets us not nag about vehicles to someone
                  who doesn't drive.
3  Tap, don't type   A curated Philippine catalogue — Netflix, Spotify, Meralco, Globe, PLDT,
                  Maynilad, Converge, Sky. Tapping a chip prefills name, category and cycle.
                  THE USER TYPES ONE FIELD: the amount. Six subscriptions in ~40 seconds
                  instead of ~10 minutes. This step is the whole design.
4  The payoff     Show the dashboard filling as they go. "₱3,247 a month across 6 subscriptions,
                  next renewal in 4 days." Value arrives before the ask.
5  The ask        NOW request notifications, and be concrete:
                  "Remind me 3 days before Netflix renews — ₱549."
                  A specific promise about their own data, not a generic permission plea.
6  Protect it     Offer biometric lock. Framed as trust, and it is the moment they have just
                  put real money data in, so it lands.
```

Every step is skippable and the wizard is **resumable** (F7) — progress persists in `app_settings`,
and an abandoned wizard leaves a usable app, never a broken half-state.

## 4. The catalogue is the product decision

F3 is the one worth building infrastructure for. A blank "Name" field asks the user to remember; a
grid of logos asks them to *recognise* — and recognition is far cheaper than recall.

Prefill **name, category, billing cycle**. Do **not** prefill the amount: plans vary, and a
confidently wrong ₱549 that the user doesn't notice is worse than a blank field, because it corrupts
their totals silently. Show the typical amount as a *hint*, never as a value.

Philippine-specific by default (§30 is PHP-only for now): Meralco, Maynilad, Manila Water, Globe,
Smart, PLDT, Converge, Sky, Cignal, Netflix, Spotify, YouTube Premium, iCloud, Google One, Disney+,
HBO Max, Viu, gym chains, condo dues, Pag-IBIG, PhilHealth, SSS.

## 5. Retention after day one

Local notifications are the only mechanism available — no server, no push, by design (§8, §34).
That is a constraint and also a feature: every reminder is one the user actually asked for.

- **Reminders are the loop.** A well-timed "Internet bill due in 3 days — ₱1,899" is the product.
- **Show the work.** A monthly local summary — "You tracked ₱15,299 across 14 records; nothing was
  missed." Makes the invisible save visible, which is the answer to F6.
- **Reward data entry with insight.** Cost-per-kilometre, yearly subscription creep, average
  fuel efficiency. These only exist because the user did the typing — which retroactively justifies it.
- **Expiry is the killer feature.** Nobody else reminds you your driver's licence expires in 30 days.
  It is high-stakes, annual, and genuinely forgettable. Lead with it.
- **No streaks, no gamification.** Keeply is not a habit app. Guilting someone for not opening a
  vault is user-hostile and would undercut the "requires no attention" promise.

## 6. What to measure — without violating §19

No analytics SDK, nothing leaves the device. Local counters only, visible to the user, off by
default, never uploaded:

- wizard step reached vs. completed
- records created during onboarding vs. after
- notification permission outcome
- days-to-second-open

If a telemetry decision ever conflicts with §19, §19 wins. A privacy-first app that quietly
instruments its users is just a slower betrayal.
