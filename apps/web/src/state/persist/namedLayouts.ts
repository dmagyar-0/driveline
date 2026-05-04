// Phase 4 · Named-layouts persistence. Phase 6 bumped to v2 to carry
// the four new panel-kind binding maps in saved layouts so a restore
// brings back scene/map/table/enum panels intact.
//
// Mirrors `state/persist/ui.ts` and `layout/persist.ts`: schema-versioned
// JSON in a single `localStorage` key, fail-closed validation, write-on-
// change subscriber that skips identical fires. The `namedLayouts` slice
// is independent of session lifetime (saved layouts outlive a
// `clearSession`, like bookmarks will in Phase 8).
//
// No BigInts in this slice — panel ids, channel ids, and the user-typed
// name are strings; `createdAt` is a millisecond `number`. So unlike the
// (future) bookmarks adapter no string-encoding round-trip is needed.

import type { useSession } from "../store";
import type { MapBinding, PlotPanelSettingsLite } from "../../layout/persist";

export const NAMED_LAYOUTS_STORAGE_KEY = "driveline.layouts.named.v2";
export const NAMED_LAYOUTS_SCHEMA_VERSION = 2 as const;

export interface NamedLayout {
  id: string;
  name: string;
  layoutJson: unknown;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  sceneBindings: Record<string, string | null>;
  mapBindings: Record<string, MapBinding | null>;
  tableBindings: Record<string, string[]>;
  enumBindings: Record<string, string | null>;
  // Phase 8 · added as an OPTIONAL v2 field rather than bumping the
  // schema, so saved-layout entries created before per-panel settings
  // existed don't get dropped on read. New writes always include it.
  plotPanelSettings: Record<string, PlotPanelSettingsLite>;
  createdAt: number;
}

export interface PersistedNamedLayouts {
  version: typeof NAMED_LAYOUTS_SCHEMA_VERSION;
  layouts: NamedLayout[];
  activeNamedLayoutId: string | null;
}

function defaultStorage(): Storage | undefined {
  return typeof localStorage !== "undefined" ? localStorage : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validateNullableStringMap(
  v: unknown,
): Record<string, string | null> | null {
  if (!isPlainObject(v)) return null;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x !== null && typeof x !== "string") return null;
  }
  return v as Record<string, string | null>;
}

function validateStringArrayMap(
  v: unknown,
): Record<string, string[]> | null {
  if (!isPlainObject(v)) return null;
  for (const k of Object.keys(v)) {
    if (!isStringArray(v[k])) return null;
  }
  return v as Record<string, string[]>;
}

function validateMapBindingMap(
  v: unknown,
): Record<string, MapBinding | null> | null {
  if (!isPlainObject(v)) return null;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x === null) continue;
    if (!isPlainObject(x)) return null;
    if (typeof x.latChannelId !== "string") return null;
    if (typeof x.lonChannelId !== "string") return null;
  }
  return v as Record<string, MapBinding | null>;
}

function validatePlotPanelSettingsMap(
  v: unknown,
): Record<string, PlotPanelSettingsLite> | null {
  if (!isPlainObject(v)) return null;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (!isPlainObject(x)) return null;
    const t = x.gapThresholdSec;
    if (t !== null && (typeof t !== "number" || !Number.isFinite(t))) {
      return null;
    }
  }
  return v as Record<string, PlotPanelSettingsLite>;
}

function validateLayout(raw: unknown): NamedLayout | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.name !== "string") return null;
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) {
    return null;
  }
  const videoBindings = validateNullableStringMap(raw.videoBindings);
  if (!videoBindings) return null;
  const plotBindings = validateStringArrayMap(raw.plotBindings);
  if (!plotBindings) return null;
  const sceneBindings = validateNullableStringMap(raw.sceneBindings);
  if (!sceneBindings) return null;
  const mapBindings = validateMapBindingMap(raw.mapBindings);
  if (!mapBindings) return null;
  const tableBindings = validateStringArrayMap(raw.tableBindings);
  if (!tableBindings) return null;
  const enumBindings = validateNullableStringMap(raw.enumBindings);
  if (!enumBindings) return null;
  // Optional Phase 8 field — entries saved before per-panel settings
  // existed default to an empty map.
  const plotPanelSettings = validatePlotPanelSettingsMap(
    raw.plotPanelSettings ?? {},
  );
  if (!plotPanelSettings) return null;
  return {
    id: raw.id,
    name: raw.name,
    layoutJson: raw.layoutJson ?? null,
    videoBindings,
    plotBindings,
    sceneBindings,
    mapBindings,
    tableBindings,
    enumBindings,
    plotPanelSettings,
    createdAt: raw.createdAt,
  };
}

function validate(raw: unknown): PersistedNamedLayouts | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== NAMED_LAYOUTS_SCHEMA_VERSION) return null;
  if (!Array.isArray(raw.layouts)) return null;
  const layouts: NamedLayout[] = [];
  for (const l of raw.layouts) {
    const v = validateLayout(l);
    if (!v) return null;
    layouts.push(v);
  }
  const active = raw.activeNamedLayoutId;
  if (active !== null && typeof active !== "string") return null;
  // Fail closed: an active id that doesn't match any saved layout is
  // treated as null rather than rejected — the user has nothing to gain
  // from us discarding the whole slice over a stale pointer.
  const activeId =
    active !== null && layouts.some((l) => l.id === active) ? active : null;
  return {
    version: NAMED_LAYOUTS_SCHEMA_VERSION,
    layouts,
    activeNamedLayoutId: activeId,
  };
}

export function loadNamedLayoutsFromStorage(
  storage: Storage | undefined = defaultStorage(),
): PersistedNamedLayouts | null {
  if (!storage) return null;
  let text: string | null;
  try {
    text = storage.getItem(NAMED_LAYOUTS_STORAGE_KEY);
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

export function saveNamedLayoutsToStorage(
  p: PersistedNamedLayouts,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(NAMED_LAYOUTS_STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Quota / private-mode bucket reject — best-effort only.
  }
}

export interface NamedLayoutsSlice {
  namedLayouts: NamedLayout[];
  activeNamedLayoutId: string | null;
}

function snapshot(s: NamedLayoutsSlice): PersistedNamedLayouts {
  return {
    version: NAMED_LAYOUTS_SCHEMA_VERSION,
    layouts: s.namedLayouts,
    activeNamedLayoutId: s.activeNamedLayoutId,
  };
}

export function attachNamedLayoutsPersistence(
  store: typeof useSession,
  storage: Storage | undefined = defaultStorage(),
): () => void {
  if (!storage) return () => undefined;
  let last = snapshot(store.getState());
  return store.subscribe((s: NamedLayoutsSlice) => {
    if (
      s.namedLayouts === last.layouts &&
      s.activeNamedLayoutId === last.activeNamedLayoutId
    ) {
      return;
    }
    last = snapshot(s);
    saveNamedLayoutsToStorage(last, storage);
  });
}
