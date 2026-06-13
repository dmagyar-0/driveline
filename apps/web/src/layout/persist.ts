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
// Phase 8 added `plotPanelSettings` as an OPTIONAL v3 field rather than
// bumping to v4, so users who already had saved layouts don't lose them
// on first load with the new field. New writes always include the
// field; old reads default it to `{}`. `valueBindings` (the Value
// panel's per-panel channel lists) was added the same way — optional on
// read, always written — so existing v3 layouts survive untouched.
//
// `enumBindings` later changed shape (single channel-or-null per panel →
// a multi-channel list, one state strip per bound channel). Rather than
// bump the schema and drop every saved layout, `validate()` migrates the
// legacy shape on read via `coerceEnumBindings` (`null`/`""` → `[]`,
// `"id"` → `["id"]`). New writes are always `string[]`, so the key stays
// v3 and existing layouts survive the upgrade.
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

// Per-video-panel point-cloud overlay binding (docs/13). Ties a video panel to
// (a) a loaded calibration channel, (b) a named camera within that calibration,
// and (c) the LiDAR point-cloud channel whose spins are projected onto the
// frame. Persisted in the layout shard like `MapBinding` — an object-valued,
// per-panel binding.
export interface PointCloudOverlayBinding {
  calibrationChannelId: string;
  cameraName: string;
  pointcloudChannelId: string;
}

export interface PlotPanelSettingsLite {
  gapThresholdSec: number | null;
  // Per-channel-id → 0-based y-axis index. Optional (additive field).
  axisAssignments?: Record<string, number>;
  // Stack the in-use y-axes into vertical bands. Optional (additive field).
  stackAxes?: boolean;
  // Sync the time (x) axis with other synced plots. Optional (additive
  // field); absent ⇒ synced (the default), so only `false` is persisted.
  syncTimeAxis?: boolean;
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
  valueBindings: Record<string, string[]>;
  enumBindings: Record<string, string[]>;
  plotPanelSettings: Record<string, PlotPanelSettingsLite>;
  // Per-video-panel point-cloud overlay bindings (docs/13). Optional/additive
  // like `valueBindings`: payloads written before this existed default to `{}`.
  pointCloudOverlays: Record<string, PointCloudOverlayBinding | null>;
  // Global per-channel unit overrides, keyed by channel id.
  unitOverrides: Record<string, string>;
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

function isNullableStringMap(v: unknown): v is Record<string, string | null> {
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

// Migrate `enumBindings` on read. The field used to hold one channel id
// (or `null`) per panel; it now holds a list, so accept BOTH shapes and
// coerce the legacy one: `null`/`""` → `[]`, `"id"` → `["id"]`, and an
// existing `string[]` passes through. Returns `null` only for a value
// that is neither a string, null, nor a string array — i.e. genuine
// corruption — so a pre-migration layout still loads. Exported for reuse
// by the named-layouts adapter, which carries the same field.
export function coerceEnumBindings(
  v: unknown,
): Record<string, string[]> | null {
  if (!isPlainObject(v)) return null;
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (isStringArray(x)) out[k] = x;
    else if (x === null) out[k] = [];
    else if (typeof x === "string") out[k] = x.length > 0 ? [x] : [];
    else return null;
  }
  return out;
}

function isMapBindingMap(v: unknown): v is Record<string, MapBinding | null> {
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

function isPointCloudOverlayMap(
  v: unknown,
): v is Record<string, PointCloudOverlayBinding | null> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x === null) continue;
    if (!isPlainObject(x)) return false;
    if (typeof x.calibrationChannelId !== "string") return false;
    if (typeof x.cameraName !== "string") return false;
    if (typeof x.pointcloudChannelId !== "string") return false;
  }
  return true;
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    if (typeof v[k] !== "string") return false;
  }
  return true;
}

function isAxisAssignmentMap(v: unknown): v is Record<string, number> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0) return false;
  }
  return true;
}

function isPlotPanelSettingsMap(
  v: unknown,
): v is Record<string, PlotPanelSettingsLite> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (!isPlainObject(x)) return false;
    const t = x.gapThresholdSec;
    // Reject NaN / Infinity so we don't restore a junk value that the
    // store would just normalise away anyway. The store's setter
    // already guards on write; this guards on read.
    if (t !== null && (typeof t !== "number" || !Number.isFinite(t))) {
      return false;
    }
    // Optional, additive field — only validate when present.
    if (
      x.axisAssignments !== undefined &&
      !isAxisAssignmentMap(x.axisAssignments)
    ) {
      return false;
    }
    if (x.stackAxes !== undefined && typeof x.stackAxes !== "boolean") {
      return false;
    }
    if (x.syncTimeAxis !== undefined && typeof x.syncTimeAxis !== "boolean") {
      return false;
    }
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
  const enumBindings = coerceEnumBindings(raw.enumBindings);
  if (!enumBindings) return null;
  // Optional v3 fields — payloads written before these existed don't have
  // them. Default to an empty map so older saved layouts round-trip
  // cleanly (same posture as `plotPanelSettings`).
  const settings = raw.plotPanelSettings ?? {};
  if (!isPlotPanelSettingsMap(settings)) return null;
  const valueBindings = raw.valueBindings ?? {};
  if (!isStringArrayMap(valueBindings)) return null;
  const pointCloudOverlays = raw.pointCloudOverlays ?? {};
  if (!isPointCloudOverlayMap(pointCloudOverlays)) return null;
  const unitOverrides = raw.unitOverrides ?? {};
  if (!isStringMap(unitOverrides)) return null;
  return {
    version: LAYOUT_SCHEMA_VERSION,
    layoutJson: raw.layoutJson ?? null,
    videoBindings: raw.videoBindings,
    plotBindings: raw.plotBindings,
    videoHudOn: raw.videoHudOn as Record<string, boolean>,
    sceneBindings: raw.sceneBindings,
    mapBindings: raw.mapBindings,
    tableBindings: raw.tableBindings,
    valueBindings,
    enumBindings,
    plotPanelSettings: settings,
    pointCloudOverlays,
    unitOverrides,
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
  valueBindings: Record<string, string[]>;
  enumBindings: Record<string, string[]>;
  plotPanelSettings: Record<string, PlotPanelSettingsLite>;
  pointCloudOverlays: Record<string, PointCloudOverlayBinding | null>;
  unitOverrides: Record<string, string>;
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
    valueBindings: s.valueBindings,
    enumBindings: s.enumBindings,
    plotPanelSettings: s.plotPanelSettings,
    pointCloudOverlays: s.pointCloudOverlays,
    unitOverrides: s.unitOverrides,
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
      s.valueBindings === last.valueBindings &&
      s.enumBindings === last.enumBindings &&
      s.plotPanelSettings === last.plotPanelSettings &&
      s.pointCloudOverlays === last.pointCloudOverlays &&
      s.unitOverrides === last.unitOverrides
    ) {
      return;
    }
    last = snapshot(s);
    saveLayoutToStorage(last, storage);
  });
}
