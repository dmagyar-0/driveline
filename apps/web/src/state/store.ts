// Zustand store. Scope:
// - session slice (T2.4): sources, flat channel list, union `globalRange`
// - transport slice (T3.1): cursorNs, playing, speed
// - layout + bindings slice (T6.2): FlexLayout JSON model plus per-panel
//   video/plot channel bindings keyed by panel id
//
// The store is worker-aware: it holds the `Remote<DataCoreApi>` proxy and
// dispatches to the correct `open_*` / `close_*` WASM function based on the
// bucketed file type. Each live `SourceMeta` carries the wasm slab handle
// so `clear()` can tear everything down without a separate handle table.
//
// Layout + bindings are hydrated synchronously from `localStorage` at
// store-create time so the first render already has the saved layout and
// we avoid a default-then-swap flash.
//
// STRUCTURE (STATE-01/02/03/06): the god-file has been carved into cohesive
// leaf modules — `types.ts` (every shared type + the `SessionState` contract),
// `channels.ts` (pure summary→`Channel[]` builders + range/id helpers),
// `ingest/sourceOpeners.ts` (the `SOURCE_OPENERS` dispatch table the open
// loops drive), and `bookmarks.ts` (the event-tag slice). This file is now the
// factory that wires the worker, the derived index, the binding/zoom/layout
// actions, and the ingestion FSM together, plus a thin barrel that re-exports
// the public surface so the `./store` import path is unchanged for every
// external consumer.

import type { Remote } from "comlink";
import { create } from "zustand";
import {
  bucketFiles,
  classifyUrl,
  sniffAlpamayoLidar,
  sniffCalibration,
  sniffDrivelineMap,
  sniffOpenlabel,
  sniffTrajectory,
  type BucketError,
} from "./bucket";
import { draftFromSchema, draftToBasis, basisToJson } from "./tabularImport";
import type { Recipe } from "./recipe";
import { matchRecipe, saveRecipe, removeRecipe } from "./formatRegistry";
import { MAX_PLOT_SERIES } from "../panels/palette";
import { clearPointCloudSpinCache } from "../panels/pointCloudSpinCache";
import { loadLayoutFromStorage } from "../layout/persist";
import {
  decodeCalibration,
  type CameraCalibration,
} from "../panels/calibrationFromArrow";
import {
  loadUiFromStorage,
  clampDrawerWidth,
  DRAWER_WIDTH_DEFAULT,
} from "./persist/ui";
import {
  loadNamedLayoutsFromStorage,
  type NamedLayout,
} from "./persist/namedLayouts";
import { loadBookmarksFromStorage } from "./persist/bookmarks";
import { loadEventTagConfigFromStorage } from "./persist/eventTagConfig";
import { mark, measure, timed } from "../perf";
import type {
  DataCoreApi,
  Mp4SidecarIndex,
  Mp4SidecarSummary,
} from "../workerClient";
import { Mp4SampleCache } from "./mp4SampleCache";
import { readMp4HeaderBytes } from "./mp4HeaderSlice";
import { synthesizeSidecarBytes } from "./videoTimestampBinding";
import { shiftFetchWindow, shiftRangeArrowTs } from "./offsetShift";
import { parseEpochOffsetNs } from "./tabularImport";
import { cloneBindings, emptyBindings } from "./bindings";
import {
  setInlineSource,
  dropInlineSource,
  resetInlineSources,
  fetchRange as inlineFetchRange,
} from "./inlineSource";
import { mintId } from "./ids";
import {
  bigMax,
  bigMin,
  buildInlineSource,
  mcapChannels,
  mergeGlobalRange,
  mf4Channels,
  mp4Channels,
  tabularChannels,
  uniqueSourceId,
} from "./channels";
import { SOURCE_OPENERS } from "./ingest/sourceOpeners";
import { createBookmarkActions, DEFAULT_EVENT_TAG_CONFIG } from "./bookmarks";
import {
  MAX_PLOT_Y_AXES,
  MIN_SPEED,
  MAX_SPEED,
  type Channel,
  type OpenResult,
  type PendingTabularImport,
  type PendingUnknownImport,
  type PendingVideoBinding,
  type PlotPanelSettings,
  type PlotTransform,
  type PlotZoom,
  type SessionState,
  type SourceKind,
  type SourceMeta,
  type TimeRange,
} from "./types";

// ── Public surface re-exports ───────────────────────────────────────────────
// Keep the `./store` import path stable: every type, selector, action, and the
// store hook that external modules import is re-exported here even though most
// now live in leaf modules.
export {
  qualifiedChannelId,
  MAX_PLOT_Y_AXES,
  MIN_SPEED,
  MAX_SPEED,
  DEFAULT_PLOT_PANEL_SETTINGS,
} from "./types";
export type {
  SourceKind,
  ChannelKind,
  TimeRange,
  Channel,
  SourceMeta,
  OpenResult,
  InlineChannelSpec,
  InlineSourceSpec,
  InlineSourceResult,
  DemoLoadPhase,
  DemoLoadState,
  WorkspaceSnapshot,
  PendingTabularImport,
  PendingUnknownImport,
  PendingVideoBinding,
  PlotTransform,
  PlotPanelSettings,
  PlotAxisWindow,
  PlotZoom,
  AddBookmarkOpts,
  SessionState,
} from "./types";
export { mergeGlobalRange } from "./channels";

// Prune helper for the object-valued point-cloud overlay map: a binding dies
// when *either* its calibration channel or its point-cloud channel is gone.
function prunePointCloudOverlays(
  m: SessionState["pointCloudOverlays"],
  gone: Set<string>,
): SessionState["pointCloudOverlays"] {
  let changed = false;
  const out: SessionState["pointCloudOverlays"] = {};
  for (const [panelId, binding] of Object.entries(m)) {
    if (
      binding !== null &&
      (gone.has(binding.calibrationChannelId) ||
        gone.has(binding.pointcloudChannelId))
    ) {
      out[panelId] = null;
      changed = true;
    } else {
      out[panelId] = binding;
    }
  }
  return changed ? out : m;
}

// Drop decoded-calibration cache entries whose calibration channel is gone.
function pruneCalibrationCache(
  m: Record<string, CameraCalibration[]>,
  gone: Set<string>,
): Record<string, CameraCalibration[]> {
  let changed = false;
  const out: Record<string, CameraCalibration[]> = {};
  for (const [channelId, cams] of Object.entries(m)) {
    if (gone.has(channelId)) {
      changed = true;
      continue;
    }
    out[channelId] = cams;
  }
  return changed ? out : m;
}

// Binding-pruning helpers used by `removeSource`. Each returns the *same*
// reference when nothing changed so Zustand selectors subscribed to an
// untouched binding map don't see a spurious update.
function pruneSingleBindings(
  m: Record<string, string | null>,
  gone: Set<string>,
): Record<string, string | null> {
  let changed = false;
  const out: Record<string, string | null> = {};
  for (const [panelId, channelId] of Object.entries(m)) {
    if (channelId !== null && gone.has(channelId)) {
      out[panelId] = null;
      changed = true;
    } else {
      out[panelId] = channelId;
    }
  }
  return changed ? out : m;
}

function pruneMultiBindings(
  m: Record<string, string[]>,
  gone: Set<string>,
): Record<string, string[]> {
  let changed = false;
  const out: Record<string, string[]> = {};
  for (const [panelId, ids] of Object.entries(m)) {
    const kept = ids.filter((id) => !gone.has(id));
    if (kept.length !== ids.length) changed = true;
    out[panelId] = kept;
  }
  return changed ? out : m;
}

function pruneMapBindings(
  m: SessionState["mapBindings"],
  gone: Set<string>,
): SessionState["mapBindings"] {
  let changed = false;
  const out: SessionState["mapBindings"] = {};
  for (const [panelId, binding] of Object.entries(m)) {
    if (
      binding !== null &&
      (gone.has(binding.latChannelId) || gone.has(binding.lonChannelId))
    ) {
      out[panelId] = null;
      changed = true;
    } else {
      out[panelId] = binding;
    }
  }
  return changed ? out : m;
}

/**
 * True when a plot panel's time (x) axis follows the shared zoom window.
 * Synced is the default, so an absent flag reads as `true`.
 */
export function isPlotTimeAxisSynced(
  s: Pick<SessionState, "plotPanelSettings">,
  panelId: string,
): boolean {
  return s.plotPanelSettings[panelId]?.syncTimeAxis ?? true;
}

/**
 * The time (x) window a plot panel should display: the shared window when it
 * is synced, otherwise its own per-panel x-zoom. `null` ⇒ fit the full
 * `globalRange`. Both branches return a stable store reference (never a
 * freshly built object), so it is safe to use directly as a selector. The
 * one source of truth for the scale callback, the wheel base, and the
 * "is this panel zoomed?" check.
 */
export function effectivePlotZoomX(
  s: Pick<SessionState, "plotPanelSettings" | "sharedPlotZoomX" | "plotZoom">,
  panelId: string,
): TimeRange | null {
  return isPlotTimeAxisSynced(s, panelId)
    ? s.sharedPlotZoomX
    : (s.plotZoom[panelId]?.x ?? null);
}

/**
 * Build a `channelId → Channel` lookup from the flat channel list. Exported
 * as a selector so panels / the agent surface can resolve a channel without
 * re-implementing the linear `channels.find(...)` scan. The store keeps an
 * internal index in sync for its own hot paths; this is the public, pure
 * derivation (consumers should memoize on `state.channels` identity, which
 * only changes when sources open / close).
 */
export function selectChannelsById(
  s: Pick<SessionState, "channels">,
): Map<string, Channel> {
  const m = new Map<string, Channel>();
  for (const c of s.channels) m.set(c.id, c);
  return m;
}

// The worker fetch-range method for each plottable source kind, plus whether
// its Arrow batches carry the scalar `{ts,value}` schema that
// `shiftRangeArrowTs` rewrites for the per-source time offset. Geometry kinds
// (lidar / openlabel / trajectory / map_geometry) carry multi-column List
// schemas and always run at offset 0n, so their bytes pass through unshifted
// (`shiftTs: false`). Turns the former 11-arm `if (source.kind === …)` ladder
// in `fetchChannelRange` into a single table lookup. `inline` is served from
// the main thread and handled before this table; kinds absent here are not
// plottable.
type FetchRangeMethod = {
  [K in keyof DataCoreApi]: DataCoreApi[K] extends (
    handle: number,
    nativeId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ) => Promise<Uint8Array>
    ? K
    : never;
}[keyof DataCoreApi];

const FETCH_RANGE_BY_KIND: Partial<
  Record<SourceKind, { method: FetchRangeMethod; shiftTs: boolean }>
> = {
  mcap: { method: "mcapFetchRange", shiftTs: true },
  ros1: { method: "ros1BagFetchRange", shiftTs: true },
  ros2db3: { method: "ros2Db3FetchRange", shiftTs: true },
  mf4: { method: "mf4FetchRange", shiftTs: true },
  tabular: { method: "tabularFetchRange", shiftTs: true },
  recipe: { method: "recipeFetchRange", shiftTs: true },
  lidar: { method: "lidarFetchRange", shiftTs: false },
  openlabel: { method: "openlabelFetchRange", shiftTs: false },
  trajectory: { method: "trajectoryFetchRange", shiftTs: false },
  map_geometry: { method: "mapGeometryFetchRange", shiftTs: false },
};

// The worker close method for each source kind that owns a wasm slab handle.
// `inline` is main-thread only (no handle) and handled by callers before this
// table; any kind not listed falls back to `closeMp4Sidecar` to preserve the
// historical ladder's `else` branch exactly (covers `mp4+sidecar` and the
// `calibration` kind, which the original ladders also routed there).
const CLOSE_METHOD_BY_KIND: Partial<Record<SourceKind, keyof DataCoreApi>> = {
  mcap: "closeMcap",
  ros1: "closeRos1Bag",
  ros2db3: "closeRos2Db3",
  mf4: "closeMf4",
  tabular: "closeTabular",
  recipe: "closeRecipe",
  lidar: "closeLidar",
  openlabel: "closeOpenlabel",
  trajectory: "closeTrajectory",
  map_geometry: "closeMapGeometry",
};

export const useSession = create<SessionState>((set, get) => {
  let worker: Remote<DataCoreApi> | null = null;
  // Serialise `openFiles` so two rapid drops don't interleave `set()` calls.
  let pending: Promise<unknown> = Promise.resolve();
  // Monotonic key for queued tabular imports (stable across the drop batch /
  // dialog confirm cycle; never reused so a dialog re-render can't target a
  // recycled slot).
  let tabularImportSeq = 0;
  // Monotonic key for queued unknown-format imports (Format Agent flow).
  let unknownImportSeq = 0;
  // Monotonic key for queued sidecar-less mp4 bindings (Feature 1). Never
  // reused so a dialog re-render can't target a recycled slot.
  let videoBindingSeq = 0;
  // In-flight dedup for `fetchChannelRange`. Two panels bound to the same
  // channel that fire concurrent fetches for the same window share one worker
  // round-trip. Keyed by `${channelId}|${startNs}|${endNs}|${includePrev}`.
  // Entries are deleted when the promise settles (finally). No result cache —
  // offset-shift invalidation makes that a separate design task.
  const inFlightFetches = new Map<string, Promise<Uint8Array>>();
  // Derived lookup index over `sources`/`channels` so the fetch / frame-times
  // / calibration paths resolve a channel + its source in O(1) instead of two
  // linear `.find` scans each. Rebuilt lazily: `syncIndex()` rebuilds only
  // when the `channels`/`sources` array references have changed since the last
  // build, so it stays correct no matter how state was mutated (the store's
  // own actions OR a direct `setState` in tests). The public
  // `selectChannelsById` selector derives the same map for outside consumers.
  const channelsById = new Map<string, Channel>();
  const sourcesById = new Map<string, SourceMeta>();
  let indexedChannels: Channel[] | null = null;
  let indexedSources: SourceMeta[] | null = null;
  const syncIndex = (): void => {
    const { channels, sources } = get();
    if (channels === indexedChannels && sources === indexedSources) return;
    channelsById.clear();
    sourcesById.clear();
    for (const s of sources) sourcesById.set(s.id, s);
    for (const c of channels) channelsById.set(c.id, c);
    indexedChannels = channels;
    indexedSources = sources;
  };

  // Resolve a channel id to its `Channel` + owning `SourceMeta`, the
  // duplicated preamble of `fetchChannelRange`, `lidarSpinTimes`,
  // `boxFrameTimes`, `trajectoryFrameTimes`, `mapGeometryFrameTimes`, and
  // `loadCalibration`. Throws the same messages the inline preamble did so
  // callers' error contracts are unchanged.
  const resolveChannel = (
    channelId: string,
  ): { channel: Channel; source: SourceMeta } => {
    syncIndex();
    const channel = channelsById.get(channelId);
    if (!channel) throw new Error(`unknown channel: ${channelId}`);
    const source = sourcesById.get(channel.sourceId);
    if (!source) {
      throw new Error(`unknown source for channel: ${channelId}`);
    }
    return { channel, source };
  };

  // Close a source's wasm slab handle via the right `close_*` worker method.
  // `inline` has no handle (main-thread storage) and is filtered by callers
  // before this runs; any kind not in `CLOSE_METHOD_BY_KIND` falls back to
  // `closeMp4Sidecar`, preserving the original ladders' `else` branch (covers
  // `mp4+sidecar` and `calibration`). Shared by `clear()` and `removeSource`.
  const closeFor = async (
    w: Remote<DataCoreApi>,
    source: SourceMeta,
  ): Promise<void> => {
    const method = CLOSE_METHOD_BY_KIND[source.kind] ?? "closeMp4Sidecar";
    await (w[method] as (handle: number) => Promise<void>)(source.handle);
  };

  // Shared body for the per-kind frame/spin-time actions (lidar spins,
  // OpenLABEL/trajectory/map-geometry frames): resolve the channel, assert the
  // source kind, then call the matching worker method. Each scene kind exposes
  // one `(handle) => Promise<BigInt64Array>` worker method; the result flows
  // straight through (BigInt64Array, never narrowed). `errMsg` mirrors each
  // action's original "not a … channel" message verbatim.
  const frameTimes = async (
    channelId: string,
    kind: SourceKind,
    method:
      | "lidarSpinTimes"
      | "openlabelFrameTimes"
      | "trajectoryFrameTimes"
      | "mapGeometryFrameTimes",
    errMsg: string,
  ): Promise<BigInt64Array> => {
    if (!worker) throw new Error("session store: worker not initialised");
    const { source } = resolveChannel(channelId);
    if (source.kind !== kind) throw new Error(errMsg);
    return worker[method](source.handle);
  };

  // Hydrate layout + bindings synchronously so the first render paints the
  // saved layout. Missing / malformed storage → `null` and empty maps; the
  // Workspace falls back to `defaultLayoutModel` when `layoutJson === null`.
  const hydrated = loadLayoutFromStorage();
  const hydratedUi = loadUiFromStorage();
  const hydratedNamedLayouts = loadNamedLayoutsFromStorage();
  const hydratedBookmarks = loadBookmarksFromStorage();
  const hydratedEventTagConfig = loadEventTagConfigFromStorage();

  // Merge a freshly-opened batch of sources into the store and record any
  // errors. Shared by `openFiles` (drop / picker) and `openUrl` so both
  // paths seed the cursor and widen `globalRange` identically.
  const commitOpenedSources = (
    newSources: SourceMeta[],
    errors: BucketError[],
  ): void => {
    if (newSources.length > 0) {
      const allSources = [...get().sources, ...newSources];
      const allChannels = allSources.flatMap((s) => s.channels);
      const newRange = mergeGlobalRange(allSources);
      const prevCursor = get().cursorNs;
      // Seed / reseat the cursor so it is always inside `globalRange`. On the
      // first successful open, `cursorNs` is still the 0n default; on later
      // opens, leave it alone unless it now falls outside the (possibly
      // widened) union range.
      const nextCursor =
        newRange &&
        (prevCursor < newRange.startNs || prevCursor > newRange.endNs)
          ? newRange.startNs
          : prevCursor;
      set({
        sources: allSources,
        channels: allChannels,
        globalRange: newRange,
        cursorNs: nextCursor,
        lastOpenErrors: errors,
      });
    } else {
      set({ lastOpenErrors: errors });
    }
  };

  // The four multi-channel binding maps (plot/table/value/enum) share an
  // identical `set` (dedup + cap), `add` (skip dupes / over-cap), and
  // `remove` (filter) shape. Centralise the loops here so a new
  // multi-binding panel kind is a one-line wrapper rather than another
  // copy-pasted triple. `mapKey` names the `Record<string, string[]>`
  // slice on the store.
  type MultiBindingKey =
    | "plotBindings"
    | "tableBindings"
    | "valueBindings"
    | "enumBindings";

  const setMulti = (
    mapKey: MultiBindingKey,
    panelId: string,
    ids: string[],
  ) => {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(id);
      if (next.length >= MAX_PLOT_SERIES) break;
    }
    set({
      [mapKey]: { ...get()[mapKey], [panelId]: next },
    } as Partial<SessionState>);
  };

  const addMulti = (
    mapKey: MultiBindingKey,
    panelId: string,
    channelId: string,
  ) => {
    const prev = get()[mapKey];
    const existing = prev[panelId] ?? [];
    if (existing.includes(channelId)) return;
    if (existing.length >= MAX_PLOT_SERIES) return;
    set({
      [mapKey]: { ...prev, [panelId]: [...existing, channelId] },
    } as Partial<SessionState>);
  };

  const removeMulti = (
    mapKey: MultiBindingKey,
    panelId: string,
    channelId: string,
  ) => {
    const prev = get()[mapKey];
    const existing = prev[panelId];
    if (!existing || !existing.includes(channelId)) return;
    set({
      [mapKey]: {
        ...prev,
        [panelId]: existing.filter((x) => x !== channelId),
      },
    } as Partial<SessionState>);
  };

  // Centralised merge + normalize-defaults-to-absent for the per-plot-panel
  // settings map. Every plot-settings setter (axis / stack / sync / transform
  // / gap-threshold) shares the same convention: spread the panel's *actual*
  // prior settings (not the full defaults) so an untouched panel keeps a
  // minimal payload, ensure `gapThresholdSec` is always present (null = off),
  // apply the field-specific `patch`, then drop any sub-field that has
  // collapsed back to its default so the persisted map stays minimal and
  // `seriesKey`/identity comparisons stay stable. Callers keep their own
  // short-circuit (no-op) checks; this just builds + writes the next entry.
  const writePlotPanelSettings = (
    panelId: string,
    patch: Partial<PlotPanelSettings>,
  ): void => {
    const prev = get().plotPanelSettings;
    const existing = prev[panelId];
    const next: PlotPanelSettings = {
      ...existing,
      gapThresholdSec: existing?.gapThresholdSec ?? null,
      ...patch,
    };
    // `false` is the stack default and `true` is the sync default; persist
    // them as deletions so an untouched panel keeps a minimal payload.
    if (next.stackAxes === false) delete next.stackAxes;
    if (next.syncTimeAxis === true) delete next.syncTimeAxis;
    set({ plotPanelSettings: { ...prev, [panelId]: next } });
  };

  return {
    sources: [],
    channels: [],
    globalRange: null,
    cursorNs: 0n,
    playing: false,
    speed: 1,
    timeMode: "relative",
    seekEpoch: 0,
    hoverNs: null,
    layoutJson: hydrated?.layoutJson ?? null,
    videoBindings: hydrated?.videoBindings ?? {},
    plotBindings: hydrated?.plotBindings ?? {},
    plotPanelSettings: hydrated?.plotPanelSettings ?? {},
    plotZoom: {},
    sharedPlotZoomX: null,
    unitOverrides: hydrated?.unitOverrides ?? {},
    videoHudOn: hydrated?.videoHudOn ?? {},
    sceneBindings: hydrated?.sceneBindings ?? {},
    mapBindings: hydrated?.mapBindings ?? {},
    tableBindings: hydrated?.tableBindings ?? {},
    valueBindings: hydrated?.valueBindings ?? {},
    enumBindings: hydrated?.enumBindings ?? {},
    pointCloudOverlays: hydrated?.pointCloudOverlays ?? {},
    calibrationCache: {},
    activeRailTab: hydratedUi?.activeRailTab ?? null,
    railCollapsed: hydratedUi?.railCollapsed ?? false,
    drawerWidth: hydratedUi?.drawerWidth ?? DRAWER_WIDTH_DEFAULT,
    selectedPanelId: null,
    namedLayouts: hydratedNamedLayouts?.layouts ?? [],
    activeNamedLayoutId: hydratedNamedLayouts?.activeNamedLayoutId ?? null,
    bookmarks: hydratedBookmarks ?? [],
    eventTagConfig: hydratedEventTagConfig ?? DEFAULT_EVENT_TAG_CONFIG,
    lastOpenErrors: [],
    loadedRanges: {},
    pendingFetch: {},
    pendingTabularImports: [],
    pendingUnknownImports: [],
    pendingVideoBindings: [],
    pendingLayoutProposal: null,
    demoLoad: { phase: "idle", receivedBytes: 0, totalBytes: 0, error: null },

    setWorker(w) {
      worker = w;
    },

    getWorker() {
      return worker;
    },

    play() {
      const { globalRange, cursorNs, seekEpoch } = get();
      if (!globalRange) return;
      if (cursorNs >= globalRange.endNs) {
        // Rewind to the start; bump the seek epoch so the video pipeline
        // reseeks to the new cursor instead of resuming from end-of-stream.
        set({
          cursorNs: globalRange.startNs,
          playing: true,
          seekEpoch: seekEpoch + 1,
        });
      } else {
        set({ playing: true });
      }
    },

    pause() {
      set({ playing: false });
    },

    setSpeed(n) {
      if (!Number.isFinite(n)) return;
      set({ speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, n)) });
    },

    setTimeMode(mode) {
      if (get().timeMode === mode) return;
      set({ timeMode: mode });
    },

    setCursor(ns) {
      const { globalRange, seekEpoch } = get();
      if (!globalRange) return;
      const clamped = bigMax(
        globalRange.startNs,
        bigMin(globalRange.endNs, ns),
      );
      const nextEpoch = seekEpoch + 1;
      if (clamped === globalRange.endNs) {
        set({ cursorNs: clamped, playing: false, seekEpoch: nextEpoch });
      } else {
        set({ cursorNs: clamped, seekEpoch: nextEpoch });
      }
    },

    advanceCursor(ns) {
      const { globalRange } = get();
      if (!globalRange) return;
      const clamped = bigMax(
        globalRange.startNs,
        bigMin(globalRange.endNs, ns),
      );
      if (clamped === globalRange.endNs) {
        set({ cursorNs: clamped, playing: false });
      } else {
        set({ cursorNs: clamped });
      }
    },

    setLayoutJson(json) {
      // Any out-of-band layout edit (FlexLayout `onModelChange` after a
      // user drag, dev hook, reset) breaks the "active named layout"
      // identity — clear it so the Layout drawer's orange border no
      // longer points at a layout the user has since diverged from.
      //
      // SEAM: `restoreNamedLayout` deliberately bypasses this clearing
      // by writing `{ layoutJson, activeNamedLayoutId }` in one
      // `set({...})` call, so the ordering inside that action is
      // load-bearing — do not refactor it to call `setLayoutJson(...)`
      // followed by `setActiveNamedLayoutId(...)` or the active id will
      // get clobbered by this line on every restore.
      set({ layoutJson: json, activeNamedLayoutId: null });
    },

    setVideoBinding(panelId, channelId) {
      const prev = get().videoBindings;
      if (prev[panelId] === channelId) return;
      set({ videoBindings: { ...prev, [panelId]: channelId } });
    },

    setVideoHudOn(panelId, on) {
      const prev = get().videoHudOn;
      const cur = prev[panelId] ?? false;
      if (cur === on) return;
      set({ videoHudOn: { ...prev, [panelId]: on } });
    },

    toggleVideoHudOn(panelId) {
      const prev = get().videoHudOn;
      const cur = prev[panelId] ?? false;
      set({ videoHudOn: { ...prev, [panelId]: !cur } });
    },

    setPlotBinding(panelId, ids) {
      setMulti("plotBindings", panelId, ids);
    },

    addPlotChannel(panelId, channelId) {
      addMulti("plotBindings", panelId, channelId);
    },

    removePlotChannel(panelId, channelId) {
      removeMulti("plotBindings", panelId, channelId);
    },

    setPlotGapThreshold(panelId, sec) {
      const existing = get().plotPanelSettings[panelId];
      // Normalise: any non-finite or non-positive value collapses to
      // null (the "off" state), so the persistence layer doesn't have
      // to defend against -Infinity / NaN coming from a numeric input.
      const normalised: number | null =
        sec !== null && Number.isFinite(sec) && sec > 0 ? sec : null;
      if ((existing?.gapThresholdSec ?? null) === normalised) return;
      writePlotPanelSettings(panelId, { gapThresholdSec: normalised });
    },

    setPlotChannelAxis(panelId, channelId, axis) {
      const existing = get().plotPanelSettings[panelId];
      // Clamp into the renderable range; non-finite input collapses to 0.
      const clamped =
        Number.isFinite(axis) && axis > 0
          ? Math.min(Math.floor(axis), MAX_PLOT_Y_AXES - 1)
          : 0;
      const nextAssignments: Record<string, number> = {
        ...(existing?.axisAssignments ?? {}),
      };
      // Axis 0 is the default, so store it as a deletion to keep an
      // untouched panel's map empty (mirrors the transforms "none" posture).
      if (clamped === 0) {
        if (!(channelId in nextAssignments)) return;
        delete nextAssignments[channelId];
      } else {
        if (nextAssignments[channelId] === clamped) return;
        nextAssignments[channelId] = clamped;
      }
      writePlotPanelSettings(panelId, { axisAssignments: nextAssignments });
    },

    setPlotStackAxes(panelId, on) {
      const existing = get().plotPanelSettings[panelId];
      if ((existing?.stackAxes ?? false) === on) return;
      writePlotPanelSettings(panelId, { stackAxes: on });
    },

    setPlotSyncTimeAxis(panelId, on) {
      const existing = get().plotPanelSettings[panelId];
      const current = existing?.syncTimeAxis ?? true;
      if (current === on) return;
      // Keep the view stable across the switch. Leaving the synced group:
      // adopt the shared window as this panel's own x-zoom so it doesn't
      // jump. Joining it: drop our own x-window so we follow the shared one.
      // The y-zoom is untouched either way — only the time axis syncs.
      if (on) get().setPlotZoomX(panelId, null);
      else get().setPlotZoomX(panelId, get().sharedPlotZoomX);
      // `setPlotZoomX` above only touched `plotZoom`; the settings map is
      // re-read fresh inside `writePlotPanelSettings`.
      writePlotPanelSettings(panelId, { syncTimeAxis: on });
    },

    setPlotZoomX(panelId, window) {
      const prev = get().plotZoom;
      const existing = prev[panelId];
      const next: PlotZoom = { x: window, y: { ...(existing?.y ?? {}) } };
      // Prune the panel entry when nothing is zoomed so `panelId in plotZoom`
      // stays a faithful "is zoomed" check (and the persist subscriber's
      // identity comparisons see a stable empty map).
      if (next.x === null && Object.keys(next.y).length === 0) {
        if (!(panelId in prev)) return;
        const copy = { ...prev };
        delete copy[panelId];
        set({ plotZoom: copy });
        return;
      }
      set({ plotZoom: { ...prev, [panelId]: next } });
    },

    setPlotZoomY(panelId, axisIdx, window) {
      const prev = get().plotZoom;
      const existing = prev[panelId];
      const y = { ...(existing?.y ?? {}) };
      if (window === null) {
        if (!(axisIdx in y)) {
          // Nothing to clear; only short-circuit when x is also untouched.
          if (existing === undefined) return;
        }
        delete y[axisIdx];
      } else {
        y[axisIdx] = window;
      }
      const next: PlotZoom = { x: existing?.x ?? null, y };
      if (next.x === null && Object.keys(next.y).length === 0) {
        if (!(panelId in prev)) return;
        const copy = { ...prev };
        delete copy[panelId];
        set({ plotZoom: copy });
        return;
      }
      set({ plotZoom: { ...prev, [panelId]: next } });
    },

    resetPlotZoom(panelId) {
      const prev = get().plotZoom;
      if (!(panelId in prev)) return;
      const copy = { ...prev };
      delete copy[panelId];
      set({ plotZoom: copy });
    },

    setSharedPlotZoomX(window) {
      const prev = get().sharedPlotZoomX;
      // Skip redundant writes: synced panels re-resolve their scales off
      // this value's identity, so a no-op set would repaint every plot.
      const same =
        window === null
          ? prev === null
          : prev !== null &&
            prev.startNs === window.startNs &&
            prev.endNs === window.endNs;
      if (same) return;
      set({ sharedPlotZoomX: window });
    },

    applyPlotZoomX(panelId, window) {
      const synced = get().plotPanelSettings[panelId]?.syncTimeAxis ?? true;
      if (synced) get().setSharedPlotZoomX(window);
      else get().setPlotZoomX(panelId, window);
    },

    clearPlotZoom(panelId) {
      const synced = get().plotPanelSettings[panelId]?.syncTimeAxis ?? true;
      get().resetPlotZoom(panelId);
      if (synced) get().setSharedPlotZoomX(null);
    },

    setChannelUnit(channelId, unit) {
      const prev = get().unitOverrides;
      if (unit === null) {
        // Revert to the file-inferred unit.
        if (!(channelId in prev)) return;
        const next = { ...prev };
        delete next[channelId];
        set({ unitOverrides: next });
        return;
      }
      if (prev[channelId] === unit) return;
      set({ unitOverrides: { ...prev, [channelId]: unit } });
    },

    setPlotChannelTransform(panelId, channelId, transform) {
      const existing = get().plotPanelSettings[panelId];
      const nextTransforms: Record<string, PlotTransform> = {
        ...(existing?.transforms ?? {}),
      };
      // Store "none" as a deletion so a default panel keeps an empty map
      // (and `transformKey` produces the same seriesKey it did pre-P7).
      if (transform.kind === "none") {
        if (!(channelId in nextTransforms)) return;
        delete nextTransforms[channelId];
      } else {
        nextTransforms[channelId] = transform;
      }
      writePlotPanelSettings(panelId, { transforms: nextTransforms });
    },

    setHoverNs(ns) {
      // Cheap identity short-circuit so a hover that resolves to the same
      // ns (e.g. two rAF ticks inside one pixel) doesn't churn subscribers.
      if (get().hoverNs === ns) return;
      set({ hoverNs: ns });
    },

    setSceneBinding(panelId, channelId) {
      const prev = get().sceneBindings;
      if ((prev[panelId] ?? null) === channelId) return;
      set({ sceneBindings: { ...prev, [panelId]: channelId } });
    },

    setMapBinding(panelId, binding) {
      const prev = get().mapBindings;
      const cur = prev[panelId] ?? null;
      // Deep-equal short-circuit so re-binding the same lat/lon pair is
      // a no-op (avoids spurious persistence writes from the drawer's
      // double-bind path).
      if (
        cur === binding ||
        (cur !== null &&
          binding !== null &&
          cur.latChannelId === binding.latChannelId &&
          cur.lonChannelId === binding.lonChannelId)
      ) {
        return;
      }
      set({ mapBindings: { ...prev, [panelId]: binding } });
    },

    setPointCloudOverlay(panelId, binding) {
      const prev = get().pointCloudOverlays;
      const cur = prev[panelId] ?? null;
      // Deep-equal short-circuit so re-binding the same overlay is a no-op
      // (avoids spurious persistence writes), mirroring `setMapBinding`.
      if (
        cur === binding ||
        (cur !== null &&
          binding !== null &&
          cur.calibrationChannelId === binding.calibrationChannelId &&
          cur.cameraName === binding.cameraName &&
          cur.pointcloudChannelId === binding.pointcloudChannelId)
      ) {
        return;
      }
      set({ pointCloudOverlays: { ...prev, [panelId]: binding } });
      // Warm the decoded-calibration cache so the draw loop has cameras ready.
      if (
        binding !== null &&
        !get().calibrationCache[binding.calibrationChannelId]
      ) {
        void get().loadCalibration(binding.calibrationChannelId);
      }
    },

    async loadCalibration(calibrationChannelId) {
      const cached = get().calibrationCache[calibrationChannelId];
      if (cached) return cached;
      if (!worker) throw new Error("session store: worker not initialised");
      // This path returns `[]` (not throw) for unknown / wrong-kind channels,
      // so resolve directly off the index rather than via `resolveChannel`.
      syncIndex();
      const channel = channelsById.get(calibrationChannelId);
      if (!channel) return [];
      const source = sourcesById.get(channel.sourceId);
      if (!source || source.kind !== "calibration") return [];
      let cameras: CameraCalibration[] = [];
      try {
        const bytes = await worker.calibrationFetch(
          source.handle,
          channel.nativeId,
        );
        const res = decodeCalibration(bytes);
        if (res.ok) cameras = res.cameras;
      } catch {
        cameras = [];
      }
      set({
        calibrationCache: {
          ...get().calibrationCache,
          [calibrationChannelId]: cameras,
        },
      });
      return cameras;
    },

    setTableBinding(panelId, ids) {
      setMulti("tableBindings", panelId, ids);
    },

    addTableChannel(panelId, channelId) {
      addMulti("tableBindings", panelId, channelId);
    },

    removeTableChannel(panelId, channelId) {
      removeMulti("tableBindings", panelId, channelId);
    },

    setValueBinding(panelId, ids) {
      setMulti("valueBindings", panelId, ids);
    },

    addValueChannel(panelId, channelId) {
      addMulti("valueBindings", panelId, channelId);
    },

    removeValueChannel(panelId, channelId) {
      removeMulti("valueBindings", panelId, channelId);
    },

    setEnumBinding(panelId, ids) {
      setMulti("enumBindings", panelId, ids);
    },

    addEnumChannel(panelId, channelId) {
      addMulti("enumBindings", panelId, channelId);
    },

    removeEnumChannel(panelId, channelId) {
      removeMulti("enumBindings", panelId, channelId);
    },

    setActiveRailTab(tab) {
      if (get().activeRailTab === tab) return;
      set({ activeRailTab: tab });
    },

    setRailCollapsed(collapsed) {
      if (get().railCollapsed === collapsed) return;
      set({ railCollapsed: collapsed });
    },

    setDrawerWidth(px) {
      const next = clampDrawerWidth(px);
      if (get().drawerWidth === next) return;
      set({ drawerWidth: next });
    },

    setSelectedPanelId(id) {
      const next = typeof id === "string" ? id : null;
      if (get().selectedPanelId === next) return;
      set({ selectedPanelId: next });
    },

    saveCurrentLayoutAs(name) {
      const id = mintId("nl");
      const state = get();
      // Snapshot the EXACT field set the live-layout shard persists (via
      // `cloneBindings`) so a saved layout never silently drops HUD /
      // overlay / unit state — keeping named layouts in lockstep with the
      // live layout.
      const entry: NamedLayout = {
        id,
        name,
        layoutJson: state.layoutJson,
        ...cloneBindings(state),
        createdAt: Date.now(),
      };
      set({
        namedLayouts: [...state.namedLayouts, entry],
        activeNamedLayoutId: id,
      });
      return id;
    },

    restoreNamedLayout(id) {
      const entry = get().namedLayouts.find((l) => l.id === id);
      if (!entry) return;
      // Single `set` so the persist adapter writes one snapshot and
      // FlexLayout's external-rebuild effect sees the restored JSON
      // alongside the active-id update (no race with the `setLayoutJson`
      // clearing path). A layout saved before a given map existed defaults
      // it to `{}` via `emptyBindings()` so older entries restore cleanly.
      set({
        layoutJson: entry.layoutJson,
        ...cloneBindings({ ...emptyBindings(), ...entry }),
        activeNamedLayoutId: id,
      });
    },

    setDemoLoad(patch) {
      set({ demoLoad: { ...get().demoLoad, ...patch } });
    },

    applyDemoWorkspace(snapshot) {
      // Single `set` for the same reason as `restoreNamedLayout`: the
      // persist adapter writes one snapshot and FlexLayout's external-
      // rebuild effect sees the new JSON together with its bindings. Maps
      // the snapshot omits (e.g. `videoHudOn`) reset to `{}` via
      // `emptyBindings()` so the demo always starts from a clean slate.
      set({
        layoutJson: snapshot.layoutJson,
        ...cloneBindings({ ...emptyBindings(), ...snapshot }),
        activeNamedLayoutId: null,
        selectedPanelId: null,
      });
    },

    removeNamedLayout(id) {
      const prev = get().namedLayouts;
      const next = prev.filter((l) => l.id !== id);
      if (next.length === prev.length) return;
      set({
        namedLayouts: next,
        activeNamedLayoutId:
          get().activeNamedLayoutId === id ? null : get().activeNamedLayoutId,
      });
    },

    // Bookmark + event-tag slice (STATE-03) — implementations live in
    // `bookmarks.ts`, bound to this store's `get`/`set`. Spreading keeps every
    // action name + signature identical to the inline versions.
    ...createBookmarkActions(get, set),

    dismissOpenErrors() {
      if (get().lastOpenErrors.length === 0) return;
      set({ lastOpenErrors: [] });
    },

    async fetchChannelRange(channelId, startNs, endNs, includePrev) {
      const { channel, source } = resolveChannel(channelId);

      // Inline (agent-pushed) sources are served straight from the main-thread
      // store — no worker round-trip. They honour the same per-source offset
      // contract (0n by default = pass-through), built into the shifted window
      // + the returned-ts shift, exactly like the signal readers below.
      if (source.kind === "inline") {
        const offset = source.timeOffsetNs ?? 0n;
        const win = shiftFetchWindow(startNs, endNs, offset);
        const bytes = inlineFetchRange(
          source.id,
          channel.nativeId,
          win.startNs,
          win.endNs,
          includePrev ?? false,
        );
        if (bytes === null) {
          throw new Error(`unknown inline channel: ${channelId}`);
        }
        return shiftRangeArrowTs(bytes, offset);
      }

      if (!worker) throw new Error("session store: worker not initialised");
      const w = worker;

      // In-flight dedup: two panels bound to the same channel that issue
      // concurrent fetches for the same window share one worker round-trip.
      // The key encodes the channel, window, and includePrev flag so distinct
      // callers with different windows are never conflated.
      // Callers only pass the returned Uint8Array to read-only parsers
      // (tableFromIPC / seriesFromArrow / decodePointCloud) — no caller
      // transfers or mutates the buffer, so sharing is safe.
      const dedupKey = `${channelId}|${startNs}|${endNs}|${includePrev}`;
      const existing = inFlightFetches.get(dedupKey);
      if (existing) return existing;

      const perfStart = `fetch-range:${channelId}:start`;
      const perfEnd = `fetch-range:${channelId}:end`;
      mark(perfStart);
      // Feature 2 — per-source time offset. Query the reader with the window
      // shifted back by the offset, then shift every returned `ts` forward by
      // the same offset so the source lines up with the session timeline. Both
      // are cheap `bigint` ops off the cursor/video hot path; a 0n offset is a
      // pass-through (no window shift, no Arrow re-encode). Geometry kinds
      // (`shiftTs: false`) always run at offset 0n and pass bytes through
      // unmodified — the multi-column List<Float32>/<Int32>/<Utf8> schemas
      // aren't the scalar `{ts,value}` shape `shiftRangeArrowTs` rewrites.
      const offset = source.timeOffsetNs ?? 0n;
      const win = shiftFetchWindow(startNs, endNs, offset);

      const fetchPromise = (async (): Promise<Uint8Array> => {
        try {
          const entry = FETCH_RANGE_BY_KIND[source.kind];
          if (!entry) {
            throw new Error(`channel kind not plottable: ${source.kind}`);
          }
          const fetch = w[entry.method].bind(w);
          const bytes = await fetch(
            source.handle,
            channel.nativeId,
            win.startNs,
            win.endNs,
            includePrev,
          );
          return entry.shiftTs ? shiftRangeArrowTs(bytes, offset) : bytes;
        } finally {
          mark(perfEnd);
          measure(`fetch-range:${channelId}`, perfStart, perfEnd);
          inFlightFetches.delete(dedupKey);
        }
      })();

      inFlightFetches.set(dedupKey, fetchPromise);
      return fetchPromise;
    },

    async lidarSpinTimes(channelId) {
      return frameTimes(
        channelId,
        "lidar",
        "lidarSpinTimes",
        `not a point-cloud channel: ${channelId}`,
      );
    },

    addInlineSource(spec) {
      const built = buildInlineSource(spec, get().sources);
      if (built === null) return null;
      const { source, data, channels } = built;
      // Stash the columnar data on the main thread BEFORE committing the
      // source, so the first `fetchChannelRange` after registration finds it.
      setInlineSource(source.id, data);
      // Widen `globalRange`, seed/reseat the cursor, and surface the source +
      // channels — the same derived-state recompute every file open uses.
      commitOpenedSources([source], []);
      return { sourceId: source.id, channels };
    },

    async boxFrameTimes(channelId) {
      return frameTimes(
        channelId,
        "openlabel",
        "openlabelFrameTimes",
        `not a bounding-box channel: ${channelId}`,
      );
    },

    async trajectoryFrameTimes(channelId) {
      return frameTimes(
        channelId,
        "trajectory",
        "trajectoryFrameTimes",
        `not a trajectory channel: ${channelId}`,
      );
    },

    async mapGeometryFrameTimes(channelId) {
      return frameTimes(
        channelId,
        "map_geometry",
        "mapGeometryFrameTimes",
        `not a map-geometry channel: ${channelId}`,
      );
    },

    async openFiles(files) {
      const run = (): Promise<OpenResult> =>
        timed("open", async () => {
          if (!worker) throw new Error("session store: worker not initialised");
          const w = worker;

          const buckets = bucketFiles(files);
          // `.json` is ambiguous (Ingest Recipes are JSON too), so `bucketFiles`
          // leaves the OpenLABEL bucket empty and we sniff content here: pull any
          // `.json` whose head carries a top-level `"openlabel"` key out of the
          // `unknown` bucket and into the 3D scene (bounding-box) pipeline. Files
          // that don't match stay in `unknown` for the recipe/Format-Agent flow.
          {
            const stillUnknown: File[] = [];
            for (const f of buckets.unknown) {
              const isJson = f.name.toLowerCase().endsWith(".json");
              // Sniff calibration before OpenLABEL: a `.calib.json` is the
              // narrower marker. Files that match neither stay in `unknown`
              // for the recipe/Format-Agent flow.
              if (isJson && (await sniffCalibration(f))) {
                buckets.calibration.push(f);
              } else if (isJson && (await sniffOpenlabel(f))) {
                buckets.openlabel.push(f);
              } else if (isJson && (await sniffTrajectory(f))) {
                // Predicted ego trajectory `.json` (top-level `"trajectory"`
                // key) — route into the 3D scene pipeline as polylines.
                buckets.trajectory.push(f);
              } else if (isJson && (await sniffDrivelineMap(f))) {
                // Simple road-network `.json` (top-level `"drivelineMap"` key) —
                // route into the 3D scene pipeline as map-geometry polylines.
                // (OpenDRIVE `.xodr` is routed by extension in `bucketFiles`.)
                buckets.mapGeometry.push(f);
              } else {
                stillUnknown.push(f);
              }
            }
            buckets.unknown = stillUnknown;
          }
          // A raw NVIDIA Alpamayo LiDAR parquet (Draco-compressed spins) can
          // land in either bucket: named `*.parquet` it parks in `tabular`;
          // named `*.lidar.parquet` it parks in `lidar` as `"parquet"` — and the
          // Driveline-schema reader (`openLidar`) would choke on its Draco
          // columns. So content-sniff every parquet (footer scan for the
          // `draco_encoded_pointcloud` column) regardless of name and tag the
          // matches for the in-browser Draco path — the file opens no matter
          // what it's called.
          {
            // `*.lidar.parquet` arrivals already in the lidar bucket.
            for (const l of buckets.lidar) {
              if (
                l.format === "parquet" &&
                (await sniffAlpamayoLidar(l.file))
              ) {
                l.format = "alpamayo";
              }
            }
            // `*.parquet` arrivals parked in tabular — move matches across.
            const stillTabular: typeof buckets.tabular = [];
            for (const t of buckets.tabular) {
              if (
                t.format === "parquet" &&
                (await sniffAlpamayoLidar(t.file))
              ) {
                buckets.lidar.push({ file: t.file, format: "alpamayo" });
              } else {
                stillTabular.push(t);
              }
            }
            buckets.tabular = stillTabular;
          }
          const opened: string[] = [];
          const errors: BucketError[] = [...buckets.errors];
          const newSources: SourceMeta[] = [];
          const existing = get().sources;

          // The uniform eager openers (mcap / ros1 / ros2db3 / mf4 / lidar /
          // openlabel / calibration / trajectory / mapGeometry) share one
          // loop: pick the file's display name, mint a unique source id, run
          // the matching opener from the SOURCE_OPENERS dispatch table, and
          // push the resulting SourceMeta (always `timeOffsetNs: 0n`). Each
          // opener owns its worker open/summary + channel-builder choice; this
          // loop owns id minting and the per-file try/catch error capture.
          // `lidar` carries a `format` discriminant (`pcd`/`alpamayo`/default)
          // its opener branches on. mp4 pairs, sidecar-less mp4s, tabular, and
          // unknown/recipe drops have genuinely distinct control flow and are
          // handled separately below.
          const eagerJobs: Array<{
            file: File;
            opener: keyof typeof SOURCE_OPENERS;
            format?: string;
          }> = [
            ...buckets.mcap.map((file) => ({ file, opener: "mcap" as const })),
            ...buckets.ros1.map((file) => ({ file, opener: "ros1" as const })),
            ...buckets.ros2db3.map((file) => ({
              file,
              opener: "ros2db3" as const,
            })),
            ...buckets.mf4.map((file) => ({ file, opener: "mf4" as const })),
            ...buckets.lidar.map(({ file, format }) => ({
              file,
              opener: "lidar" as const,
              format,
            })),
            ...buckets.openlabel.map((file) => ({
              file,
              opener: "openlabel" as const,
            })),
            ...buckets.calibration.map((file) => ({
              file,
              opener: "calibration" as const,
            })),
            ...buckets.trajectory.map((file) => ({
              file,
              opener: "trajectory" as const,
            })),
            ...buckets.mapGeometry.map((file) => ({
              file,
              opener: "mapGeometry" as const,
            })),
          ];
          for (const { file: f, opener, format } of eagerJobs) {
            try {
              const id = uniqueSourceId(f.name, [...existing, ...newSources]);
              const built = await SOURCE_OPENERS[opener](w, f, id, format);
              newSources.push({
                id,
                name: f.name,
                timeOffsetNs: 0n,
                ...built,
              });
              opened.push(f.name);
            } catch (e) {
              errors.push({ name: f.name, reason: String(e) });
            }
          }

          for (const pair of buckets.mp4Pairs) {
            try {
              // Only the `ftyp` + `moov` boxes are needed by the WASM parser —
              // `mdat` (the actual encoded video, often multi-GB) is never
              // dereferenced during `open_pair`. `readMp4HeaderBytes` walks the
              // box structure via `File.slice()` and returns just the header,
              // typically a few MB even for 2 GB sources.
              //
              // The sidecar `.mp4.timestamps` is passed as a `File` so the
              // worker reads its bytes there — no main-thread allocation.
              let mp4HeaderBytes: Uint8Array | null = await readMp4HeaderBytes(
                pair.mp4,
              );
              const handle = await w.openMp4Sidecar(mp4HeaderBytes, pair.ts);
              // `summary` and `index` both depend only on the handle — run them
              // in parallel (two independent worker round-trips).
              const [summary, index] = (await Promise.all([
                w.mp4SidecarSummary(handle),
                w.mp4SidecarIndex(handle),
              ])) as [Mp4SidecarSummary, Mp4SidecarIndex];
              // Release the transient header buffer — peak memory during open
              // drops back to steady state once WASM owns the index.
              mp4HeaderBytes = null;
              const id = uniqueSourceId(pair.mp4.name, [
                ...existing,
                ...newSources,
              ]);
              const channels = mp4Channels(id, summary);
              const cache = new Mp4SampleCache(pair.mp4, index);
              cache.onLoadedRangesChange((ranges) => {
                const prev = get().loadedRanges;
                set({ loadedRanges: { ...prev, [id]: ranges } });
              });
              cache.onPendingFetchChange((p) => {
                const prev = get().pendingFetch;
                set({ pendingFetch: { ...prev, [id]: p } });
              });
              newSources.push({
                id,
                kind: "mp4+sidecar",
                name: pair.mp4.name,
                handle,
                timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
                channels,
                mp4Cache: cache,
                // Video alignment is baked into the sidecar timestamps; the decode
                // hot path stays offset-free, so this is always 0n.
                timeOffsetNs: 0n,
              });
              opened.push(pair.mp4.name);
            } catch (e) {
              errors.push({ name: pair.mp4.name, reason: String(e) });
            }
          }

          // Sidecar-less mp4s (Feature 1) can't open until the user picks a
          // tabular source for their per-frame timestamps. Slice the header bytes
          // now (the same cheap ftyp+moov walk the paired path uses) and queue a
          // pending binding the `VideoTimestampDialog` resolves on confirm. We
          // DON'T add them to `opened` — they're not loaded yet.
          const newVideoBindings: PendingVideoBinding[] = [];
          for (const mp4 of buckets.videoNeedsTimestamps) {
            try {
              const headerBytes = await readMp4HeaderBytes(mp4);
              newVideoBindings.push({
                id: `vts-${videoBindingSeq++}`,
                name: mp4.name,
                file: mp4,
                headerBytes,
              });
            } catch (e) {
              errors.push({ name: mp4.name, reason: String(e) });
            }
          }

          // CSV / Parquet can't open until the user picks a time basis. Inspect
          // each one (without retaining its bytes), then queue a pending import
          // the dialog will turn into a source on confirm. The original `File`
          // is stored in the queue (not a byte copy) so the JS heap holds no
          // large allocation between inspect and confirm. We DON'T add them to
          // `opened` here — they're not loaded yet.
          const newPending: PendingTabularImport[] = [];
          for (const t of buckets.tabular) {
            try {
              // Pass the `File` to the worker — bytes are read there, zero
              // main-thread allocation for the inspect call.
              const schema = await w.tabularInspect(t.file, t.format);
              newPending.push({
                id: `tab-${tabularImportSeq++}`,
                name: t.file.name,
                format: t.format,
                file: t.file,
                schema,
                suggested: draftFromSchema(schema),
              });
            } catch (e) {
              errors.push({ name: t.file.name, reason: String(e) });
            }
          }

          // Unrecognised formats: first try the Format Registry for a recipe
          // that matches (extension / magic bytes) and open it straight away —
          // no agent, no network. Otherwise queue it for the Format Agent
          // dialog. See docs/12-format-agent.md.
          const newUnknownPending: PendingUnknownImport[] = [];
          for (const f of buckets.unknown) {
            try {
              const recipe = await matchRecipe(f);
              if (recipe) {
                // Stale-recipe gate (docs/12 §9): before opening, dry-run the
                // matched recipe over the file. A vendor that bumped the format
                // (newer rev) yields low coverage / framing errors; rather than
                // silently open garbage, queue it with the stale recipe so the
                // dialog can offer "re-derive with agent" (old recipe kept).
                const probe = await w.recipeDryRun(
                  f,
                  JSON.stringify(recipe),
                  50_000,
                );
                if (
                  probe.coverage < 0.99 ||
                  Number(probe.records_rejected) > 0
                ) {
                  newUnknownPending.push({
                    id: `unk-${unknownImportSeq++}`,
                    name: f.name,
                    size: f.size,
                    file: f,
                    staleRecipe: {
                      name: recipe.name ?? "(unnamed)",
                      coverage: probe.coverage,
                    },
                  });
                  continue;
                }
                const handle = await w.openRecipe(f, JSON.stringify(recipe));
                const summary = await w.recipeSummary(handle);
                const sourceId = uniqueSourceId(f.name, [
                  ...existing,
                  ...newSources,
                ]);
                newSources.push({
                  id: sourceId,
                  kind: "recipe",
                  name: f.name,
                  handle,
                  timeRange: {
                    startNs: summary.start_ns,
                    endNs: summary.end_ns,
                  },
                  channels: tabularChannels(sourceId, summary),
                  timeOffsetNs: 0n,
                });
                opened.push(sourceId);
              } else {
                newUnknownPending.push({
                  id: `unk-${unknownImportSeq++}`,
                  name: f.name,
                  size: f.size,
                  file: f,
                });
              }
            } catch (e) {
              errors.push({ name: f.name, reason: String(e) });
            }
          }

          commitOpenedSources(newSources, errors);
          if (newUnknownPending.length > 0) {
            set({
              pendingUnknownImports: [
                ...get().pendingUnknownImports,
                ...newUnknownPending,
              ],
            });
          }
          if (newPending.length > 0) {
            set({
              pendingTabularImports: [
                ...get().pendingTabularImports,
                ...newPending,
              ],
            });
          }
          // Queue video bindings AFTER tabular imports so the dialog's source
          // dropdown sees them — the tabular dialog renders first (its queue is
          // non-empty), and the video dialog only shows once that queue drains.
          if (newVideoBindings.length > 0) {
            set({
              pendingVideoBindings: [
                ...get().pendingVideoBindings,
                ...newVideoBindings,
              ],
            });
          }
          return { opened, errors };
        });

      const next = pending.then(run, run);
      // Keep the chain alive even if `run` throws so the next caller still
      // queues behind it rather than racing.
      pending = next.catch(() => undefined);
      return next;
    },

    async confirmTabularImport(id, basis) {
      const run = async () => {
        if (!worker) throw new Error("session store: worker not initialised");
        const w = worker;
        const pendingImport = get().pendingTabularImports.find(
          (p) => p.id === id,
        );
        // Unknown id (already confirmed/cancelled, or a stale dialog): no-op.
        if (!pendingImport) return;

        const timeBasis = draftToBasis(basis);
        if (timeBasis === null) {
          // The dialog gates Confirm on a valid draft, so this only fires for a
          // programmatic (dev-hook) call with a bad basis — surface it and
          // leave the import queued so the user can retry.
          set({
            lastOpenErrors: [
              {
                name: pendingImport.name,
                reason: "invalid time basis (missing column or epoch offset)",
              },
            ],
          });
          return;
        }

        const errors: BucketError[] = [];
        const newSources: SourceMeta[] = [];
        try {
          // Pass the `File` to the worker — bytes are read there, so the
          // JS heap never holds a second copy alongside the pending queue entry.
          const handle = await w.openTabular(
            pendingImport.file,
            pendingImport.format,
            basisToJson(timeBasis),
          );
          const summary = await w.tabularSummary(handle);
          const sourceId = uniqueSourceId(pendingImport.name, get().sources);
          newSources.push({
            id: sourceId,
            kind: "tabular",
            name: pendingImport.name,
            handle,
            timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
            channels: tabularChannels(sourceId, summary),
            timeOffsetNs: 0n,
          });
        } catch (e) {
          errors.push({ name: pendingImport.name, reason: String(e) });
        }

        // Register the source (widens globalRange, seeds cursor) exactly like
        // an MF4 open, then dequeue this import.
        commitOpenedSources(newSources, errors);
        set({
          pendingTabularImports: get().pendingTabularImports.filter(
            (p) => p.id !== id,
          ),
        });
      };
      const next = pending.then(run, run);
      pending = next.catch(() => undefined);
      await next;
    },

    cancelTabularImport(id) {
      const cur = get().pendingTabularImports;
      const next = cur.filter((p) => p.id !== id);
      if (next.length !== cur.length) set({ pendingTabularImports: next });
    },

    async dryRunRecipe(id, recipeJson) {
      if (!worker) throw new Error("session store: worker not initialised");
      const pendingImport = get().pendingUnknownImports.find(
        (p) => p.id === id,
      );
      if (!pendingImport) return null;
      // Bounded record budget keeps the validation responsive on huge files;
      // the agent loop (and the dialog preview) sample, not exhaustively decode.
      return worker.recipeDryRun(pendingImport.file, recipeJson, 200_000);
    },

    async confirmRecipeImport(id, recipeJson, opts) {
      const run = async () => {
        if (!worker) throw new Error("session store: worker not initialised");
        const w = worker;
        const pendingImport = get().pendingUnknownImports.find(
          (p) => p.id === id,
        );
        if (!pendingImport) return;

        const lowConfidence = opts?.lowConfidence === true;
        const errors: BucketError[] = [];
        const newSources: SourceMeta[] = [];
        let savedRecipe: Recipe | null = null;
        try {
          const handle = await w.openRecipe(pendingImport.file, recipeJson);
          const summary = await w.recipeSummary(handle);
          const sourceId = uniqueSourceId(pendingImport.name, get().sources);
          newSources.push({
            id: sourceId,
            kind: "recipe",
            name: pendingImport.name,
            handle,
            timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
            channels: tabularChannels(sourceId, summary),
            timeOffsetNs: 0n,
            // A draft-opened source carries the low-confidence banner and is NOT
            // registered (docs/12 §9); a normal/re-derived one is.
            ...(lowConfidence ? { lowConfidence: true } : {}),
          });
          // Only persist a recipe that actually opened — and never for a draft
          // (drafts stay in the parallel drafts shard, never auto-matched).
          if (!lowConfidence) {
            try {
              savedRecipe = JSON.parse(recipeJson) as Recipe;
            } catch {
              savedRecipe = null;
            }
          }
        } catch (e) {
          errors.push({ name: pendingImport.name, reason: String(e) });
        }

        commitOpenedSources(newSources, errors);
        if (savedRecipe) {
          // Re-derive replacement (docs/12 §9): if the new recipe was named
          // differently from the one it replaces, drop the stale entry so the
          // registry doesn't keep both. `saveRecipe` itself overwrites a
          // same-named entry.
          if (
            opts?.replaceRecipeName &&
            opts.replaceRecipeName !== (savedRecipe.name ?? "")
          ) {
            removeRecipe(opts.replaceRecipeName);
          }
          saveRecipe(savedRecipe);
        }
        // Dequeue only on success; a failed open leaves it queued for a retry.
        if (newSources.length > 0) {
          set({
            pendingUnknownImports: get().pendingUnknownImports.filter(
              (p) => p.id !== id,
            ),
            // Offer the visualisation-bootstrap layout proposal for the source
            // we just opened (docs/12 §7). The dialog renders the heuristic
            // floor immediately; "Refine with Claude" upgrades it.
            pendingLayoutProposal: { sourceId: newSources[0].id },
          });
        }
      };
      const next = pending.then(run, run);
      pending = next.catch(() => undefined);
      await next;
    },

    cancelUnknownImport(id) {
      const cur = get().pendingUnknownImports;
      const next = cur.filter((p) => p.id !== id);
      if (next.length !== cur.length) set({ pendingUnknownImports: next });
    },

    reDeriveRecipe(name, file) {
      if (file.size === 0) return;
      set({
        pendingUnknownImports: [
          ...get().pendingUnknownImports,
          {
            id: `unk-${unknownImportSeq++}`,
            name: file.name,
            size: file.size,
            file,
            reDeriveName: name,
          },
        ],
      });
    },

    async ingestConvertedMcap(id, name, bytes) {
      // Open the sandbox-produced MCAP through the EXISTING openFiles/McapReader
      // path (docs/12 §10) — a converted copy is a normal MCAP source. Tag the
      // freshly-opened source `oneShot` so the UI labels it "converted copy —
      // recipe not available". Never registers a recipe.
      const before = new Set(get().sources.map((s) => s.id));
      const mcapName = name.toLowerCase().endsWith(".mcap")
        ? name
        : `${name}.mcap`;
      // BlobPart copy keeps the worker re-reading the bytes (mirrors the dev
      // `openFiles` hook), so peak memory stays near the file size.
      const file = new File([bytes as BlobPart], mcapName);
      await get().openFiles([file]);
      const fresh = get().sources.filter((s) => !before.has(s.id));
      if (fresh.length > 0) {
        const nextSources = get().sources.map((s) =>
          fresh.some((f) => f.id === s.id) ? { ...s, oneShot: true } : s,
        );
        set({
          sources: nextSources,
          // Drop the originating unknown import — its escape hatch is done.
          pendingUnknownImports: get().pendingUnknownImports.filter(
            (p) => p.id !== id,
          ),
        });
      }
    },

    proposeLayoutFor(sourceId) {
      if (!get().sources.some((s) => s.id === sourceId)) return;
      set({ pendingLayoutProposal: { sourceId } });
    },
    dismissLayoutProposal() {
      if (get().pendingLayoutProposal !== null) {
        set({ pendingLayoutProposal: null });
      }
    },

    async confirmVideoBinding(id, tabularSourceId) {
      const run = async () => {
        if (!worker) throw new Error("session store: worker not initialised");
        const w = worker;
        const pendingBinding = get().pendingVideoBindings.find(
          (p) => p.id === id,
        );
        // Unknown id (already confirmed/cancelled, or a stale dialog): no-op.
        if (!pendingBinding) return;
        const tabularSource = get().sources.find(
          (s) => s.id === tabularSourceId && s.kind === "tabular",
        );
        if (!tabularSource) {
          // The dialog only offers loaded tabular sources, so this is a stale /
          // programmatic call — surface it and leave the binding queued.
          set({
            lastOpenErrors: [
              {
                name: pendingBinding.name,
                reason: `unknown tabular source: ${tabularSourceId}`,
              },
            ],
          });
          return;
        }

        const errors: BucketError[] = [];
        const newSources: SourceMeta[] = [];
        try {
          // The converted, ascending ns-UTC time column of the chosen tabular
          // source — one entry per row. Row i becomes frame i in the sidecar.
          const ts = await w.tabularTimeColumnNs(tabularSource.handle);
          // Synthesize the `.mp4.timestamps` text (bigint → string, never
          // narrowed) and reuse the EXACT paired-sidecar open path. The mp4
          // reader validates line count == sample count and fails the open with
          // a descriptive error on a mismatch, which we surface below.
          const sidecarBytes = synthesizeSidecarBytes(ts);
          let headerBytes: Uint8Array | null = pendingBinding.headerBytes;
          const handle = await w.openMp4Sidecar(headerBytes, sidecarBytes);
          const summary = await w.mp4SidecarSummary(handle);
          const index: Mp4SidecarIndex = await w.mp4SidecarIndex(handle);
          headerBytes = null;
          const sourceId = uniqueSourceId(pendingBinding.name, get().sources);
          const channels = mp4Channels(sourceId, summary);
          const cache = new Mp4SampleCache(pendingBinding.file, index);
          cache.onLoadedRangesChange((ranges) => {
            const prev = get().loadedRanges;
            set({ loadedRanges: { ...prev, [sourceId]: ranges } });
          });
          cache.onPendingFetchChange((p) => {
            const prev = get().pendingFetch;
            set({ pendingFetch: { ...prev, [sourceId]: p } });
          });
          newSources.push({
            id: sourceId,
            kind: "mp4+sidecar",
            name: pendingBinding.name,
            handle,
            timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
            channels,
            mp4Cache: cache,
            timeOffsetNs: 0n,
          });
        } catch (e) {
          errors.push({ name: pendingBinding.name, reason: String(e) });
        }

        commitOpenedSources(newSources, errors);
        // Dequeue only on a successful open; a failure leaves the binding
        // queued so the user can pick a different source and retry.
        if (newSources.length > 0) {
          set({
            pendingVideoBindings: get().pendingVideoBindings.filter(
              (p) => p.id !== id,
            ),
          });
        }
      };
      const next = pending.then(run, run);
      pending = next.catch(() => undefined);
      await next;
    },

    cancelVideoBinding(id) {
      const cur = get().pendingVideoBindings;
      const next = cur.filter((p) => p.id !== id);
      if (next.length !== cur.length) set({ pendingVideoBindings: next });
    },

    setSourceOffset(sourceId, offsetNs) {
      const parsed = parseEpochOffsetNs(offsetNs);
      if (parsed === null) return; // Unparseable string — ignore.
      const prev = get().sources;
      const src = prev.find((s) => s.id === sourceId);
      // Unknown source, or a video source (offset is meaningless there — its
      // alignment lives in the sidecar timestamps, and the decode hot path
      // stays offset-free): no-op.
      if (!src || src.kind === "mp4+sidecar") return;
      if ((src.timeOffsetNs ?? 0n) === parsed) return;
      const nextSources = prev.map((s) =>
        s.id === sourceId ? { ...s, timeOffsetNs: parsed } : s,
      );
      // The new `sources` array reference makes `syncIndex()` rebuild the
      // derived index on the next fetch, so it reads the new `timeOffsetNs`.
      set({ sources: nextSources });
    },

    async openUrl(url) {
      const run = (): Promise<OpenResult> =>
        timed("open", async () => {
          if (!worker) throw new Error("session store: worker not initialised");
          const w = worker;

          const trimmed = url.trim();
          const opened: string[] = [];
          const errors: BucketError[] = [];
          const newSources: SourceMeta[] = [];
          const existing = get().sources;

          try {
            const { kind, name } = classifyUrl(trimmed);
            // MF4 reads lazily over HTTP ranges via its index; MCAP fetches
            // the whole body. Both end up as ordinary in-store sources, so
            // close / removeSource / fetch-range all work unchanged.
            const handle =
              kind === "mcap"
                ? await w.openMcapUrl(trimmed)
                : await w.openMf4Url(trimmed);
            const id = uniqueSourceId(name, [...existing, ...newSources]);
            if (kind === "mcap") {
              const summary = await w.mcapSummary(handle);
              newSources.push({
                id,
                kind: "mcap",
                name,
                handle,
                timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
                channels: mcapChannels(id, summary),
                timeOffsetNs: 0n,
              });
            } else {
              const summary = await w.mf4Summary(handle);
              newSources.push({
                id,
                kind: "mf4",
                name,
                handle,
                timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
                channels: mf4Channels(id, summary),
                timeOffsetNs: 0n,
              });
            }
            opened.push(name);
          } catch (e) {
            // Show the bare message (the worker phrases CORS/range failures
            // for the user); `String(e)` would prefix the error class name.
            errors.push({
              name: trimmed,
              reason: e instanceof Error ? e.message : String(e),
            });
          }

          commitOpenedSources(newSources, errors);
          return { opened, errors };
        });

      const next = pending.then(run, run);
      pending = next.catch(() => undefined);
      return next;
    },

    async clear() {
      const run = async () => {
        // Inline (agent-pushed) storage lives on the main thread, not in the
        // worker — wipe it regardless of worker presence.
        resetInlineSources();
        // Drop the shared decoded-LiDAR-spin cache so a fresh load can't serve
        // geometry decoded from a previous session's (possibly same-named)
        // channel.
        clearPointCloudSpinCache();
        if (!worker) return;
        const w = worker;
        for (const s of get().sources) {
          try {
            if (s.kind === "inline") continue; // no wasm handle to free
            await closeFor(w, s);
            // Drop the lazy sample cache — releases its `File` ref,
            // detaches notification subscribers, and frees any cached
            // sample bytes.
            s.mp4Cache?.dispose();
          } catch (err) {
            // The slab entry either stays for the lifetime of the worker
            // or was already freed, so we always continue resetting the
            // session — but surface the failure so worker panics / dropped
            // postMessage replies aren't silent.
            console.warn(
              `[session.clear] close failed for ${s.kind}#${s.handle}`,
              err,
            );
          }
        }
        // Wipe session + transport + per-panel bindings, but keep
        // `layoutJson`, `namedLayouts`, `bookmarks`, and
        // `eventTagConfig` so the user's dock layout, saved layouts,
        // events, and tag taxonomy survive a clear (T6.2 — layout
        // outlives a session, per docs/06-ui-and-panels.md:167;
        // bookmarks + the event-tag config follow the same posture).
        set({
          sources: [],
          channels: [],
          globalRange: null,
          cursorNs: 0n,
          playing: false,
          speed: 1,
          seekEpoch: 0,
          hoverNs: null,
          // Reset every per-panel binding map in one place (one source of
          // truth) so a new binding map can't be forgotten here.
          ...emptyBindings(),
          plotZoom: {},
          sharedPlotZoomX: null,
          calibrationCache: {},
          lastOpenErrors: [],
          loadedRanges: {},
          pendingFetch: {},
          pendingTabularImports: [],
          pendingUnknownImports: [],
          pendingVideoBindings: [],
          pendingLayoutProposal: null,
          demoLoad: {
            phase: "idle",
            receivedBytes: 0,
            totalBytes: 0,
            error: null,
          },
        });
      };
      const next = pending.then(run, run);
      pending = next.catch(() => undefined);
      await next;
    },

    async removeSource(sourceId) {
      const run = async () => {
        const state = get();
        const src = state.sources.find((s) => s.id === sourceId);
        // Unknown id (already removed, or a stale click): nothing to do.
        if (!src) return;

        if (src.kind === "inline") {
          // Main-thread storage, no wasm handle — drop it directly.
          dropInlineSource(sourceId);
        } else if (worker) {
          const w = worker;
          try {
            await closeFor(w, src);
          } catch (err) {
            // Mirror `clear()`: a failed close shouldn't strand the source
            // in the UI, so we log and proceed with the state reset.
            console.warn(
              `[session.removeSource] close failed for ${src.kind}#${src.handle}`,
              err,
            );
          }
        }
        // Drop the lazy sample cache regardless of worker presence —
        // releases its `File` ref and detaches subscribers.
        src.mp4Cache?.dispose();
        // A removed source's channel ids could be reused by a later same-named
        // open, so drop the shared decoded-spin cache too (tiny — capped at a
        // few entries).
        clearPointCloudSpinCache();

        // Re-read in case `openFiles` mutated state while the close awaited.
        const cur = get();
        const goneChannelIds = new Set(
          cur.channels.filter((c) => c.sourceId === sourceId).map((c) => c.id),
        );

        const nextSources = cur.sources.filter((s) => s.id !== sourceId);
        const nextChannels = cur.channels.filter(
          (c) => c.sourceId !== sourceId,
        );
        const nextRange = mergeGlobalRange(nextSources);
        // Clamp the cursor into the (possibly shrunken) range; reset to 0
        // when the last source goes so the empty session matches `clear()`.
        const nextCursor = nextRange
          ? bigMax(nextRange.startNs, bigMin(nextRange.endNs, cur.cursorNs))
          : 0n;

        // Forget per-source range/fetch bookkeeping for the closed source.
        const loadedRanges = { ...cur.loadedRanges };
        delete loadedRanges[sourceId];
        const pendingFetch = { ...cur.pendingFetch };
        delete pendingFetch[sourceId];

        set({
          sources: nextSources,
          channels: nextChannels,
          globalRange: nextRange,
          cursorNs: nextCursor,
          // Closing a source means it can no longer drive the cursor — stop
          // playback so we don't keep ticking against a moved end-of-range.
          playing: nextRange ? cur.playing : false,
          videoBindings: pruneSingleBindings(cur.videoBindings, goneChannelIds),
          plotBindings: pruneMultiBindings(cur.plotBindings, goneChannelIds),
          sceneBindings: pruneSingleBindings(cur.sceneBindings, goneChannelIds),
          mapBindings: pruneMapBindings(cur.mapBindings, goneChannelIds),
          tableBindings: pruneMultiBindings(cur.tableBindings, goneChannelIds),
          valueBindings: pruneMultiBindings(cur.valueBindings, goneChannelIds),
          enumBindings: pruneMultiBindings(cur.enumBindings, goneChannelIds),
          pointCloudOverlays: prunePointCloudOverlays(
            cur.pointCloudOverlays,
            goneChannelIds,
          ),
          calibrationCache: pruneCalibrationCache(
            cur.calibrationCache,
            goneChannelIds,
          ),
          loadedRanges,
          pendingFetch,
        });
      };
      const next = pending.then(run, run);
      pending = next.catch(() => undefined);
      await next;
    },
  };
});
