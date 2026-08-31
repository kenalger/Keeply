/**
 * Keeply — the Philippine provider catalogue (`plan/onboarding.md` §3 step 3, §4).
 *
 * THIS IS THE STEP THE WHOLE WIZARD EXISTS FOR. Friction point F3: a motivated
 * user cannot list their own subscriptions from memory. Ask someone what they
 * pay for monthly and they will name three of nine. Keeply cannot see their
 * bank account — §36 rules that out deliberately — so the app has to supply the
 * memory. A blank "Name" field asks for RECALL. A grid of known providers asks
 * for RECOGNITION, and recognition is far cheaper. Six subscriptions in about
 * forty seconds instead of about ten minutes, with the user typing exactly one
 * field per record: the amount.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `amountMinor` ANYWHERE IN THIS FILE
 * ---------------------------------------------------------------------------
 * Plans vary — Netflix alone has four tiers in the Philippines — so a prefilled
 * ₱549 is wrong for most users, and wrong in the worst possible way: silently.
 * A user who does not notice it carries that error into every monthly total the
 * app will ever show them, and there is no server-side correction and no
 * reconciliation against a bank feed to catch it later. A blank amount costs
 * four seconds of typing. A wrong one costs the credibility of every number in
 * the app.
 *
 * So a catalogue entry carries `hintMinor`, and three separate things stop it
 * from becoming a stored amount:
 *
 *  1. THE NAME. `hintMinor`, not `amountMinor`. Spreading an entry into a
 *     `NewSubscriptionInput` cannot populate the amount, because the property
 *     the insert reads does not exist on the entry.
 *  2. THE TYPE. {@link AmountHint} is its own brand, disjoint from `MinorUnits`.
 *     `amountMinor: entry.hintMinor` is a compile error, not a lint warning —
 *     `tests/onboarding-catalog.test.ts` pins that with a `@ts-expect-error`,
 *     so the check is verified by `tsc --noEmit` rather than merely asserted.
 *  3. THE PREFILL. {@link catalogPrefill} returns a shape with no amount field
 *     of any name, so the object that reaches a form literally cannot carry
 *     one, and the caller has to supply `amountMinor` itself.
 *
 * A hint is placeholder text. It belongs in a `placeholder` prop and nowhere
 * else. If you find yourself reaching for `Number(entry.hintMinor)`, stop.
 *
 * ---------------------------------------------------------------------------
 * SUBSCRIPTION-SHAPED VS BILL-SHAPED
 * ---------------------------------------------------------------------------
 * The split is not "streaming vs utility". It is the distinction the two
 * modules actually encode:
 *
 *   BILL (§7)          arrives as an invoice with a due date you must pay by,
 *                      and a missed one has a consequence — a penalty, a
 *                      disconnection, a lapsed membership. The row has
 *                      `status` (unpaid/paid) and `is_variable`.
 *   SUBSCRIPTION (§6)  a recurring charge you authorised, which renews until
 *                      you cancel. The row has `is_active` (running/paused) and
 *                      a fixed amount you already know.
 *
 * Cable and satellite TV land on the bill side under the `subscription` bill
 * category, which is exactly what that category is for: a recurring service,
 * billed monthly, with a due date.
 *
 * ---------------------------------------------------------------------------
 * PURE, AND NO SCHEMA IMPORT
 * ---------------------------------------------------------------------------
 * No `@/db` at runtime, no clock, no I/O. `SUBSCRIPTION_CATEGORIES` and
 * `BILLING_CYCLES` are reused from the modules that already own them rather
 * than re-listed; `BILL_CATEGORIES` has no owner yet (the bills feature is not
 * built) so it is declared here with the same `satisfies` + exhaustiveness
 * proof the rest of the codebase uses, and should MOVE to
 * `src/features/bills/types.ts` the day that module lands.
 */
import {
  isSubscriptionCategory,
  SUBSCRIPTION_CATEGORIES,
  type SubscriptionCategory,
} from '@/features/subscriptions/types';
import { BILLING_CYCLES, isBillingCycle, type BillingCycle } from '@/lib/recurrence';
import { DEFAULT_CURRENCY } from '@/theme/format';

import type { schema } from '@/db';

export { BILLING_CYCLES, SUBSCRIPTION_CATEGORIES };
export type { BillingCycle, SubscriptionCategory };

/* -------------------------------------------------------------------------- */
/* Bill categories (§7)                                                        */
/* -------------------------------------------------------------------------- */

/** The §7 category set, re-exported from the schema enum, type-only. */
export type BillCategory = schema.BillCategory;

/**
 * The bill categories as a runtime list.
 *
 * Duplicated from the schema rather than imported because `@/db/schema/*` is
 * off limits outside `src/db` (eslint `SCHEMA_IMPORT_MESSAGE`); `satisfies`
 * proves every member is real and `AllBillCategoriesListed` proves none is
 * missing, which is what makes the duplication safe. Same trade, same shape, as
 * `SUBSCRIPTION_CATEGORIES` in `src/features/subscriptions/types.ts`.
 */
export const BILL_CATEGORIES = [
  'electricity',
  'water',
  'internet',
  'rent',
  'phone',
  'insurance',
  'credit_card',
  'loan',
  'subscription',
  'other',
] as const satisfies readonly BillCategory[];

type AllBillCategoriesListed =
  Exclude<BillCategory, (typeof BILL_CATEGORIES)[number]> extends never ? true : never;
/** Fails to compile if a bill category is added to the schema but not here. */
export const BILL_CATEGORY_LIST_IS_COMPLETE: AllBillCategoriesListed = true;

/** Whether `value` is one of the §7 bill categories. */
export function isBillCategory(value: unknown): value is BillCategory {
  return typeof value === 'string' && (BILL_CATEGORIES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* The hint brand                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A TYPICAL amount, in integer minor units, for display as placeholder text.
 *
 * Its own brand, deliberately disjoint from `MinorUnits`: the two are the same
 * `number` at runtime — a brand is erased — but nothing typed to accept an
 * amount will accept a hint, which turns "somebody wired the placeholder into
 * the value" from a bug that ships into a compile error.
 *
 * It is not money. It is a guess about money, and it must never be summed,
 * stored, compared against a real amount, or shown anywhere a real amount is
 * shown.
 */
export type AmountHint = number & { readonly __amountHint: unique symbol };

/**
 * Brand a typical amount.
 *
 * @throws {RangeError} if `value` is not a positive safe integer — a hint of
 *         `549.5` centavos or `-1` is a typo in this file, and a typo in a
 *         placeholder is still a number a user will read and believe.
 */
export function amountHint(value: number): AmountHint {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('An amount hint must be a positive integer of minor units');
  }
  return value as AmountHint;
}

/* -------------------------------------------------------------------------- */
/* Entries                                                                     */
/* -------------------------------------------------------------------------- */

export type CatalogKind = 'subscription' | 'bill';

interface CatalogEntryBase {
  /**
   * A STABLE identifier, unique across the whole catalogue.
   *
   * Selections are keyed by this and never by list position, so re-ordering the
   * grid — by relevance, by a search, by a future "most tapped first" — cannot
   * silently move a user's choice onto a different provider. It is also what a
   * resumed wizard stores, so the id is part of this module's contract: rename
   * an entry's display name freely, never its id.
   */
  readonly id: string;
  /** Prefills the record's name. What the provider is actually called. */
  readonly name: string;
  readonly kind: CatalogKind;
  /** Prefills the billing cycle. */
  readonly billingCycle: BillingCycle;
  /**
   * A TYPICAL amount for display as placeholder text ONLY. Never a value.
   * `null` where plans vary so widely that any number would mislead.
   */
  readonly hintMinor: AmountHint | null;
  /** ISO-4217. PHP throughout the MVP (§30). */
  readonly currency: string;
  /**
   * Extra words the search should match — brand aliases, the thing people
   * actually say ("meralco bill", "kuryente"), and the old name of a service
   * that was rebranded ("HBO Go" for Max).
   */
  readonly keywords: readonly string[];
}

export interface SubscriptionCatalogEntry extends CatalogEntryBase {
  readonly kind: 'subscription';
  readonly category: SubscriptionCategory;
}

export interface BillCatalogEntry extends CatalogEntryBase {
  readonly kind: 'bill';
  readonly category: BillCategory;
  /**
   * The amount changes every period — electricity, water, a postpaid line with
   * overages, a credit-card statement. Prefills the bill's `is_variable` column
   * so the form can stop presenting last month's figure as this month's.
   *
   * Named for the COLUMN, not for the amount: nothing on a catalogue entry may
   * carry `amount` in its name, so that "does this entry hold an amount" is a
   * question `Object.keys()` can answer — which is what
   * `tests/onboarding-catalog.test.ts` does.
   */
  readonly isVariable: boolean;
}

export type CatalogEntry = SubscriptionCatalogEntry | BillCatalogEntry;

/* -------------------------------------------------------------------------- */
/* Constructors                                                                */
/* -------------------------------------------------------------------------- */

function subscription(
  id: string,
  name: string,
  category: SubscriptionCategory,
  billingCycle: BillingCycle,
  hint: number | null,
  keywords: readonly string[] = [],
): SubscriptionCatalogEntry {
  return {
    id,
    name,
    kind: 'subscription',
    category,
    billingCycle,
    hintMinor: hint === null ? null : amountHint(hint),
    currency: DEFAULT_CURRENCY,
    keywords,
  };
}

function bill(
  id: string,
  name: string,
  category: BillCategory,
  billingCycle: BillingCycle,
  hint: number | null,
  isVariable: boolean,
  keywords: readonly string[] = [],
): BillCatalogEntry {
  return {
    id,
    name,
    kind: 'bill',
    category,
    billingCycle,
    hintMinor: hint === null ? null : amountHint(hint),
    currency: DEFAULT_CURRENCY,
    isVariable,
    keywords,
  };
}

/* -------------------------------------------------------------------------- */
/* Subscription-shaped entries                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Hints are round, plausible Philippine figures for the tier most people are
 * on, in centavos. They are placeholders and they will go stale; that is fine,
 * because nothing reads them but a `placeholder` prop. Do not "fix" one by
 * wiring it into a value.
 */
export const SUBSCRIPTION_CATALOG: readonly SubscriptionCatalogEntry[] = [
  // Video
  subscription('netflix', 'Netflix', 'video', 'monthly', 549_00, ['streaming', 'movies']),
  subscription('youtube-premium', 'YouTube Premium', 'video', 'monthly', 239_00, [
    'youtube',
    'yt',
    'no ads',
  ]),
  subscription('disney-plus', 'Disney+', 'video', 'monthly', 369_00, ['disney', 'marvel']),
  subscription('hbo-max', 'HBO Max', 'video', 'monthly', 249_00, ['hbo', 'max', 'hbo go']),
  subscription('prime-video', 'Prime Video', 'video', 'monthly', 149_00, ['amazon']),
  subscription('viu', 'Viu Premium', 'video', 'monthly', 149_00, ['korean', 'kdrama']),
  subscription('apple-tv', 'Apple TV+', 'video', 'monthly', 299_00, ['apple']),
  subscription('iwant', 'iWantTFC Premium', 'video', 'monthly', 199_00, ['abs-cbn', 'tfc']),

  // Music
  subscription('spotify', 'Spotify Premium', 'music', 'monthly', 194_00, ['music']),
  subscription('apple-music', 'Apple Music', 'music', 'monthly', 149_00, ['apple', 'music']),

  // Cloud storage
  subscription('icloud', 'iCloud+', 'cloud', 'monthly', 149_00, ['apple', 'storage', 'backup']),
  subscription('google-one', 'Google One', 'cloud', 'monthly', 109_00, [
    'google',
    'drive',
    'storage',
  ]),
  subscription('dropbox', 'Dropbox', 'cloud', 'monthly', 599_00, ['storage']),

  // Software
  subscription('microsoft-365', 'Microsoft 365', 'software', 'yearly', 3_590_00, [
    'office',
    'word',
    'excel',
  ]),
  subscription('adobe-cc', 'Adobe Creative Cloud', 'software', 'monthly', 2_795_00, [
    'photoshop',
    'lightroom',
  ]),
  subscription('canva-pro', 'Canva Pro', 'software', 'yearly', 2_500_00, ['design']),
  subscription('password-manager', 'Password manager', 'software', 'yearly', 1_800_00, [
    '1password',
    'bitwarden',
    'lastpass',
  ]),

  // Gaming
  subscription('xbox-game-pass', 'Xbox Game Pass', 'gaming', 'monthly', 599_00, [
    'xbox',
    'microsoft',
    'games',
  ]),
  subscription('playstation-plus', 'PlayStation Plus', 'gaming', 'monthly', 399_00, [
    'ps plus',
    'sony',
    'games',
  ]),

  // Fitness — the generic entry matters most; the chains are recognition aids.
  subscription('gym-membership', 'Gym membership', 'fitness', 'monthly', 1_500_00, [
    'gym',
    'fitness',
    'workout',
  ]),
  subscription('anytime-fitness', 'Anytime Fitness', 'fitness', 'monthly', 2_500_00, ['gym']),
  subscription('golds-gym', "Gold's Gym", 'fitness', 'monthly', 2_000_00, ['gym']),
  subscription('fitness-first', 'Fitness First', 'fitness', 'monthly', 3_500_00, ['gym']),

  // Education / news / memberships
  subscription('online-course', 'Online course subscription', 'education', 'monthly', 599_00, [
    'coursera',
    'udemy',
    'skillshare',
    'learning',
  ]),
  subscription('news-subscription', 'News subscription', 'news', 'monthly', 299_00, [
    'newspaper',
    'inquirer',
    'rappler',
  ]),
  subscription('sr-membership', 'S&R Membership', 'membership', 'yearly', 900_00, [
    'shopping',
    'warehouse',
  ]),
  subscription('club-membership', 'Club membership', 'membership', 'yearly', 12_000_00, [
    'club',
    'village',
  ]),
  subscription('entertainment-other', 'Other streaming service', 'entertainment', 'monthly', null, [
    'streaming',
  ]),
  subscription('subscription-other', 'Other subscription', 'other', 'monthly', null, []),
];

/* -------------------------------------------------------------------------- */
/* Bill-shaped entries                                                         */
/* -------------------------------------------------------------------------- */

export const BILL_CATALOG: readonly BillCatalogEntry[] = [
  // Electricity — always variable; the hint is a mid-sized Metro Manila month.
  bill('meralco', 'Meralco', 'electricity', 'monthly', 3_500_00, true, [
    'electricity',
    'kuryente',
    'power',
  ]),
  bill('electricity-other', 'Electricity bill', 'electricity', 'monthly', null, true, [
    'kuryente',
    'electric coop',
    'power',
  ]),

  // Water
  bill('maynilad', 'Maynilad', 'water', 'monthly', 800_00, true, ['water', 'tubig']),
  bill('manila-water', 'Manila Water', 'water', 'monthly', 800_00, true, ['water', 'tubig']),
  bill('water-other', 'Water bill', 'water', 'monthly', null, true, ['tubig', 'water district']),

  // Home internet — a fibre plan is a fixed monthly charge with a due date.
  bill('pldt-home', 'PLDT Home Fibr', 'internet', 'monthly', 1_699_00, false, [
    'pldt',
    'fiber',
    'internet',
  ]),
  bill('converge', 'Converge FiberX', 'internet', 'monthly', 1_500_00, false, [
    'converge',
    'fiber',
    'internet',
  ]),
  bill('globe-at-home', 'Globe At Home', 'internet', 'monthly', 1_699_00, false, [
    'globe',
    'fiber',
    'internet',
  ]),
  bill('sky-broadband', 'Sky Broadband', 'internet', 'monthly', 1_499_00, false, [
    'sky',
    'internet',
  ]),

  // Pay TV — recurring, billed monthly, with a due date: bill category
  // `subscription`, which is precisely what that category is for.
  bill('sky-cable', 'Sky Cable', 'subscription', 'monthly', 599_00, false, [
    'sky',
    'cable',
    'tv',
  ]),
  bill('cignal', 'Cignal TV', 'subscription', 'monthly', 690_00, false, [
    'cignal',
    'satellite',
    'tv',
  ]),

  // Mobile postpaid — variable, because overages and add-ons are the norm.
  bill('globe-postpaid', 'Globe Postpaid', 'phone', 'monthly', 999_00, true, [
    'globe',
    'mobile',
    'cellphone',
  ]),
  bill('smart-postpaid', 'Smart Postpaid', 'phone', 'monthly', 999_00, true, [
    'smart',
    'mobile',
    'cellphone',
  ]),
  bill('dito-postpaid', 'DITO Postpaid', 'phone', 'monthly', 599_00, true, [
    'dito',
    'mobile',
    'cellphone',
  ]),

  // Housing
  bill('rent', 'Rent', 'rent', 'monthly', null, false, ['upa', 'landlord', 'apartment']),
  bill('condo-dues', 'Condo association dues', 'other', 'monthly', 3_500_00, false, [
    'condo',
    'association',
    'hoa',
    'village dues',
  ]),

  // Government contributions. §30 is PHP-only and these are Philippine-specific
  // by nature — a voluntary or self-employed member pays them monthly, with a
  // deadline and a penalty, which is bill-shaped in every respect.
  bill('sss', 'SSS contribution', 'insurance', 'monthly', 1_000_00, false, [
    'social security',
    'government',
  ]),
  bill('philhealth', 'PhilHealth contribution', 'insurance', 'monthly', 500_00, false, [
    'health',
    'government',
  ]),
  bill('pag-ibig', 'Pag-IBIG contribution', 'other', 'monthly', 200_00, false, [
    'hdmf',
    'government',
    'savings',
  ]),
  bill('pag-ibig-loan', 'Pag-IBIG housing loan', 'loan', 'monthly', null, false, [
    'hdmf',
    'housing',
    'amortization',
  ]),

  // Credit, loans, insurance
  bill('credit-card', 'Credit card bill', 'credit_card', 'monthly', null, true, [
    'visa',
    'mastercard',
    'statement',
  ]),
  bill('personal-loan', 'Personal loan', 'loan', 'monthly', null, false, [
    'amortization',
    'installment',
  ]),
  bill('car-loan', 'Car loan', 'loan', 'monthly', null, false, [
    'auto loan',
    'amortization',
  ]),
  bill('car-insurance', 'Car insurance', 'insurance', 'yearly', null, false, [
    'ctpl',
    'comprehensive',
    'vehicle',
  ]),
  bill('health-insurance', 'Health insurance', 'insurance', 'yearly', null, false, [
    'hmo',
    'medical',
  ]),

  // Education and the escape hatch
  bill('tuition', 'Tuition', 'other', 'quarterly', null, true, ['school', 'enrollment']),
  bill('bill-other', 'Other bill', 'other', 'monthly', null, true, []),
];

/**
 * Every entry, subscriptions first.
 *
 * Frozen order: `catalogById()` is the only sanctioned way to resolve a
 * selection, so nothing depends on position — but a stable order still makes
 * the un-searched grid render the same way twice, which is the difference
 * between a list a user can learn and one that shuffles under their thumb.
 */
export const CATALOG: readonly CatalogEntry[] = [...SUBSCRIPTION_CATALOG, ...BILL_CATALOG];

/* -------------------------------------------------------------------------- */
/* Lookup                                                                      */
/* -------------------------------------------------------------------------- */

const BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG.map((entry) => [entry.id, entry]),
);

/** Resolve a stored selection. `null` for an id this build does not know. */
export function catalogById(id: string): CatalogEntry | null {
  return BY_ID.get(id) ?? null;
}

/** How many entries this build ships. */
export const CATALOG_SIZE = CATALOG.length;

/* -------------------------------------------------------------------------- */
/* The prefill — the shape that reaches a form                                 */
/* -------------------------------------------------------------------------- */

/**
 * Name, category and cycle. NO amount field, of any name.
 *
 * This is the third of the three defences described in the file header, and the
 * strongest of them: whatever a screen does with a prefill, it cannot spread an
 * amount out of it, because there is nothing there to spread.
 */
export interface SubscriptionPrefill {
  readonly name: string;
  readonly category: SubscriptionCategory;
  readonly billingCycle: BillingCycle;
  readonly currency: string;
}

export interface BillPrefill {
  readonly name: string;
  readonly category: BillCategory;
  readonly billingCycle: BillingCycle;
  readonly currency: string;
  readonly isVariable: boolean;
}

export type CatalogPrefill = SubscriptionPrefill | BillPrefill;

/** What a tapped chip puts into the form. */
export function catalogPrefill(entry: SubscriptionCatalogEntry): SubscriptionPrefill;
export function catalogPrefill(entry: BillCatalogEntry): BillPrefill;
export function catalogPrefill(entry: CatalogEntry): CatalogPrefill;
export function catalogPrefill(entry: CatalogEntry): CatalogPrefill {
  if (entry.kind === 'subscription') {
    return {
      name: entry.name,
      category: entry.category,
      billingCycle: entry.billingCycle,
      currency: entry.currency,
    };
  }
  return {
    name: entry.name,
    category: entry.category,
    billingCycle: entry.billingCycle,
    currency: entry.currency,
    isVariable: entry.isVariable,
  };
}

/**
 * The placeholder text for the amount field, or `null` when there is no honest
 * hint to give.
 *
 * Returns a NUMBER, never a formatted string, because formatting belongs at the
 * UI edge (`formatMoney` / `<Amount/>`) and a formatted hint stored here would
 * be the "₱1,500.00" string CLAUDE.md forbids. The caller formats it and passes
 * it to `placeholder`.
 */
export function catalogHint(entry: CatalogEntry): AmountHint | null {
  return entry.hintMinor;
}

/* -------------------------------------------------------------------------- */
/* Search (§23-style, over a fixed in-memory list)                             */
/* -------------------------------------------------------------------------- */

/**
 * Fold to a comparable form: lower case, accents stripped, punctuation and
 * whitespace removed.
 *
 * `"Gold's Gym"` has to be found by typing `golds gym`, `Disney+` by `disney`,
 * and `S&R` by `s and r`'s first letters — none of which survive a naive
 * `toLowerCase().includes()`. NFD + combining-mark removal handles the accents
 * a pasted provider name can carry.
 */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

interface SearchIndexEntry {
  readonly entry: CatalogEntry;
  readonly name: string;
  readonly haystack: readonly string[];
}

const SEARCH_INDEX: readonly SearchIndexEntry[] = CATALOG.map((entry) => ({
  entry,
  name: fold(entry.name),
  haystack: [fold(entry.name), fold(entry.id), ...entry.keywords.map(fold)],
}));

export interface CatalogSearchOptions {
  /** Restrict to one side of the split. Omit for both. */
  kind?: CatalogKind;
  /** Cap the result. Omit for everything that matches. */
  limit?: number;
}

/**
 * Rank one entry against a folded query. Higher is better; `0` is no match.
 *
 * Three tiers, and the reason for them is the grid: a user typing `net` wants
 * Netflix first, not "Other bill" because its keyword list happens to contain
 * the letters. Name-prefix beats name-substring beats keyword.
 */
function score(indexed: SearchIndexEntry, query: string): number {
  if (indexed.name === query) return 4;
  if (indexed.name.startsWith(query)) return 3;
  if (indexed.name.includes(query)) return 2;
  return indexed.haystack.some((term) => term.includes(query)) ? 1 : 0;
}

/**
 * Filter the catalogue.
 *
 * An empty or whitespace-only query returns the catalogue in its declared
 * order — the grid's resting state — rather than nothing, so a cleared search
 * box restores the list instead of emptying it.
 *
 * The sort is TOTAL: score, then declaration order. Two entries can never
 * compare equal, so the same query always produces the same list in the same
 * order, on any engine, whatever `Array.prototype.sort`'s stability guarantees.
 * That is what lets a selection be keyed by `id` and survive a re-render.
 */
export function searchCatalog(
  query: string,
  options: CatalogSearchOptions = {},
): readonly CatalogEntry[] {
  const wanted = typeof query === 'string' ? fold(query) : '';
  const byKind =
    options.kind === undefined
      ? SEARCH_INDEX
      : SEARCH_INDEX.filter((indexed) => indexed.entry.kind === options.kind);

  const limit =
    options.limit === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.limit));

  if (wanted.length === 0) {
    return byKind.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
      .map((indexed) => indexed.entry);
  }

  const order = new Map(CATALOG.map((entry, index) => [entry.id, index]));
  const matches = byKind
    .map((indexed) => ({ indexed, score: score(indexed, wanted) }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        (order.get(left.indexed.entry.id) ?? 0) - (order.get(right.indexed.entry.id) ?? 0),
    )
    .map((candidate) => candidate.indexed.entry);

  return limit === Number.POSITIVE_INFINITY ? matches : matches.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Grouping, for the grid                                                      */
/* -------------------------------------------------------------------------- */

export interface CatalogGroup {
  readonly id: string;
  readonly title: string;
  readonly kind: CatalogKind;
  readonly entries: readonly CatalogEntry[];
}

/**
 * The catalogue in the sections a picker renders.
 *
 * Section titles are the app's words, not the enum's: a user reads "Streaming
 * & entertainment", never `video`. Empty groups are dropped so a filtered
 * catalogue never renders a header with nothing under it.
 */
const GROUP_DEFINITIONS: readonly {
  id: string;
  title: string;
  kind: CatalogKind;
  match: (entry: CatalogEntry) => boolean;
}[] = [
  {
    id: 'streaming',
    title: 'Streaming & entertainment',
    kind: 'subscription',
    match: (entry) =>
      entry.kind === 'subscription' &&
      (entry.category === 'video' ||
        entry.category === 'music' ||
        entry.category === 'entertainment'),
  },
  {
    id: 'digital',
    title: 'Apps, storage & games',
    kind: 'subscription',
    match: (entry) =>
      entry.kind === 'subscription' &&
      (entry.category === 'cloud' ||
        entry.category === 'software' ||
        entry.category === 'gaming'),
  },
  {
    id: 'memberships',
    title: 'Gyms & memberships',
    kind: 'subscription',
    match: (entry) =>
      entry.kind === 'subscription' &&
      (entry.category === 'fitness' ||
        entry.category === 'membership' ||
        entry.category === 'education' ||
        entry.category === 'news' ||
        entry.category === 'other' ||
        entry.category === 'utilities'),
  },
  {
    id: 'utilities',
    title: 'Utilities',
    kind: 'bill',
    match: (entry) =>
      entry.kind === 'bill' &&
      (entry.category === 'electricity' || entry.category === 'water'),
  },
  {
    id: 'connectivity',
    title: 'Internet, mobile & TV',
    kind: 'bill',
    match: (entry) =>
      entry.kind === 'bill' &&
      (entry.category === 'internet' ||
        entry.category === 'phone' ||
        entry.category === 'subscription'),
  },
  {
    id: 'home-and-government',
    title: 'Home, government & credit',
    kind: 'bill',
    match: (entry) =>
      entry.kind === 'bill' &&
      (entry.category === 'rent' ||
        entry.category === 'insurance' ||
        entry.category === 'credit_card' ||
        entry.category === 'loan' ||
        entry.category === 'other'),
  },
];

/** Group `entries` (defaults to the whole catalogue) into renderable sections. */
export function catalogGroups(
  entries: readonly CatalogEntry[] = CATALOG,
): readonly CatalogGroup[] {
  const groups: CatalogGroup[] = [];
  for (const definition of GROUP_DEFINITIONS) {
    const members = entries.filter((entry) => definition.match(entry));
    if (members.length === 0) continue;
    groups.push({
      id: definition.id,
      title: definition.title,
      kind: definition.kind,
      entries: members,
    });
  }
  return groups;
}

/**
 * Every entry lands in exactly one group.
 *
 * Asserted at module load rather than in a test alone: a category added to the
 * schema and used by a new entry, with no matching group, would otherwise make
 * that entry silently invisible in the picker — the one failure mode of this
 * feature that looks like nothing at all.
 */
function assertEveryEntryIsGrouped(): void {
  const grouped = new Set<string>();
  for (const group of catalogGroups()) {
    for (const entry of group.entries) {
      if (grouped.has(entry.id)) {
        throw new Error(`Catalog entry is in more than one group: ${entry.id}`);
      }
      grouped.add(entry.id);
    }
  }
  const missing = CATALOG.filter((entry) => !grouped.has(entry.id));
  if (missing.length > 0) {
    throw new Error(`Catalog entries belong to no group: ${missing.map((e) => e.id).join(', ')}`);
  }
}

assertEveryEntryIsGrouped();

/* -------------------------------------------------------------------------- */
/* Integrity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every structural rule this catalogue must obey, as data.
 *
 * `tests/onboarding-catalog.test.ts` runs these, and so does nothing else — but
 * keeping them here, next to the entries, is what makes the list editable by
 * someone who has not read the test file.
 */
export interface CatalogProblem {
  readonly id: string;
  readonly problem: string;
}

export function catalogProblems(): readonly CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  const seen = new Set<string>();

  for (const entry of CATALOG) {
    if (seen.has(entry.id)) problems.push({ id: entry.id, problem: 'duplicate id' });
    seen.add(entry.id);

    if (!/^[a-z0-9-]+$/.test(entry.id)) {
      problems.push({ id: entry.id, problem: 'id is not lower-kebab-case' });
    }
    if (entry.name.trim().length === 0) {
      problems.push({ id: entry.id, problem: 'empty name' });
    }
    if (!isBillingCycle(entry.billingCycle)) {
      problems.push({ id: entry.id, problem: 'billing cycle is not a schema cycle' });
    }
    // `custom` needs an interval the catalogue has no way to know, and a
    // catalogue entry that cannot be normalized would be excluded from every
    // total the payoff step shows.
    if (entry.billingCycle === 'custom') {
      problems.push({ id: entry.id, problem: 'custom cycle has no interval here' });
    }
    if (entry.currency !== DEFAULT_CURRENCY) {
      problems.push({ id: entry.id, problem: 'currency is not the §30 default' });
    }
    if (entry.hintMinor !== null && (!Number.isSafeInteger(entry.hintMinor) || entry.hintMinor <= 0)) {
      problems.push({ id: entry.id, problem: 'hint is not a positive integer of minor units' });
    }
    if (entry.kind === 'subscription') {
      if (!isSubscriptionCategory(entry.category)) {
        problems.push({ id: entry.id, problem: 'category is not a schema subscription category' });
      }
    } else if (!isBillCategory(entry.category)) {
      problems.push({ id: entry.id, problem: 'category is not a schema bill category' });
    }
  }

  return problems;
}
