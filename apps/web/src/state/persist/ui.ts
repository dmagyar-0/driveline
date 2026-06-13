// Phase 1 · UI shell persistence.
//
// Mirrors `apps/web/src/layout/persist.ts` exactly: schema-versioned
// JSON in a single `localStorage` key, fail-closed validation, write-on-
// change subscriber that skips identical fires. The `ui` slice covers
// the rail's drawer state across reloads — `selectedPanelId` is per-
// session and is intentionally not persisted (Phase 7 owns that
// decision).

import type { useSession } from "../store";

export const UI_STORAGE_KEY = "driveline.ui.v1";
export const UI_SCHEMA_VERSION = 1 as const;

// Left settings drawer width (px). Default mirrors the historical fixed
// 220px column; the user can drag the splitter between these bounds. The
// max keeps the drawer from swallowing the workspace on a laptop screen.
export const DRAWER_WIDTH_MIN = 220;
export const DRAWER_WIDTH_MAX = 560;
export const DRAWER_WIDTH_DEFAULT = 220;

/** Clamp an arbitrary number into the drawer-width range, rounding to a
 *  whole pixel. Non-finite input (NaN from a corrupt blob) falls back to
 *  the default. */
export function clampDrawerWidth(px: number): number {
  if (!Number.isFinite(px)) return DRAWER_WIDTH_DEFAULT;
  return Math.round(Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, px)));
}

export type RailTab =
  | "sources"
  | "channels"
  | "layout"
  | "panel"
  | "events"
  | "formats";

const RAIL_TABS: readonly RailTab[] = [
  "sources",
  "channels",
  "layout",
  "panel",
  "events",
  "formats",
];

export interface PersistedUi {
  version: typeof UI_SCHEMA_VERSION;
  activeRailTab: RailTab | null;
  railCollapsed: boolean;
  drawerWidth: number;
}

function defaultStorage(): Storage | undefined {
  return typeof localStorage !== "undefined" ? localStorage : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRailTab(v: unknown): v is RailTab {
  return typeof v === "string" && (RAIL_TABS as readonly string[]).includes(v);
}

function validate(raw: unknown): PersistedUi | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== UI_SCHEMA_VERSION) return null;
  const tab = raw.activeRailTab;
  if (tab !== null && !isRailTab(tab)) return null;
  if (typeof raw.railCollapsed !== "boolean") return null;
  // `drawerWidth` was added after v1 first shipped, so a stored blob may
  // lack it. Treat a missing/invalid value as "use the default" rather
  // than rejecting the whole blob — that would needlessly drop the user's
  // rail tab + collapse state. Anything present is clamped into range.
  const drawerWidth = clampDrawerWidth(
    typeof raw.drawerWidth === "number"
      ? raw.drawerWidth
      : DRAWER_WIDTH_DEFAULT,
  );
  return {
    version: UI_SCHEMA_VERSION,
    activeRailTab: tab,
    railCollapsed: raw.railCollapsed,
    drawerWidth,
  };
}

export function loadUiFromStorage(
  storage: Storage | undefined = defaultStorage(),
): PersistedUi | null {
  if (!storage) return null;
  let text: string | null;
  try {
    text = storage.getItem(UI_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validate(parsed);
}

export function saveUiToStorage(
  p: PersistedUi,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Quota / private-mode bucket reject — best-effort only.
  }
}

export interface UiSlice {
  activeRailTab: RailTab | null;
  railCollapsed: boolean;
  drawerWidth: number;
}

function snapshot(s: UiSlice): PersistedUi {
  return {
    version: UI_SCHEMA_VERSION,
    activeRailTab: s.activeRailTab,
    railCollapsed: s.railCollapsed,
    drawerWidth: s.drawerWidth,
  };
}

export function attachUiPersistence(
  store: typeof useSession,
  storage: Storage | undefined = defaultStorage(),
): () => void {
  if (!storage) return () => undefined;
  let last = snapshot(store.getState());
  return store.subscribe((s: UiSlice) => {
    if (
      s.activeRailTab === last.activeRailTab &&
      s.railCollapsed === last.railCollapsed &&
      s.drawerWidth === last.drawerWidth
    ) {
      return;
    }
    last = snapshot(s);
    saveUiToStorage(last, storage);
  });
}
