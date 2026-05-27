// Zustand session store. Scope: source/channel session, transport
// (cursor/playing/speed), FlexLayout JSON + per-panel bindings, named
// layouts, bookmarks, and UI shell state.
//
// The store holds the `Remote<DataCoreApi>` proxy and dispatches to the
// correct `open_*` / `close_*` WASM function based on the bucketed file
// type. Each live `SourceMeta` carries the wasm slab handle so `clear()`
// can tear everything down without a separate handle table.
//
// Layout + bindings hydrate synchronously from `localStorage` at
// store-create time so the first render already has the saved layout —
// avoids a default-then-swap flash.

import type { Remote } from "comlink";
import { create } from "zustand";
import { bucketFiles, type BucketError } from "./bucket";
import { MAX_PLOT_SERIES } from "../panels/palette";
import {
  loadLayoutFromStorage,
  type MapBinding,
} from "../layout/persist";
import { loadUiFromStorage, type RailTab } from "./persist/ui";
import {
  loadNamedLayoutsFromStorage,
  type NamedLayout,
} from "./persist/namedLayouts";
import {
  loadBookmarksFromStorage,
  type Bookmark,
} from "./persist/bookmarks";
import { colorFor } from "../panels/palette";
import { formatRelative } from "../timeline/formatTime";
import { mark, measure, timed } from "../perf";
import type {
  ChannelKindWire,
  DataCoreApi,
  McapSummary,
  Mf4Summary,
  Mp4SidecarIndex,
  Mp4SidecarSummary,
} from "../workerClient";
import {
  Mp4SampleCache,
  type BufferedRange,
  type PendingFetch,
} from "./mp4SampleCache";
import { readMp4HeaderBytes } from "./mp4HeaderSlice";

export type SourceKind = "mcap" | "mf4" | "mp4+sidecar";
export type ChannelKind = ChannelKindWire;

export interface TimeRange {
  startNs: bigint;
  endNs: bigint;
}

export interface Channel {
  // Globally unique across the loaded session — composed via
  // `qualifiedChannelId(sourceId, nativeId)`. `uniqueSourceId` (below)
  // keeps source ids distinct, and the length-prefix encoding in
  // `qualifiedChannelId` makes `(sourceId, nativeId)` an injective key
  // — so binding maps and `channelMap` never collide across files.
  id: string;
  // Per-source channel id as emitted by the wasm reader (`0/1` for MF4,
  // the topic string for MCAP, `1/video` for MP4). The worker fetch
  // APIs expect this; it is NOT unique across sources.
  nativeId: string;
  sourceId: string;
  name: string;
  kind: ChannelKind;
  dtype: string | null;
  unit: string | null;
  sampleCount: number;
  timeRange: TimeRange;
}

// Length-prefix encoding so distinct (sourceId, nativeId) pairs cannot
// compose to the same string regardless of how either side embeds `|`.
export function qualifiedChannelId(
  sourceId: string,
  nativeId: string,
): string {
  return `${nativeId.length}|${nativeId}|${sourceId}`;
}

export interface SourceMeta {
  id: string;
  kind: SourceKind;
  name: string;
  handle: number;
  timeRange: TimeRange;
  channels: Channel[];
  /**
   * Lazy-load handle for `mp4+sidecar` sources. Holds the per-sample
   * index (offsets/sizes/sync flags/pts) plus the original `File` blob
   * the cache reads from on demand. Other source kinds leave this
   * undefined; they keep their eager WASM-resident layout.
   */
  mp4Cache?: Mp4SampleCache;
}

export interface OpenResult {
  opened: string[];
  errors: BucketError[];
}

/**
 * Per-plot-panel display settings. Shape is an object so future fields
 * (axis pinning, log/linear, smoothing) can land without bumping the
 * persistence schema.
 *
 * `gapThresholdSec === null` keeps `spanGaps: true` — alignment
 * artifacts span and channel-loss gaps render as a horizontal hold.
 * A positive number switches the panel to step-hold mode with explicit
 * gaps for any inter-sample dx exceeding the threshold; see
 * `mergeSeries` for the rendering contract.
 */
export interface PlotPanelSettings {
  gapThresholdSec: number | null;
}

export const DEFAULT_PLOT_PANEL_SETTINGS: PlotPanelSettings = {
  gapThresholdSec: null,
};

export interface SessionState {
  sources: SourceMeta[];
  channels: Channel[];
  globalRange: TimeRange | null;
  // Transport. Invariants — clamp to `globalRange`, bounded speed, stop
  // at end-of-session — are enforced by the actions below so UI code
  // can't violate them.
  cursorNs: bigint;
  playing: boolean;
  speed: number;
  // Time convention shown across the app (Transport segmented toggle,
  // PlotPanel X-axis formatter). Default `relative` because engineer
  // recordings rarely care about wall-clock. Persisted in the
  // `driveline.ui.v2` shard (v1 → default).
  timeMode: "relative" | "absolute";
  // Monotonic counter bumped on every user-initiated cursor change
  // (`setCursor`, plus `play()` rewinds and end-of-session jumps).
  // Playback rAF uses `advanceCursor` and does NOT bump it — videoDecode
  // and other seek-aware consumers subscribe to `seekEpoch` rather than
  // `cursorNs` so a 60 Hz tick doesn't look like a seek.
  seekEpoch: number;
  // `layoutJson` is the opaque FlexLayout model (`Model.toJson()`
  // output). Binding maps are keyed by FlexLayout tab id so a
  // closed-and-reopened panel can reclaim its configuration on reload.
  layoutJson: unknown | null;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  // Decoupled from `plotBindings` because settings outlive the binding
  // set — changing bound channels shouldn't drop the gap-threshold
  // choice. Round-trips through the layout adapter and named-layout
  // snapshots.
  plotPanelSettings: Record<string, PlotPanelSettings>;
  // Lifted out of `VideoPanel` local state so the Panel drawer can flip
  // it from outside the panel. Default `false` when absent.
  videoHudOn: Record<string, boolean>;
  sceneBindings: Record<string, string | null>;
  mapBindings: Record<string, MapBinding | null>;
  tableBindings: Record<string, string[]>;
  enumBindings: Record<string, string | null>;
  // `selectedPanelId` is per-session (not persisted).
  activeRailTab: RailTab | null;
  railCollapsed: boolean;
  selectedPanelId: string | null;
  // Named layouts persist to `driveline.layouts.named.v1` and outlive a
  // session — `clear()` does not reset. `activeNamedLayoutId` tracks
  // the active row in the Layout drawer; the drawer also computes a
  // separate `live` pill from a stringified layoutJson compare.
  namedLayouts: NamedLayout[];
  activeNamedLayoutId: string | null;
  // Bookmarks persist to `driveline.bookmarks.v1` and outlive a session
  // (same posture as `namedLayouts`). `ns` is `bigint`; the persist
  // adapter encodes as decimal string. Storage preserves insertion
  // order so renames target a stable index; display-time sorting
  // happens in the drawer/marker components.
  bookmarks: Bookmark[];
  /**
   * Errors from the most recent `openFiles` batch. The Sources drawer
   * renders these so a malformed MCAP/MF4 or an unknown extension is
   * surfaced rather than silently dropped. Replaced wholesale on the
   * next `openFiles` call; cleared on `clear()` and via
   * `dismissOpenErrors()`.
   */
  lastOpenErrors: BucketError[];
  /**
   * Per-source buffered ranges for the lazy-loaded mp4+sidecar caches,
   * keyed by `SourceMeta.id`. The Transport scrubber renders one shaded
   * segment per entry so the user can see how much of the timeline is
   * resident in memory. Other source kinds (mcap, mf4) leave their entry
   * undefined.
   */
  loadedRanges: Record<string, BufferedRange[]>;
  /**
   * Per-source pending-fetch indicator. Populated when a seek lands in
   * unloaded territory and cleared once the first sample for that target
   * arrives. The Transport renders a spinner near the cursor while any
   * source has a pending fetch.
   */
  pendingFetch: Record<string, PendingFetch | null>;
  /**
   * Ingestion-in-progress flag. `true` while an `openFiles` batch is
   * running (bucket → per-source open → merge); `false` otherwise.
   * Read by VideoPanelContainer (and other empty-state surfaces) to
   * render a "Decoding… / Indexing…" overlay so a multi-MB MCAP or a
   * large mp4 doesn't drop into a silent UI. Issue #33.
   */
  ingesting: boolean;
  /** Drives a drop batch through bucket → per-source open → merge. */
  openFiles(files: File[]): Promise<OpenResult>;
  /** Clear `lastOpenErrors` (used by the Sources drawer dismiss). */
  dismissOpenErrors(): void;
  /** Close every loaded wasm handle and reset to the empty session. */
  clear(): Promise<void>;
  /**
   * Test / dev seam: inject the Comlink worker proxy. Pass `null` on
   * teardown so `VideoPanel.tsx` and other consumers don't keep a handle
   * to a terminated worker across `<StrictMode>` unmount/remount.
   */
  setWorker(worker: Remote<DataCoreApi> | null): void;
  /**
   * Expose the injected worker proxy to other modules that need a direct
   * dataCore handle — specifically `VideoPanel`, which has to bridge the
   * same dataCore slab into its videoDecode worker so MCAP handles round-
   * trip correctly.
   */
  getWorker(): Remote<DataCoreApi> | null;
  /** Start playback. No-op without a session; rewinds if at end. */
  play(): void;
  /** Stop playback. Always safe to call. */
  pause(): void;
  /** Set playback speed; clamped to [MIN_SPEED, MAX_SPEED]. */
  setSpeed(n: number): void;
  /** Toggle / set the relative-vs-absolute time mode (Issue #6). */
  setTimeMode(mode: "relative" | "absolute"): void;
  /** Move the cursor; clamped to `globalRange`. Pauses if at `endNs`.
   *  Bumps `seekEpoch` so the video pipeline issues a real seek even
   *  while `playing` is true. */
  setCursor(ns: bigint): void;
  /** Playback-loop seam: advance the cursor without bumping `seekEpoch`,
   *  so a 60 Hz rAF tick does not look like a user scrub. Same clamp
   *  and end-of-session auto-pause as `setCursor`. */
  advanceCursor(ns: bigint): void;
  /** Replace the FlexLayout JSON model wholesale. */
  setLayoutJson(json: unknown | null): void;
  /** Bind a video panel to a channel, or `null` to clear. */
  setVideoBinding(panelId: string, channelId: string | null): void;
  /** Set a video panel's HUD overlay bit. */
  setVideoHudOn(panelId: string, on: boolean): void;
  /** Toggle a video panel's HUD overlay bit (default false → true). */
  toggleVideoHudOn(panelId: string): void;
  /** Replace a plot panel's bound channels wholesale (capped, deduped). */
  setPlotBinding(panelId: string, ids: string[]): void;
  /** Append one channel to a plot panel (no-op if present or at cap). */
  addPlotChannel(panelId: string, channelId: string): void;
  /** Remove one channel from a plot panel (no-op if absent). */
  removePlotChannel(panelId: string, channelId: string): void;
  /**
   * Set the per-panel gap threshold in seconds. `null` (or a
   * non-positive / non-finite number) restores the default
   * `spanGaps:true` rendering. Persists through layout adapter so a
   * reload preserves the choice.
   */
  setPlotGapThreshold(panelId: string, sec: number | null): void;
  /** Bind a 3D scene panel to a single channel; `null` clears. */
  setSceneBinding(panelId: string, channelId: string | null): void;
  /** Bind a map panel to lat/lon channels; pass `null` to clear. */
  setMapBinding(panelId: string, binding: MapBinding | null): void;
  /** Replace a table panel's bound channels wholesale (capped, deduped). */
  setTableBinding(panelId: string, ids: string[]): void;
  /** Append one channel to a table panel (no-op if present or at cap). */
  addTableChannel(panelId: string, channelId: string): void;
  /** Remove one channel from a table panel (no-op if absent). */
  removeTableChannel(panelId: string, channelId: string): void;
  /** Bind an enum strip panel to a single channel; `null` clears. */
  setEnumBinding(panelId: string, channelId: string | null): void;
  /** Switch the rail's open drawer; pass `null` to close. */
  setActiveRailTab(tab: RailTab | null): void;
  /** Hide / show the entire rail column. */
  setRailCollapsed(collapsed: boolean): void;
  /** Mark a panel as selected for the Panel drawer (Phase 7). */
  setSelectedPanelId(id: string | null): void;
  /**
   * Snapshot the current `layoutJson` + binding maps into a new
   * `NamedLayout` entry. Returns the freshly-minted id so callers (and
   * the dev hook) can correlate the row.
   */
  saveCurrentLayoutAs(name: string): string;
  /**
   * Restore a previously-saved layout: writes `layoutJson`, both
   * binding maps, and `activeNamedLayoutId` in one `set` so the
   * persistence adapter and the FlexLayout rebuild path see a single
   * coherent snapshot. No-op if `id` does not match a saved entry.
   */
  restoreNamedLayout(id: string): void;
  /**
   * Drop a saved layout from the slice. If the removed entry was the
   * active one, `activeNamedLayoutId` resets to `null`.
   */
  removeNamedLayout(id: string): void;
  /**
   * Add a bookmark at the current cursor with an optional label
   * (default: `bookmark @ <relative-time>`). Returns the new id, or
   * `null` when `globalRange === null` (no fixture loaded — cursor
   * has no meaningful position to bookmark).
   */
  addBookmarkAtCursor(label?: string): string | null;
  /**
   * Test seam: add a bookmark at an explicit `ns`. No clamping;
   * caller is responsible for keeping `ns` inside `globalRange`.
   * Returns the new id.
   */
  addBookmark(ns: bigint, label?: string): string;
  /** Remove a bookmark; no-op on unknown id. */
  removeBookmark(id: string): void;
  /**
   * Rename a bookmark in-place. Trimmed empty labels are rejected
   * (no-op) so an accidental Enter on an empty input doesn't blank
   * the row.
   */
  renameBookmark(id: string, label: string): void;
  /**
   * Fetch an Arrow IPC batch for `channelId` over `[startNs, endNs)`.
   * Dispatches to the right reader based on the owning source's kind so
   * panels never see the worker shape directly.
   */
  fetchChannelRange(
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array>;
}

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

// `randomUUID()` is available in modern browsers and Node ≥ 19; the
// `Math.random` fallback keeps unit tests under jsdom or older runtimes
// from crashing while still producing a unique-per-call id with the
// supplied prefix.
function mintId(prefix: string): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function mergeGlobalRange(sources: SourceMeta[]): TimeRange | null {
  if (sources.length === 0) return null;
  let start = sources[0].timeRange.startNs;
  let end = sources[0].timeRange.endNs;
  for (let i = 1; i < sources.length; i++) {
    start = bigMin(start, sources[i].timeRange.startNs);
    end = bigMax(end, sources[i].timeRange.endNs);
  }
  return { startNs: start, endNs: end };
}

function uniqueSourceId(base: string, existing: SourceMeta[]): string {
  if (!existing.some((s) => s.id === base)) return base;
  let n = 2;
  while (existing.some((s) => s.id === `${base} (${n})`)) n++;
  return `${base} (${n})`;
}

function mcapChannels(sourceId: string, s: McapSummary): Channel[] {
  return s.channels.map((c) => ({
    id: qualifiedChannelId(sourceId, c.id),
    nativeId: c.id,
    sourceId,
    name: c.name,
    kind: c.kind,
    dtype: c.dtype,
    unit: c.unit,
    sampleCount: c.sample_count,
    timeRange: { startNs: c.start_ns, endNs: c.end_ns },
  }));
}
function mf4Channels(sourceId: string, s: Mf4Summary): Channel[] {
  // Readers currently emit one kind per source: Mf4Reader always yields
  // scalar F64 channels. Hardcode the kind/dtype here so the wasm summary
  // doesn't have to widen.
  return s.channels.map((c) => ({
    id: qualifiedChannelId(sourceId, c.id),
    nativeId: c.id,
    sourceId,
    name: c.name,
    kind: "scalar" as const,
    dtype: "f64",
    unit: c.unit,
    sampleCount: c.sample_count,
    timeRange: { startNs: c.start_ns, endNs: c.end_ns },
  }));
}
function mp4Channels(sourceId: string, s: Mp4SidecarSummary): Channel[] {
  return s.channels.map((c) => ({
    id: qualifiedChannelId(sourceId, c.id),
    nativeId: c.id,
    sourceId,
    name: c.name,
    kind: "video" as const,
    dtype: null,
    unit: null,
    sampleCount: c.sample_count,
    timeRange: { startNs: c.start_ns, endNs: c.end_ns },
  }));
}

async function fileBytes(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

export const useSession = create<SessionState>((set, get) => {
  let worker: Remote<DataCoreApi> | null = null;
  // Serialise `openFiles` so two rapid drops don't interleave `set()` calls.
  let pending: Promise<unknown> = Promise.resolve();
  // Hydrate layout + bindings synchronously so the first render paints the
  // saved layout. Missing / malformed storage → `null` and empty maps; the
  // Workspace falls back to `defaultLayoutModel` when `layoutJson === null`.
  const hydrated = loadLayoutFromStorage();
  const hydratedUi = loadUiFromStorage();
  const hydratedNamedLayouts = loadNamedLayoutsFromStorage();
  const hydratedBookmarks = loadBookmarksFromStorage();

  return {
    sources: [],
    channels: [],
    globalRange: null,
    cursorNs: 0n,
    playing: false,
    speed: 1,
    timeMode: hydratedUi?.timeMode ?? "relative",
    seekEpoch: 0,
    layoutJson: hydrated?.layoutJson ?? null,
    videoBindings: hydrated?.videoBindings ?? {},
    plotBindings: hydrated?.plotBindings ?? {},
    plotPanelSettings: hydrated?.plotPanelSettings ?? {},
    videoHudOn: hydrated?.videoHudOn ?? {},
    sceneBindings: hydrated?.sceneBindings ?? {},
    mapBindings: hydrated?.mapBindings ?? {},
    tableBindings: hydrated?.tableBindings ?? {},
    enumBindings: hydrated?.enumBindings ?? {},
    activeRailTab: hydratedUi?.activeRailTab ?? null,
    railCollapsed: hydratedUi?.railCollapsed ?? false,
    selectedPanelId: null,
    namedLayouts: hydratedNamedLayouts?.layouts ?? [],
    activeNamedLayoutId: hydratedNamedLayouts?.activeNamedLayoutId ?? null,
    bookmarks: hydratedBookmarks ?? [],
    lastOpenErrors: [],
    loadedRanges: {},
    pendingFetch: {},
    ingesting: false,

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
      if (mode !== "relative" && mode !== "absolute") return;
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
      // Out-of-band edits (drag, dev hook, reset) break the active
      // named-layout identity — clear it so the Layout drawer's active
      // row no longer points at a layout the user has diverged from.
      //
      // SEAM: `restoreNamedLayout` bypasses this by writing
      // `{ layoutJson, activeNamedLayoutId }` in one `set({...})` call.
      // Do not refactor it to call `setLayoutJson(...)` then
      // `setActiveNamedLayoutId(...)` — this line would clobber the
      // active id on every restore.
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
      const seen = new Set<string>();
      const next: string[] = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
        if (next.length >= MAX_PLOT_SERIES) break;
      }
      set({ plotBindings: { ...get().plotBindings, [panelId]: next } });
    },

    addPlotChannel(panelId, channelId) {
      const prev = get().plotBindings;
      const existing = prev[panelId] ?? [];
      if (existing.includes(channelId)) return;
      if (existing.length >= MAX_PLOT_SERIES) return;
      set({
        plotBindings: { ...prev, [panelId]: [...existing, channelId] },
      });
    },

    removePlotChannel(panelId, channelId) {
      const prev = get().plotBindings;
      const existing = prev[panelId];
      if (!existing || !existing.includes(channelId)) return;
      set({
        plotBindings: {
          ...prev,
          [panelId]: existing.filter((x) => x !== channelId),
        },
      });
    },

    setPlotGapThreshold(panelId, sec) {
      const prev = get().plotPanelSettings;
      const existing = prev[panelId] ?? DEFAULT_PLOT_PANEL_SETTINGS;
      // Non-finite / non-positive values collapse to null so the
      // persistence layer never sees -Infinity / NaN.
      const normalised: number | null =
        sec !== null && Number.isFinite(sec) && sec > 0 ? sec : null;
      if (existing.gapThresholdSec === normalised) return;
      set({
        plotPanelSettings: {
          ...prev,
          [panelId]: { ...existing, gapThresholdSec: normalised },
        },
      });
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
      // a no-op — avoids spurious persistence writes from the drawer's
      // double-bind path.
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

    setTableBinding(panelId, ids) {
      const seen = new Set<string>();
      const next: string[] = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
        if (next.length >= MAX_PLOT_SERIES) break;
      }
      set({ tableBindings: { ...get().tableBindings, [panelId]: next } });
    },

    addTableChannel(panelId, channelId) {
      const prev = get().tableBindings;
      const existing = prev[panelId] ?? [];
      if (existing.includes(channelId)) return;
      if (existing.length >= MAX_PLOT_SERIES) return;
      set({
        tableBindings: { ...prev, [panelId]: [...existing, channelId] },
      });
    },

    removeTableChannel(panelId, channelId) {
      const prev = get().tableBindings;
      const existing = prev[panelId];
      if (!existing || !existing.includes(channelId)) return;
      set({
        tableBindings: {
          ...prev,
          [panelId]: existing.filter((x) => x !== channelId),
        },
      });
    },

    setEnumBinding(panelId, channelId) {
      const prev = get().enumBindings;
      if ((prev[panelId] ?? null) === channelId) return;
      set({ enumBindings: { ...prev, [panelId]: channelId } });
    },

    setActiveRailTab(tab) {
      if (get().activeRailTab === tab) return;
      set({ activeRailTab: tab });
    },

    setRailCollapsed(collapsed) {
      if (get().railCollapsed === collapsed) return;
      set({ railCollapsed: collapsed });
    },

    setSelectedPanelId(id) {
      if (get().selectedPanelId === id) return;
      set({ selectedPanelId: id });
    },

    saveCurrentLayoutAs(name) {
      const id = mintId("nl");
      const {
        layoutJson,
        videoBindings,
        plotBindings,
        plotPanelSettings,
        sceneBindings,
        mapBindings,
        tableBindings,
        enumBindings,
        namedLayouts,
      } = get();
      const entry: NamedLayout = {
        id,
        name,
        layoutJson,
        videoBindings: { ...videoBindings },
        plotBindings: { ...plotBindings },
        sceneBindings: { ...sceneBindings },
        mapBindings: { ...mapBindings },
        tableBindings: { ...tableBindings },
        enumBindings: { ...enumBindings },
        plotPanelSettings: { ...plotPanelSettings },
        createdAt: Date.now(),
      };
      set({
        namedLayouts: [...namedLayouts, entry],
        activeNamedLayoutId: id,
      });
      return id;
    },

    restoreNamedLayout(id) {
      const entry = get().namedLayouts.find((l) => l.id === id);
      if (!entry) return;
      // Single `set` so the persist adapter writes one snapshot and the
      // FlexLayout external-rebuild effect sees `layoutJson` alongside
      // the active-id update — no race with `setLayoutJson`'s clear.
      set({
        layoutJson: entry.layoutJson,
        videoBindings: { ...entry.videoBindings },
        plotBindings: { ...entry.plotBindings },
        sceneBindings: { ...entry.sceneBindings },
        mapBindings: { ...entry.mapBindings },
        tableBindings: { ...entry.tableBindings },
        enumBindings: { ...entry.enumBindings },
        plotPanelSettings: { ...(entry.plotPanelSettings ?? {}) },
        activeNamedLayoutId: id,
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

    addBookmarkAtCursor(label) {
      const { globalRange, cursorNs } = get();
      if (!globalRange) return null;
      const id = mintId("bm");
      const finalLabel =
        label !== undefined && label.trim().length > 0
          ? label.trim()
          : `bookmark @ ${formatRelative(cursorNs, globalRange.startNs)}`;
      const entry: Bookmark = {
        id,
        ns: cursorNs,
        label: finalLabel,
        color: colorFor(id),
        createdAt: Date.now(),
      };
      set({ bookmarks: [...get().bookmarks, entry] });
      return id;
    },

    addBookmark(ns, label) {
      const id = mintId("bm");
      const finalLabel =
        label !== undefined && label.trim().length > 0
          ? label.trim()
          : `bookmark @ ${formatRelative(ns, 0n)}`;
      const entry: Bookmark = {
        id,
        ns,
        label: finalLabel,
        color: colorFor(id),
        createdAt: Date.now(),
      };
      set({ bookmarks: [...get().bookmarks, entry] });
      return id;
    },

    removeBookmark(id) {
      const prev = get().bookmarks;
      const next = prev.filter((b) => b.id !== id);
      if (next.length === prev.length) return;
      set({ bookmarks: next });
    },

    dismissOpenErrors() {
      if (get().lastOpenErrors.length === 0) return;
      set({ lastOpenErrors: [] });
    },

    renameBookmark(id, label) {
      const trimmed = label.trim();
      if (trimmed.length === 0) return;
      const prev = get().bookmarks;
      let changed = false;
      const next = prev.map((b) => {
        if (b.id !== id) return b;
        if (b.label === trimmed) return b;
        changed = true;
        return { ...b, label: trimmed };
      });
      if (!changed) return;
      set({ bookmarks: next });
    },

    async fetchChannelRange(channelId, startNs, endNs, includePrev) {
      if (!worker) throw new Error("session store: worker not initialised");
      const { channels, sources } = get();
      const channel = channels.find((c) => c.id === channelId);
      if (!channel) throw new Error(`unknown channel: ${channelId}`);
      const source = sources.find((s) => s.id === channel.sourceId);
      if (!source) throw new Error(`unknown source for channel: ${channelId}`);
      const perfStart = `fetch-range:${channelId}:start`;
      const perfEnd = `fetch-range:${channelId}:end`;
      mark(perfStart);
      try {
        if (source.kind === "mcap") {
          return await worker.mcapFetchRange(
            source.handle,
            channel.nativeId,
            startNs,
            endNs,
            includePrev,
          );
        }
        if (source.kind === "mf4") {
          return await worker.mf4FetchRange(
            source.handle,
            channel.nativeId,
            startNs,
            endNs,
            includePrev,
          );
        }
        throw new Error(`channel kind not plottable: ${source.kind}`);
      } finally {
        mark(perfEnd);
        measure(`fetch-range:${channelId}`, perfStart, perfEnd);
      }
    },

    async openFiles(files) {
      const run = (): Promise<OpenResult> => timed("open", async () => {
        if (!worker) throw new Error("session store: worker not initialised");
        const w = worker;
        // Empty state and per-panel surfaces read `ingesting` to render
        // a "Decoding… / Indexing…" affordance — without it a multi-MB
        // drop looks like a silent UI. Flipped back in the `finally`
        // below so worker errors still clear the flag.
        set({ ingesting: true });

        const buckets = bucketFiles(files);
        const opened: string[] = [];
        const errors: BucketError[] = [...buckets.errors];
        const newSources: SourceMeta[] = [];
        const existing = get().sources;

        for (const f of buckets.mcap) {
          try {
            const bytes = await fileBytes(f);
            const handle = await w.openMcap(bytes);
            const summary = await w.mcapSummary(handle);
            const id = uniqueSourceId(f.name, [...existing, ...newSources]);
            const channels = mcapChannels(id, summary);
            newSources.push({
              id,
              kind: "mcap",
              name: f.name,
              handle,
              timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
              channels,
            });
            opened.push(f.name);
          } catch (e) {
            errors.push({ name: f.name, reason: String(e) });
          }
        }

        for (const f of buckets.mf4) {
          try {
            const bytes = await fileBytes(f);
            const handle = await w.openMf4(bytes);
            const summary = await w.mf4Summary(handle);
            const id = uniqueSourceId(f.name, [...existing, ...newSources]);
            const channels = mf4Channels(id, summary);
            newSources.push({
              id,
              kind: "mf4",
              name: f.name,
              handle,
              timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
              channels,
            });
            opened.push(f.name);
          } catch (e) {
            errors.push({ name: f.name, reason: String(e) });
          }
        }

        for (const pair of buckets.mp4Pairs) {
          try {
            // Only `ftyp` + `moov` are needed by the WASM parser;
            // `mdat` (the encoded video, often multi-GB) is never
            // dereferenced during `open_pair`. Reading the whole mp4
            // here would allocate a contiguous Uint8Array on the main
            // thread and OOM long recordings before the lazy sample
            // cache can take over. `readMp4HeaderBytes` walks the box
            // structure via `File.slice()` and returns just the header.
            let mp4HeaderBytes: Uint8Array | null = await readMp4HeaderBytes(
              pair.mp4,
            );
            let tsBytes: Uint8Array | null = await fileBytes(pair.ts);
            const handle = await w.openMp4Sidecar(mp4HeaderBytes, tsBytes);
            const summary = await w.mp4SidecarSummary(handle);
            const index: Mp4SidecarIndex = await w.mp4SidecarIndex(handle);
            // Drop ingest buffers as soon as WASM has the index — peak
            // memory falls back to steady state.
            mp4HeaderBytes = null;
            tsBytes = null;
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
            });
            opened.push(pair.mp4.name);
          } catch (e) {
            errors.push({ name: pair.mp4.name, reason: String(e) });
          }
        }

        if (newSources.length > 0) {
          const allSources = [...get().sources, ...newSources];
          const allChannels = allSources.flatMap((s) => s.channels);
          const newRange = mergeGlobalRange(allSources);
          const prevCursor = get().cursorNs;
          // Keep the cursor inside `globalRange`. First successful drop:
          // `cursorNs` is still the 0n default. Later drops: leave it
          // alone unless it now falls outside the widened union range.
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

        return { opened, errors };
      });

      const next = pending.then(run, run);
      // Catch keeps the chain alive on `run` failure so the next caller
      // queues behind it instead of racing. `finally` clears
      // `ingesting` for success+failure so a worker error can't strand
      // the empty state on the loading affordance.
      pending = next.catch(() => undefined).finally(() => {
        set({ ingesting: false });
      });
      return next;
    },

    async clear() {
      const run = async () => {
        if (!worker) return;
        const w = worker;
        for (const s of get().sources) {
          try {
            if (s.kind === "mcap") await w.closeMcap(s.handle);
            else if (s.kind === "mf4") await w.closeMf4(s.handle);
            else await w.closeMp4Sidecar(s.handle);
            s.mp4Cache?.dispose();
          } catch (err) {
            // Always continue tearing down — the slab entry either
            // stays for the worker's lifetime or was already freed.
            // Log so worker panics / dropped postMessage replies are
            // surfaced rather than silent.
            console.warn(
              `[session.clear] close failed for ${s.kind}#${s.handle}`,
              err,
            );
          }
        }
        // Wipe session + transport + per-panel bindings, but keep
        // `layoutJson`, `namedLayouts`, and `bookmarks` so dock layout,
        // saved layouts, and bookmarks survive a clear — see
        // docs/06-ui-and-panels.md:167.
        set({
          sources: [],
          channels: [],
          globalRange: null,
          cursorNs: 0n,
          playing: false,
          speed: 1,
          seekEpoch: 0,
          videoBindings: {},
          plotBindings: {},
          plotPanelSettings: {},
          videoHudOn: {},
          sceneBindings: {},
          mapBindings: {},
          tableBindings: {},
          enumBindings: {},
          lastOpenErrors: [],
          loadedRanges: {},
          pendingFetch: {},
        });
      };
      const next = pending.then(run, run);
      pending = next.catch(() => undefined);
      await next;
    },
  };
});
