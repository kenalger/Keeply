import { useEffect } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { isDev } from '@/lib/env';
import { useThemeMode, type ThemePreference } from '@/theme';

/**
 * Transient UI state.
 *
 * Everything here is ephemeral by design: it is rebuilt on every cold start and
 * never written to disk. Records live in SQLite; preferences live in
 * `app_settings` (see `settings-store`). This store is only for what the user
 * is currently *doing* — which chips are on, which sheet is open.
 */

/**
 * Which fixture the Home dashboard renders from, in development only.
 *
 *  - `off`   — the real (Phase 1: empty) data
 *  - `busy`  — overdue items, payments, expiries and renewals
 *  - `quiet` — records exist, but nothing needs the user: the sparse case,
 *              which is the one a redesign is most likely to get wrong
 */
export type SampleDashboardMode = 'off' | 'busy' | 'quiet';

export const SAMPLE_DASHBOARD_MODES: readonly SampleDashboardMode[] = ['off', 'busy', 'quiet'];

/** A screen that owns its own independent set of filter chips (§23). */
export type FilterScope = 'money' | 'vehicles' | 'documents' | 'receipts';

/** Bottom sheets and modals the shell can own. Phase 1 declares them; later phases fill them in. */
export type SheetId =
  | 'add-item'
  | 'money-filters'
  | 'vehicle-filters'
  | 'document-filters'
  | 'date-range';

/**
 * Theme preference is re-exported, not redefined: `@/theme` owns the type, and
 * `useThemeMode()` owns the resolved light/dark mode. This store only holds the
 * user's *stated* preference, so any screen can read or change it without
 * prop-drilling, and `useThemePreferenceSync()` passes it through to
 * `useThemeMode`.
 *
 * PHASE 7: persist via app_settings — until then this resets to `'system'` on
 * every cold start.
 */
export type { ThemePreference };

type FilterState = Readonly<Record<FilterScope, readonly string[]>>;

const NO_FILTERS: FilterState = {
  money: [],
  vehicles: [],
  documents: [],
  receipts: [],
};

interface UiState {
  filters: FilterState;
  openSheetId: SheetId | null;
  themePreference: ThemePreference;
  /**
   * Render Home from a sample dashboard instead of the real (empty) one.
   *
   * Development affordance only — `setSampleDashboard` refuses anything but
   * `'off'` in a release bundle, so there is no path by which fixture data can
   * be shown to a user. It exists because the populated and sparse dashboards
   * are otherwise unreachable until Phase 2 wires the queries, and an unseen
   * layout is an unverified one.
   */
  sampleDashboard: SampleDashboardMode;

  /** Turn one chip on/off within a scope. */
  toggleFilter: (scope: FilterScope, chipId: string) => void;
  /** Replace every chip in a scope at once. */
  setFilters: (scope: FilterScope, chipIds: readonly string[]) => void;
  /** Clear one scope, or all of them. */
  clearFilters: (scope?: FilterScope) => void;

  openSheet: (id: SheetId) => void;
  closeSheet: () => void;

  setThemePreference: (preference: ThemePreference) => void;
  setSampleDashboard: (mode: SampleDashboardMode) => void;
  /** Step to the next fixture. What the developer row in More calls. */
  cycleSampleDashboard: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  filters: NO_FILTERS,
  openSheetId: null,
  themePreference: 'system',
  sampleDashboard: 'off',

  toggleFilter: (scope, chipId) =>
    set((state) => {
      const current = state.filters[scope];
      const next = current.includes(chipId)
        ? current.filter((id) => id !== chipId)
        : [...current, chipId];
      return { filters: { ...state.filters, [scope]: next } };
    }),

  setFilters: (scope, chipIds) =>
    set((state) => ({ filters: { ...state.filters, [scope]: [...chipIds] } })),

  clearFilters: (scope) =>
    set((state) =>
      scope ? { filters: { ...state.filters, [scope]: [] } } : { filters: NO_FILTERS }
    ),

  openSheet: (id) => set({ openSheetId: id }),
  closeSheet: () => set({ openSheetId: null }),

  setThemePreference: (preference) => set({ themePreference: preference }),

  setSampleDashboard: (mode) => set({ sampleDashboard: isDev ? mode : 'off' }),

  cycleSampleDashboard: () =>
    set((state) => {
      if (!isDev) return { sampleDashboard: 'off' };
      const next = SAMPLE_DASHBOARD_MODES[
        (SAMPLE_DASHBOARD_MODES.indexOf(state.sampleDashboard) + 1) % SAMPLE_DASHBOARD_MODES.length
      ];
      return { sampleDashboard: next };
    }),
}));

/* -------------------------------------------------------------------------- */
/* Selectors                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * zustand v5 removed the automatic shallow comparison of selector results, so
 * any selector returning a fresh array or object must go through `useShallow`.
 * Selectors returning a primitive can be used directly.
 */
export const useActiveFilters = (scope: FilterScope): readonly string[] =>
  useUiStore(useShallow((s) => s.filters[scope]));

export const useIsFilterActive = (scope: FilterScope, chipId: string): boolean =>
  useUiStore((s) => s.filters[scope].includes(chipId));

export const useActiveFilterCount = (scope: FilterScope): number =>
  useUiStore((s) => s.filters[scope].length);

export const useIsSheetOpen = (id: SheetId): boolean => useUiStore((s) => s.openSheetId === id);

export const useThemePreference = (): ThemePreference => useUiStore((s) => s.themePreference);

/** Always `'off'` in a release bundle — see `UiState.sampleDashboard`. */
export const useSampleDashboard = (): SampleDashboardMode =>
  useUiStore((s) => (isDev ? s.sampleDashboard : 'off'));

/**
 * Passthrough: mirrors the stored preference into the theme runtime.
 *
 * `useThemeMode()` is a hook, so a zustand action cannot call it. Mounting this
 * once inside `<ThemeProvider>` keeps the two in step, which means a screen can
 * change the appearance by calling `setThemePreference` on the store and a
 * later phase can seed the store from `app_settings` without touching `@/theme`.
 */
export function useThemePreferenceSync(): void {
  const preference = useUiStore((s) => s.themePreference);
  const { setPreference } = useThemeMode();

  useEffect(() => {
    setPreference(preference);
  }, [preference, setPreference]);
}
