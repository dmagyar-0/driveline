// One source of truth for the per-panel binding maps that travel together
// through every snapshot / restore / clear / remove path.
//
// Historically the 9-plus binding maps were hand-enumerated in ~8 places
// (the `WorkspaceSnapshot` type, `saveCurrentLayoutAs`, `restoreNamedLayout`,
// `applyDemoWorkspace`, `clear`, `removeSource`, `layout/persist.ts`, and
// `persist/namedLayouts.ts`). Adding a new panel-binding map meant touching
// all of them, and it was easy to miss one — which is exactly how the
// named-layout snapshot drifted out of sync with the live-layout shard,
// silently dropping `videoHudOn` / `pointCloudOverlays` / `unitOverrides`.
//
// `BindingMaps` is the canonical shape; `EMPTY_BINDINGS` is the reset value
// (used by `clear()`); `cloneBindings` deep-copies the maps for a snapshot
// (`saveCurrentLayoutAs`); `pickBindings` extracts them from a larger state
// object (used when applying a restore / demo snapshot). Adding a panel
// binding map is now a one-line change here plus its store field.

import type { MapBinding, PointCloudOverlayBinding } from "../layout/persist";
import type { PlotPanelSettings } from "./store";

/** Every per-panel binding / settings map that round-trips through a layout
 *  snapshot. `layoutJson` is carried alongside these but is not itself a map,
 *  so it stays out of this shape. */
export interface BindingMaps {
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  videoHudOn: Record<string, boolean>;
  sceneBindings: Record<string, string | null>;
  mapBindings: Record<string, MapBinding | null>;
  tableBindings: Record<string, string[]>;
  valueBindings: Record<string, string[]>;
  enumBindings: Record<string, string[]>;
  plotPanelSettings: Record<string, PlotPanelSettings>;
  pointCloudOverlays: Record<string, PointCloudOverlayBinding | null>;
  unitOverrides: Record<string, string>;
}

/** The empty binding set — every map starts blank. Returns a fresh object
 *  each call so callers can hand it straight to `set(...)` without aliasing a
 *  shared reference. */
export function emptyBindings(): BindingMaps {
  return {
    videoBindings: {},
    plotBindings: {},
    videoHudOn: {},
    sceneBindings: {},
    mapBindings: {},
    tableBindings: {},
    valueBindings: {},
    enumBindings: {},
    plotPanelSettings: {},
    pointCloudOverlays: {},
    unitOverrides: {},
  };
}

/** Extract just the binding maps from any state object that carries them. */
export function pickBindings(s: BindingMaps): BindingMaps {
  return {
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

/** Shallow-clone each map (one level — the values themselves are treated as
 *  immutable) so a saved snapshot is decoupled from subsequent live edits. */
export function cloneBindings(s: BindingMaps): BindingMaps {
  return {
    videoBindings: { ...s.videoBindings },
    plotBindings: { ...s.plotBindings },
    videoHudOn: { ...s.videoHudOn },
    sceneBindings: { ...s.sceneBindings },
    mapBindings: { ...s.mapBindings },
    tableBindings: { ...s.tableBindings },
    valueBindings: { ...s.valueBindings },
    enumBindings: { ...s.enumBindings },
    plotPanelSettings: { ...s.plotPanelSettings },
    pointCloudOverlays: { ...s.pointCloudOverlays },
    unitOverrides: { ...s.unitOverrides },
  };
}
