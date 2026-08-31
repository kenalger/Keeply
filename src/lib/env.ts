/**
 * Build/runtime environment facts.
 *
 * Deliberately tiny and dependency-free: this module is imported by the logger
 * and by boot code, so it must not pull in anything that could fail to load.
 */

/**
 * `__DEV__` is injected by the React Native bundler. It is `true` for
 * development bundles (Metro, dev client) and `false` for release bundles.
 */
export const isDev: boolean = typeof __DEV__ === 'boolean' ? __DEV__ : false;

/** Release/production bundle. */
export const isProduction: boolean = !isDev;

/**
 * OFFLINE_ONLY — Keeply is an offline-first personal vault (§1, §34).
 *
 * INVARIANT: no code path in this application may *require* network
 * connectivity to succeed. There is no backend, no account, no remote config
 * and no analytics endpoint. Every create/read/update/delete, every search,
 * every dashboard calculation, every notification and the entire boot sequence
 * must complete with Wi-Fi off, mobile data off and airplane mode on.
 *
 * If a future feature ever needs the network (e.g. opt-in cloud backup), it
 * must be strictly additive: the user explicitly enables it, and its failure
 * must never degrade any local capability. Never gate local work behind a
 * connectivity check — not even a "are we online?" probe, because that probe
 * itself becomes a stall on a plane.
 *
 * This constant exists so the invariant is greppable and reviewable.
 */
export const OFFLINE_ONLY = true as const;

/** Only currency supported in the MVP (§30). Values are stored numerically. */
export const DEFAULT_CURRENCY = 'PHP' as const;
