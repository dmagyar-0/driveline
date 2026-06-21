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
import type {
  MapBinding,
  PlotPanelSettingsLite,
  PointCloudOverlayBinding,
} from "../../layout/persist";
import { coerceEnumBindings } from "../../layout/persist";
import {
  isPlainObject,
  isStringMap,
  isNullableStringMap,
  isStringArrayMap,
  isBooleanMap,
  isMapBindingMap,
  isPointCloudOverlayMap,
  isPlotPanelSettingsMap,
} from "./validators";

// v3 (forward-migrated from v2) carries the same field set the live-layout
// shard persists — adding `videoHudOn`, `pointCloudOverlays`, and
// `unitOverrides` so saving + restoring a named layout no longer loses the
// per-panel HUD bit, point-cloud overlays, or unit overrides. A v2 payload
// is migrated forward on read (those three default to `{}`) rather than
// dropped, so existing saved layouts survive the upgrade.
export const NAMED_LAYOUTS_STORAGE_KEY = "driveline.layouts.named.v3";
const NAMED_LAYOUTS_STORAGE_KEY_V2 = "driveline.layouts.named.v2";
export const NAMED_LAYOUTS_SCHEMA_VERSION = 3 as const;

export interface NamedLayout {
  id: string;
  name: string;
  layoutJson: unknown;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  sceneBindings: Record<string, string | null>;
  mapBindings: Record<string, MapBinding | null>;
  tableBindings: Record<string, string[]>;
  // Multi-channel (one state strip per bound channel). Legacy single-string
  // entries are migrated on read by `coerceEnumBindings`.
  enumBindings: Record<string, string[]>;
  // Optional fields added without a schema bump (same posture as
  // `layout/persist.ts`): entries saved before these existed default to
  // an empty map on read. New writes always include them.
  valueBindings: Record<string, string[]>;
  plotPanelSettings: Record<string, PlotPanelSettingsLite>;
  // v3 additions — match the live-layout shard so a restore brings back the
  // per-panel HUD bit, point-cloud overlays, and unit overrides. Optional on
  // read (default `{}`) so a v2 entry migrates forward cleanly.
  videoHudOn: Record<string, boolean>;
  pointCloudOverlays: Record<string, PointCloudOverlayBinding | null>;
  unitOverrides: Record<string, string>;
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

/** Validate a single saved layout entry. The three v3 maps (`videoHudOn`,
 *  `pointCloudOverlays`, `unitOverrides`) are optional on read and default to
 *  `{}` — that same path forward-migrates a v2 entry, where they're absent. */
function validateLayout(raw: unknown): NamedLayout | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.name !== "string") return null;
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) {
    return null;
  }
  if (!isNullableStringMap(raw.videoBindings)) return null;
  if (!isStringArrayMap(raw.plotBindings)) return null;
  if (!isNullableStringMap(raw.sceneBindings)) return null;
  if (!isMapBindingMap(raw.mapBindings)) return null;
  if (!isStringArrayMap(raw.tableBindings)) return null;
  // Migrated single→multi on read (see `coerceEnumBindings`) so layouts
  // saved before the enum panel went multi-channel still restore.
  const enumBindings = coerceEnumBindings(raw.enumBindings);
  if (!enumBindings) return null;
  // Optional fields — entries saved before they existed default to an
  // empty map.
  const settings = raw.plotPanelSettings ?? {};
  if (!isPlotPanelSettingsMap(settings)) return null;
  const valueBindings = raw.valueBindings ?? {};
  if (!isStringArrayMap(valueBindings)) return null;
  // v3 fields. Present ⇒ validate; absent ⇒ `{}` (the v2→v3 migration also
  // hits this path with `expectVersion === 2`, where they're always absent).
  const videoHudOn = raw.videoHudOn ?? {};
  if (!isBooleanMap(videoHudOn)) return null;
  const pointCloudOverlays = raw.pointCloudOverlays ?? {};
  if (!isPointCloudOverlayMap(pointCloudOverlays)) return null;
  const unitOverrides = raw.unitOverrides ?? {};
  if (!isStringMap(unitOverrides)) return null;
  return {
    id: raw.id,
    name: raw.name,
    layoutJson: raw.layoutJson ?? null,
    videoBindings: raw.videoBindings,
    plotBindings: raw.plotBindings,
    sceneBindings: raw.sceneBindings,
    mapBindings: raw.mapBindings,
    tableBindings: raw.tableBindings,
    enumBindings,
    valueBindings,
    plotPanelSettings: settings,
    videoHudOn,
    pointCloudOverlays,
    unitOverrides,
    createdAt: raw.createdAt,
  };
}

function validateWith(
  raw: unknown,
  onDiskVersion: 2 | 3,
): PersistedNamedLayouts | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== onDiskVersion) return null;
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

function validate(raw: unknown): PersistedNamedLayouts | null {
  return validateWith(raw, NAMED_LAYOUTS_SCHEMA_VERSION);
}

/** Migrate a legacy v2 payload forward: same field set minus the three v3
 *  maps, which default to `{}`. */
function migrateV2(raw: unknown): PersistedNamedLayouts | null {
  return validateWith(raw, 2);
}

export function loadNamedLayoutsFromStorage(
  storage: Storage | undefined = defaultStorage(),
): PersistedNamedLayouts | null {
  if (!storage) return null;
  // Prefer the current v3 payload (present → trust it, fail closed on a
  // malformed body without falling through to the legacy key).
  let v3Text: string | null;
  try {
    v3Text = storage.getItem(NAMED_LAYOUTS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (v3Text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v3Text);
    } catch {
      return null;
    }
    return validate(parsed);
  }
  // No v3 yet — migrate a legacy v2 payload forward so saved layouts survive
  // the upgrade (the three new maps default to `{}`).
  let v2Text: string | null;
  try {
    v2Text = storage.getItem(NAMED_LAYOUTS_STORAGE_KEY_V2);
  } catch {
    return null;
  }
  if (v2Text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v2Text);
  } catch {
    return null;
  }
  return migrateV2(parsed);
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
