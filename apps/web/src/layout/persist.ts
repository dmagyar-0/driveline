// T6.2 · Layout + panel-binding persistence.
//
// The whole layout slice (FlexLayout JSON model + per-panel video/plot/
// scene/map/table/enum bindings) serialises to a single `localStorage`
// key so a reload restores exactly what the user last saw. The adapter
// is a pure module — it takes an injectable `Storage` so Vitest's node
// env can round-trip against an in-memory stub without touching a real
// browser.
//
// Schema is versioned: on mismatch we return `null` and the store falls
// back to the default layout. Bumping the version means bumping the key
// too so stale v1/v2 payloads don't collide with future reads.
//
// Phase 5 bumped to v2 to add `videoHudOn` (per-panel HUD overlay bit
// lifted out of `VideoPanel` local state). Phase 6 bumps to v3 to add
// the four new panel-kind binding maps (`sceneBindings`, `mapBindings`,
// `tableBindings`, `enumBindings`). v1/v2 payloads return `null` from
// `validate()`, which intentionally drops the user's old layout/bindings
// — acceptable per the existing fail-closed posture; pre-v1 app stage.
//
// `attachLayoutPersistence` wires the Zustand subscribe → Storage write
// loop; the first post-hydration fire is skipped so we don't rewrite the
// exact payload we just loaded.

import type { useSession } from "../state/store";

export const LAYOUT_STORAGE_KEY = "driveline.layout.v3";
export const LAYOUT_SCHEMA_VERSION = 3 as const;

export interface MapBinding {
  latChannelId: string;
  lonChannelId: string;
}

export interface PersistedLayout {
  version: typeof LAYOUT_SCHEMA_VERSION;
  layoutJson: unknown | null;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  videoHudOn: Record<string, boolean>;
  sceneBindings: Record<string, string | null>;
  mapBindings: Record<string, MapBinding | null>;
  tableBindings: Record<string, string[]>;
  enumBindings: Record<string, string | null>;
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

function isNullableStringMap(
  v: unknown,
): v is Record<string, string | null> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x !== null && typeof x !== "string") return false;
  }
  return true;
}

function isStringArrayMap(v: unknown): v is Record<string, string[]> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    if (!isStringArray(v[k])) return false;
  }
  return true;
}

function isMapBindingMap(
  v: unknown,
): v is Record<string, MapBinding | null> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x === null) continue;
    if (!isPlainObject(x)) return false;
    if (typeof x.latChannelId !== "string") return false;
    if (typeof x.lonChannelId !== "string") return false;
  }
  return true;
}

function validate(raw: unknown): PersistedLayout | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== LAYOUT_SCHEMA_VERSION) return null;
  if (!isNullableStringMap(raw.videoBindings)) return null;
  if (!isStringArrayMap(raw.plotBindings)) return null;
  if (!isPlainObject(raw.videoHudOn)) return null;
  for (const k of Object.keys(raw.videoHudOn)) {
    if (typeof raw.videoHudOn[k] !== "boolean") return null;
  }
  if (!isNullableStringMap(raw.sceneBindings)) return null;
  if (!isMapBindingMap(raw.mapBindings)) return null;
  if (!isStringArrayMap(raw.tableBindings)) return null;
  if (!isNullableStringMap(raw.enumBindings)) return null;
  return {
    version: LAYOUT_SCHEMA_VERSION,
    layoutJson: raw.layoutJson ?? null,
    videoBindings: raw.videoBindings,
    plotBindings: raw.plotBindings,
    videoHudOn: raw.videoHudOn as Record<string, boolean>,
    sceneBindings: raw.sceneBindings,
    mapBindings: raw.mapBindings,
    tableBindings: raw.tableBindings,
    enumBindings: raw.enumBindings,
  };
}

export function loadLayoutFromStorage(
  storage: Storage | undefined = defaultStorage(),
): PersistedLayout | null {
  if (!storage) return null;
  let text: string | null;
  try {
    text = storage.getItem(LAYOUT_STORAGE_KEY);
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

export function saveLayoutToStorage(
  p: PersistedLayout,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Quota errors / private-mode bucket reject: best-effort only. The
    // next mutation will try again.
  }
}

// The minimal slice the adapter cares about. Keeps the persist module
// decoupled from the full `SessionState` surface for tests.
export interface LayoutSlice {
  layoutJson: unknown | null;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  videoHudOn: Record<string, boolean>;
  sceneBindings: Record<string, string | null>;
  mapBindings: Record<string, MapBinding | null>;
  tableBindings: Record<string, string[]>;
  enumBindings: Record<string, string | null>;
}

function snapshot(s: LayoutSlice): PersistedLayout {
  return {
    version: LAYOUT_SCHEMA_VERSION,
    layoutJson: s.layoutJson,
    videoBindings: s.videoBindings,
    plotBindings: s.plotBindings,
    videoHudOn: s.videoHudOn,
    sceneBindings: s.sceneBindings,
    mapBindings: s.mapBindings,
    tableBindings: s.tableBindings,
    enumBindings: s.enumBindings,
  };
}

export function attachLayoutPersistence(
  store: typeof useSession,
  storage: Storage | undefined = defaultStorage(),
): () => void {
  if (!storage) return () => undefined;
  // Seed the "last written" snapshot with current state so the very first
  // subscribe fire — which may be identical to what hydration just loaded —
  // doesn't re-stringify and write. We only write when a field actually
  // differs from the last write.
  let last = snapshot(store.getState());
  return store.subscribe((s: LayoutSlice) => {
    if (
      s.layoutJson === last.layoutJson &&
      s.videoBindings === last.videoBindings &&
      s.plotBindings === last.plotBindings &&
      s.videoHudOn === last.videoHudOn &&
      s.sceneBindings === last.sceneBindings &&
      s.mapBindings === last.mapBindings &&
      s.tableBindings === last.tableBindings &&
      s.enumBindings === last.enumBindings
    ) {
      return;
    }
    last = snapshot(s);
    saveLayoutToStorage(last, storage);
  });
}
