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

import type { Remote } from "comlink";
import { create } from "zustand";
import {
  bucketFiles,
  classifyUrl,
  type BucketError,
  type TabularFormat,
} from "./bucket";
import {
  draftFromSchema,
  draftToBasis,
  basisToJson,
  type BasisDraft,
  type RawTabularSchema,
} from "./tabularImport";
import { MAX_PLOT_SERIES } from "../panels/palette";
import {
  loadLayoutFromStorage,
  type MapBinding,
} from "../layout/persist";
import {
  loadUiFromStorage,
  clampDrawerWidth,
  DRAWER_WIDTH_DEFAULT,
  type RailTab,
} from "./persist/ui";
import {
  loadNamedLayoutsFromStorage,
  type NamedLayout,
} from "./persist/namedLayouts";
import {
  loadBookmarksFromStorage,
  type Bookmark,
} from "./persist/bookmarks";
import {
  loadEventTagConfigFromStorage,
  DEFAULT_EVENT_TAG_CONFIG,
  type EventTagConfig,
  type TagAttribute,
  type TagAttributeType,
} from "./persist/eventTagConfig";
import { colorFor } from "../panels/palette";
import { formatRelative, type TimeMode } from "../timeline/formatTime";
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
import { synthesizeSidecarBytes } from "./videoTimestampBinding";
import { shiftFetchWindow, shiftRangeArrowTs } from "./offsetShift";
import { parseEpochOffsetNs } from "./tabularImport";

export type SourceKind = "mcap" | "mf4" | "mp4+sidecar" | "tabular" | "lidar";
export type ChannelKind = ChannelKindWire;

export interface TimeRange {
  startNs: bigint;
  endNs: bigint;
}

export interface Channel {
  // Globally unique across the loaded session. Composed via
  // `qualifiedChannelId(sourceId, nativeId)` so two files that expose
  // the same wasm-internal channel id — common with MF4, where the
  // native id is just `{group}/{channel}` — do not collide in the
  // binding maps or the PlotPanel's `channelMap` lookup table.
  // The session-level uniqueness invariant relies on `uniqueSourceId`
  // (defined below in this file) keeping every loaded source's id distinct, which
  // pairs with the length-prefix encoding in `qualifiedChannelId` to
  // make `(sourceId, nativeId)` an injective key.
  id: string;
  // Per-source channel id as emitted by the wasm reader (`0/1` for MF4,
  // the topic string for MCAP, `1/video` for MP4). This is the value
  // the worker fetch APIs expect; it is *not* unique across sources.
  nativeId: string;
  sourceId: string;
  name: string;
  // Optional parent group used to build the Channels tree. For MF4 this is
  // the channel-group label; MCAP/MP4 leave it unset because their tree
  // hierarchy comes from splitting the `name` (topic) on `/`.
  group?: string | null;
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
  /**
   * Per-source time offset in nanoseconds (Feature 2). Applied ONLY at the
   * `fetchChannelRange` boundary for SIGNAL sources (tabular/mcap/mf4): the
   * reader is queried with `[start - O, end - O]` and the offset `O` is added
   * back to every returned sample timestamp before it reaches a panel. A
   * cheap `bigint` add — never on the cursor/video hot path.
   *
   * Video (`mp4+sidecar`) sources omit this: their alignment is baked into
   * the derived/sidecar timestamps and the decode hot path must stay
   * offset-free. Optional — an absent value is read as `0n` (the
   * `fetchChannelRange` boundary and the offset editor both default it), so
   * source literals that predate the field still type-check.
   */
  timeOffsetNs?: bigint;
}

export interface OpenResult {
  opened: string[];
  errors: BucketError[];
}

/**
 * A dropped CSV / Parquet file awaiting a user-chosen time basis. Unlike the
 * other formats, a tabular source can't open until the user confirms how its
 * time column should be read, so `openFiles` inspects the file, stashes the
 * result here, and the import dialog (`TabularImportDialog`) opens the source
 * on confirm. Multiple drops queue FIFO; `id` is a stable key for the dialog
 * list and the dev-hook confirm/cancel targeting.
 */
export interface PendingTabularImport {
  /** Stable queue key (monotonic), distinct from the eventual source id. */
  id: string;
  name: string;
  format: TabularFormat;
  /** Raw file bytes, re-passed to `openTabular` on confirm. */
  bytes: Uint8Array;
  /** Inspected schema: column list + suggested basis (drives the dialog). */
  schema: RawTabularSchema;
  /** The editable default basis derived from `schema.suggested`. */
  suggested: BasisDraft;
}

/**
 * A dropped `.mp4` with NO `.mp4.timestamps` sidecar in the batch (Feature 1 —
 * the Alpamayo camera case). It can't open until the user picks a tabular
 * source whose converted time column supplies the per-frame timestamps, so
 * `openFiles` reads its header bytes and queues this; `VideoTimestampDialog`
 * resolves it on confirm by synthesizing a sidecar and reusing the tested
 * `openMp4Sidecar` path. Queues FIFO behind any tabular imports so the
 * dropdown of candidate sources is already populated.
 */
export interface PendingVideoBinding {
  /** Stable queue key (monotonic), distinct from the eventual source id. */
  id: string;
  name: string;
  /** The dropped mp4 `File` — re-read into the `Mp4SampleCache` on confirm. */
  file: File;
  /** `[ftyp][moov]` header bytes, sliced at drop time and handed to wasm. */
  headerBytes: Uint8Array;
}

/**
 * Per-series transform (P7 · derived channels). Imported from the panel
 * layer so the store can persist the choice; the maths lives in
 * `panels/transforms.ts`.
 */
export type PlotTransform =
  | { kind: "none" }
  | { kind: "abs" }
  | { kind: "derivative" }
  | { kind: "scale"; mul: number; add: number };

/**
 * The most y-axes a single plot panel can split its series across. Axis
 * indices are 0-based and clamped to `[0, MAX_PLOT_Y_AXES - 1]`; index 0
 * is the canonical left scale `"y"` (the e2e plot-sync specs read it), the
 * rest render on the right.
 */
export const MAX_PLOT_Y_AXES = 4;

/**
 * Per-plot-panel display settings. The shape is an object so future
 * settings (axis pinning, log/linear, smoothing) can land without
 * bumping the persistence schema.
 *
 * `gapThresholdSec === null` preserves the spanGaps:true behavior PR
 * #83 shipped — alignment artifacts span and any real channel-loss
 * gap renders as a horizontal hold. Setting a positive number switches
 * the panel to step-hold mode with explicit gaps for any inter-sample
 * dx exceeding the threshold; see `mergeSeries` for the rendering
 * contract.
 *
 * `axisAssignments` maps a bound channel id → the 0-based y-axis it should
 * render on. Units no longer drive y-axis grouping; the user assigns axes
 * explicitly here. Absent / out-of-range entries default to axis 0, so a
 * panel that never touches the setting keeps every series on one shared
 * scale.
 *
 * `stackAxes` (default `false`) stacks the per-axis scales into vertical
 * bands instead of overlaying them across the full plot height: each
 * y-axis in use is remapped so its samples occupy their own horizontal
 * lane (lowest axis index on top), so signals on different axes can be
 * read at once without overlapping. Only takes effect when ≥2 axes carry
 * data; the per-band maths lives in `PlotPanel.stackedBandRange`.
 *
 * `axisAssignments`, `transforms`, `stackAxes`, and `syncTimeAxis` are
 * OPTIONAL (additive — payloads written before they existed omit them).
 * Readers default via `DEFAULT_PLOT_PANEL_SETTINGS`; the persistence
 * validators tolerate the extra keys, so they round-trip without a schema
 * bump.
 */
export interface PlotPanelSettings {
  gapThresholdSec: number | null;
  // Keyed by channel id → 0-based y-axis index. Absent ⇒ axis 0.
  axisAssignments?: Record<string, number>;
  // Keyed by channel id. Absent / `{ kind: "none" }` means pass-through.
  transforms?: Record<string, PlotTransform>;
  // Stack the in-use y-axes into vertical bands. Absent ⇒ `false` (overlay).
  stackAxes?: boolean;
  // Sync this plot's time (x) axis with every other synced plot: zooming
  // the timeline on one moves them all to the same window (the y-axes stay
  // per-panel). Absent ⇒ `true` (synced by default, restoring the
  // "time axis is always shared" invariant under zoom); stored as `false`
  // only when the user turns it off, so an untouched panel stays minimal.
  syncTimeAxis?: boolean;
}

export const DEFAULT_PLOT_PANEL_SETTINGS: PlotPanelSettings = {
  gapThresholdSec: null,
  axisAssignments: {},
  transforms: {},
  stackAxes: false,
  syncTimeAxis: true,
};

/**
 * Per-plot-panel wheel-zoom state (mouse-wheel scale on the x/y axes).
 *
 * `x` is the visible time window in nanoseconds (a `TimeRange`, mirroring
 * every other time value in the store) or `null` to fit the full
 * `globalRange`. `y` maps a 0-based y-axis index → its visible data-value
 * window; an absent entry means that axis auto-fits its data.
 *
 * This slice is EPHEMERAL — purely a view transform over the same data, so
 * it is not persisted (the layout adapter and named-layout snapshots skip
 * it) and `clear()` resets it. A panel with no override is dropped from the
 * map entirely, so `panelId in plotZoom` is the same as "is zoomed".
 */
export interface PlotAxisWindow {
  min: number;
  max: number;
}
export interface PlotZoom {
  x: TimeRange | null;
  y: Record<number, PlotAxisWindow>;
}

export interface SessionState {
  sources: SourceMeta[];
  channels: Channel[];
  globalRange: TimeRange | null;
  // Transport slice (T3.1). Consumed by the scrubber (T3.2) and the rAF
  // playback loop (T3.3); the invariants — clamp to `globalRange`, bounded
  // speed, stop at end-of-session — are enforced by the actions below so
  // that UI code cannot violate them.
  cursorNs: bigint;
  playing: boolean;
  speed: number;
  // Relative/absolute time display toggle, shared across the Transport
  // readout and every PlotPanel x-axis so the two never disagree on how a
  // timestamp reads. Per-session (not persisted) — mirrors the prior
  // Transport-local default of "relative" on each fresh load.
  timeMode: TimeMode;
  // Monotonic counter bumped on every user-initiated cursor change
  // (`setCursor`, plus `play()` rewinds and end-of-session jumps).
  // Playback rAF advances via `advanceCursor` and do **not** bump it.
  // Consumers that need to react to scrubs — primarily the videoDecode
  // pipeline, which has to tear down the decoder and reopen at the
  // seek target — subscribe to this rather than to `cursorNs` so a
  // 60 Hz playback tick does not look like a seek.
  seekEpoch: number;
  // P3 · shared cross-panel hover crosshair. Distinct from `cursorNs`
  // (which drives playback + video seeks): hovering a plot publishes the
  // pointed-at timestamp here so EVERY plot panel can draw a secondary
  // dashed crosshair at the same instant (the Grafana shared-crosshair
  // pattern) without moving the playback cursor or issuing a seek. `null`
  // when no plot is being hovered. Not persisted — purely ephemeral UI.
  hoverNs: bigint | null;
  // Layout + bindings slice (T6.2). `layoutJson` is the opaque FlexLayout
  // model (`Model.toJson()` output); the binding maps are keyed by the
  // FlexLayout tab id so a closed-and-reopened panel can reclaim its
  // configuration on reload.
  layoutJson: unknown | null;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  // Per-plot-panel display settings (Phase 8). Decoupled from
  // `plotBindings` because settings outlive the binding set —
  // a user who changes their bound channels shouldn't lose their
  // gap-threshold choice. Round-trips through the layout adapter and
  // named-layout snapshots so reload restores it.
  plotPanelSettings: Record<string, PlotPanelSettings>;
  // Per-plot-panel wheel-zoom windows (x/y scale overrides). Ephemeral:
  // not persisted and reset by `clear()`. Absent key ⇒ that panel fits the
  // full range (no zoom). See `PlotZoom`.
  plotZoom: Record<string, PlotZoom>;
  // The shared time (x) window that every plot with `syncTimeAxis` on
  // displays — the rendezvous point that keeps synced timelines locked
  // together without enumerating sibling panels. `null` ⇒ synced plots fit
  // the full `globalRange`. Ephemeral, like `plotZoom`: not persisted and
  // reset by `clear()`. Read via the `effectivePlotZoomX` selector, never
  // directly by panels (it only applies when a panel is synced).
  sharedPlotZoomX: TimeRange | null;
  // Global per-channel unit overrides, keyed by channel id. A signal's
  // unit is inferred from the file on load but is often missing or wrong,
  // so the user can override it; the override applies everywhere that
  // channel is shown. An empty string means "explicitly no unit"; an
  // absent entry falls back to `channel.unit`. See `state/units.ts`.
  unitOverrides: Record<string, string>;
  // Per-video-panel HUD overlay bit (Phase 5). Lifted out of
  // `VideoPanel` local state so the Panel drawer can flip it from outside
  // the panel. Persisted via the layout adapter (schema v2). Default
  // `false` for any panelId not present in the map.
  videoHudOn: Record<string, boolean>;
  // Phase 6 · per-panel bindings for the four new panel kinds. Each
  // round-trips through layout persistence (v3) so a reload restores the
  // full panel set. `clear()` resets all four maps.
  sceneBindings: Record<string, string | null>;
  mapBindings: Record<string, MapBinding | null>;
  tableBindings: Record<string, string[]>;
  // Per-Value-panel bindings. The Value panel is the compact
  // sample-at-cursor reader (one value per bound channel); it mirrors
  // `tableBindings`' shape but is keyed by `value-*` panel ids so the two
  // panel kinds never share a binding list.
  valueBindings: Record<string, string[]>;
  // Per-Enum-panel bindings. Mirrors `tableBindings`/`valueBindings`'
  // multi-channel shape (keyed by `enum-*` panel ids): an enum panel
  // stacks one state strip ("lane") per bound channel rather than filling
  // itself with a single signal. Capped at `MAX_PLOT_SERIES`.
  enumBindings: Record<string, string[]>;
  // UI shell slice (Phase 1). `activeRailTab` and `railCollapsed` persist
  // to `driveline.ui.v1`; `selectedPanelId` is per-session and is wired by
  // panel-chrome work in Phase 7.
  activeRailTab: RailTab | null;
  railCollapsed: boolean;
  // Width (px) of the left settings drawer. Persisted to `driveline.ui.v1`
  // and clamped to [DRAWER_WIDTH_MIN, DRAWER_WIDTH_MAX] on every write. The
  // splitter in `Drawer.tsx` drives this.
  drawerWidth: number;
  selectedPanelId: string | null;
  // Named-layouts slice (Phase 4). User-saved snapshots of `layoutJson`
  // plus the binding maps; persists to `driveline.layouts.named.v1` and
  // outlives a session (untouched by `clear()`). `activeNamedLayoutId`
  // tracks the orange-bordered "active" row in the Layout drawer; the
  // drawer also computes a separate `live` pill from a stringified
  // layoutJson compare.
  namedLayouts: NamedLayout[];
  activeNamedLayoutId: string | null;
  // Bookmarks (event-tag) slice (Phase 8). User-placed events; persists
  // to `driveline.bookmarks.v2` and outlives a session — `clear()` does
  // not reset, mirroring `namedLayouts`. `ns` is `bigint`; the persist
  // adapter encodes it (and the optional `beforeNs`/`afterNs` range
  // durations) as decimal strings. `tags` holds the per-event attribute
  // values keyed by `eventTagConfig` attribute ids. Display-time sorting
  // happens in the drawer/marker components — storage and slice
  // preserve insertion order so renames target a stable index.
  bookmarks: Bookmark[];
  // Event Tag config (Phase 8). The attribute schema (weather, road
  // type, …) used to tag events. Editable in-app + importable JSON;
  // persists to `driveline.eventTags.config.v1` and outlives a session.
  eventTagConfig: EventTagConfig;
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
   * FIFO queue of dropped CSV / Parquet files awaiting a time basis. The
   * `TabularImportDialog` renders the head of this queue; confirming/cancelling
   * shifts it. Empty when there's nothing to configure. Reset by `clear()`.
   */
  pendingTabularImports: PendingTabularImport[];
  /**
   * FIFO queue of dropped sidecar-less `.mp4` files awaiting a timestamp
   * source (Feature 1). The `VideoTimestampDialog` renders the head; confirming
   * (with a chosen tabular source) or cancelling shifts it. Empty when there's
   * nothing to bind. Reset by `clear()`. Ordered AFTER tabular imports in the
   * drop flow so the dialog's source dropdown is populated.
   */
  pendingVideoBindings: PendingVideoBinding[];
  /** Drives a drop batch through bucket → per-source open → merge. CSV/Parquet
   *  files are inspected and queued into `pendingTabularImports` instead of
   *  opening eagerly (they need a time basis first). */
  openFiles(files: File[]): Promise<OpenResult>;
  /**
   * Confirm a queued tabular import: open the source with `basis`, register it
   * exactly like an MF4 source, and dequeue it. No-op on an unknown id (a
   * stale confirm). Resolves when the source is registered (or the open
   * failed, in which case the failure surfaces via `lastOpenErrors`).
   */
  confirmTabularImport(id: string, basis: BasisDraft): Promise<void>;
  /** Cancel (drop) a queued tabular import by id. No-op on an unknown id. */
  cancelTabularImport(id: string): void;
  /**
   * Confirm a queued sidecar-less mp4 binding (Feature 1): fetch the chosen
   * tabular source's converted ns time column, synthesize a `.mp4.timestamps`
   * sidecar from it (row i → frame i), open the mp4 via the EXISTING
   * `openMp4Sidecar` path, wrap it in an `Mp4SampleCache`, register the source,
   * and dequeue. The mp4 reader validates that the sidecar line count equals
   * the sample count, so a mismatched source surfaces as a clear error via
   * `lastOpenErrors` and the binding stays queued for a retry. No-op on an
   * unknown `id` or `tabularSourceId`.
   */
  confirmVideoBinding(id: string, tabularSourceId: string): Promise<void>;
  /** Cancel (drop) a queued sidecar-less mp4 binding by id. No-op on unknown id. */
  cancelVideoBinding(id: string): void;
  /**
   * Set a SIGNAL source's per-source time offset in nanoseconds (Feature 2),
   * applied at the `fetchChannelRange` boundary. Accepts the offset as a
   * decimal STRING so a full-precision ns value survives without a lossy
   * `Number`; an unparseable string or an unknown / non-signal source id is a
   * no-op. Video (`mp4+sidecar`) sources reject the offset (their decode path
   * stays offset-free).
   */
  setSourceOffset(sourceId: string, offsetNs: string): void;
  /**
   * Open a single `.mcap`/`.mf4` from a URL. MCAP fetches the full body;
   * MF4 reads lazily over HTTP range requests through its index, so a large
   * remote MF4 is never fully downloaded. Shares the same `pending` serialise
   * chain and source-merge path as `openFiles`. Errors (bad URL, unsupported
   * type, network/CORS, no range support) surface via the returned
   * `OpenResult` and `lastOpenErrors`.
   */
  openUrl(url: string): Promise<OpenResult>;
  /** Clear `lastOpenErrors` (used by the Sources drawer dismiss). */
  dismissOpenErrors(): void;
  /** Close every loaded wasm handle and reset to the empty session. */
  clear(): Promise<void>;
  /**
   * Close a single source: free its wasm handle (and lazy sample cache),
   * drop its channels, recompute `globalRange`, clamp the cursor into the
   * shrunken range, and prune every panel binding that pointed at one of
   * the now-gone channels. No-op on an unknown id. Serialised behind the
   * same `pending` chain as `openFiles`/`clear` so a close can't interleave
   * with an in-flight open.
   */
  removeSource(sourceId: string): Promise<void>;
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
  /** Switch the relative/absolute time display mode (Transport + plots). */
  setTimeMode(mode: TimeMode): void;
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
  /**
   * Assign a bound channel to a 0-based y-axis within a plot panel. The
   * index is clamped to `[0, MAX_PLOT_Y_AXES - 1]`; axis 0 is the shared
   * default, so assigning a channel to 0 clears its entry. Persists through
   * the layout adapter like the other plot settings.
   */
  setPlotChannelAxis(panelId: string, channelId: string, axis: number): void;
  /**
   * Toggle stacking of a plot panel's in-use y-axes into vertical bands.
   * `false` (the default) is stored as a deletion so an untouched panel
   * keeps a minimal settings payload. Persists through the layout adapter
   * like the other plot settings; only has a visible effect with ≥2 axes.
   */
  setPlotStackAxes(panelId: string, on: boolean): void;
  /**
   * Toggle whether a plot panel's time (x) axis follows the shared zoom
   * window (`syncTimeAxis`, default `true`). Turning it OFF copies the
   * current shared window into the panel's own x-zoom so its view doesn't
   * jump; turning it ON drops the panel's own x-window so it re-adopts the
   * shared one. `true` (the default) is stored as a deletion to keep an
   * untouched panel minimal. Persists through the layout adapter.
   */
  setPlotSyncTimeAxis(panelId: string, on: boolean): void;
  /**
   * Set (or clear, with `null`) a plot panel's visible x-window (the
   * wheel-zoom time scale). Pruned to "no zoom" when both x and y are
   * cleared. Ephemeral — never persisted.
   */
  setPlotZoomX(panelId: string, window: TimeRange | null): void;
  /**
   * Set (or clear, with `null`) a plot panel's visible window for one
   * 0-based y-axis (the wheel-zoom value scale). Pruned to "no zoom" when
   * the last override is cleared. Ephemeral — never persisted.
   */
  setPlotZoomY(
    panelId: string,
    axisIdx: number,
    window: PlotAxisWindow | null,
  ): void;
  /** Clear every wheel-zoom override for a plot panel (back to auto-fit). */
  resetPlotZoom(panelId: string): void;
  /**
   * Set (or clear, with `null`) the shared time (x) window that every
   * `syncTimeAxis` plot displays. Ephemeral — never persisted.
   */
  setSharedPlotZoomX(window: TimeRange | null): void;
  /**
   * Apply a time (x) window from a panel, routed by its sync mode: a synced
   * panel writes the shared window (moving every synced plot); an unsynced
   * panel writes its own `plotZoom[panelId].x`. The single entry point for
   * the wheel handler and the drawer's ± buttons.
   */
  applyPlotZoomX(panelId: string, window: TimeRange | null): void;
  /**
   * Reset a plot panel's zoom from the UI: clears its own x/y overrides and,
   * when the panel is synced, also clears the shared time window (so every
   * synced plot returns to the full range together). The "Reset zoom"
   * action behind the in-plot button and the drawer twin.
   */
  clearPlotZoom(panelId: string): void;
  /**
   * Override a channel's unit globally (keyed by channel id). Pass a string
   * to set the override (`""` means "explicitly no unit"); pass `null` to
   * clear it and fall back to the file-inferred unit. Persists through the
   * layout adapter.
   */
  setChannelUnit(channelId: string, unit: string | null): void;
  /**
   * Set (or clear) a per-series transform (P7 · derived channels). A
   * `{ kind: "none" }` transform is stored as a deletion so a default
   * panel keeps an empty `transforms` map. Persists through the layout
   * adapter.
   */
  setPlotChannelTransform(
    panelId: string,
    channelId: string,
    transform: PlotTransform,
  ): void;
  /**
   * P3 · publish the shared hover timestamp (or `null` to clear). Called
   * from a plot's rAF-coalesced hover handler — not the cursor hot path,
   * and never triggers a seek.
   */
  setHoverNs(ns: bigint | null): void;
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
  /** Replace a value panel's bound channels wholesale (capped, deduped). */
  setValueBinding(panelId: string, ids: string[]): void;
  /** Append one channel to a value panel (no-op if present or at cap). */
  addValueChannel(panelId: string, channelId: string): void;
  /** Remove one channel from a value panel (no-op if absent). */
  removeValueChannel(panelId: string, channelId: string): void;
  /** Replace an enum panel's bound channels wholesale (capped, deduped). */
  setEnumBinding(panelId: string, ids: string[]): void;
  /** Append one channel to an enum panel (no-op if present or at cap). */
  addEnumChannel(panelId: string, channelId: string): void;
  /** Remove one channel from an enum panel (no-op if absent). */
  removeEnumChannel(panelId: string, channelId: string): void;
  /** Switch the rail's open drawer; pass `null` to close. */
  setActiveRailTab(tab: RailTab | null): void;
  /** Hide / show the entire rail column. */
  setRailCollapsed(collapsed: boolean): void;
  /** Resize the left settings drawer; the value is clamped to the
   *  drawer-width bounds before it lands in the store. */
  setDrawerWidth(px: number): void;
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
   * Set an event's optional before/after range durations (nanoseconds).
   * Both are clamped to `>= 0`; `0/0` is a point event. No-op on an
   * unknown id or when neither value changes.
   */
  setBookmarkRange(id: string, beforeNs: bigint, afterNs: bigint): void;
  /**
   * Set (or, when `value` trims to empty, clear) one tag attribute value
   * on an event. No-op on an unknown id or when the value is unchanged.
   */
  setBookmarkTag(id: string, attributeId: string, value: string): void;
  /**
   * Replace the whole Event Tag config. Tag values on existing events
   * whose attribute id no longer exists are pruned in the same update.
   */
  setEventTagConfig(config: EventTagConfig): void;
  /**
   * Append a new tag attribute (id minted from `name`). Returns the id.
   */
  addTagAttribute(name: string, type: TagAttributeType): string;
  /**
   * Remove a tag attribute and prune its values from every event.
   * No-op on an unknown id.
   */
  removeTagAttribute(attributeId: string): void;
  /**
   * Patch a tag attribute's display name / type / options in place.
   * No-op on an unknown id.
   */
  updateTagAttribute(
    attributeId: string,
    patch: Partial<Pick<TagAttribute, "name" | "type" | "options">>,
  ): void;
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
  /**
   * Ascending spin start timestamps (ns) for a point-cloud channel — one per
   * frame. The 3D scene panel binary-searches this locally to map the cursor
   * to a spin index, so it only refetches geometry when the active spin
   * changes (not once per cursor tick). Throws for non-lidar channels.
   */
  lidarSpinTimes(channelId: string): Promise<BigInt64Array>;
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

// Drop tag values whose attribute id no longer exists in `config` from
// every event. Shared by `setEventTagConfig` and `removeTagAttribute`;
// preserves array/object references when nothing changes so the persist
// subscriber and React selectors don't churn.
function pruneOrphanTags(
  get: () => SessionState,
  set: (partial: Partial<SessionState>) => void,
  config: EventTagConfig,
): void {
  const valid = new Set(config.attributes.map((a) => a.id));
  const prev = get().bookmarks;
  let changed = false;
  const next = prev.map((b) => {
    const drop = Object.keys(b.tags).filter((k) => !valid.has(k));
    if (drop.length === 0) return b;
    const tags = { ...b.tags };
    for (const k of drop) delete tags[k];
    changed = true;
    return { ...b, tags };
  });
  if (!changed) return;
  set({ bookmarks: next });
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
    group: null,
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
    group: c.group,
    kind: "scalar" as const,
    dtype: "f64",
    unit: c.unit,
    sampleCount: c.sample_count,
    timeRange: { startNs: c.start_ns, endNs: c.end_ns },
  }));
}
// Tabular (CSV / Parquet) summaries arrive in the MF4 shape — one scalar F64
// channel per surfaced numeric column — so the channel mapping mirrors
// `mf4Channels`. Building these the same way is what makes a tabular source
// indistinguishable to the panels (Plot/Table/Map/Value/Enum all consume the
// flat `channels` list and the ranged `fetchChannelRange` path).
function tabularChannels(sourceId: string, s: Mf4Summary): Channel[] {
  return s.channels.map((c) => ({
    id: qualifiedChannelId(sourceId, c.id),
    nativeId: c.id,
    sourceId,
    name: c.name,
    group: c.group,
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
    group: null,
    kind: "video" as const,
    dtype: null,
    unit: null,
    sampleCount: c.sample_count,
    timeRange: { startNs: c.start_ns, endNs: c.end_ns },
  }));
}
// Point-cloud (LiDAR) summaries arrive in the MF4 shape — the reader emits a
// single channel — so the mapping mirrors `mf4Channels` but hardcodes the
// `point_cloud` kind so the ScenePanel/PanelDrawer route it to the 3D scene
// pipeline rather than a plot. `sample_count` carries peak points-per-spin.
function lidarChannels(sourceId: string, s: Mf4Summary): Channel[] {
  return s.channels.map((c) => ({
    id: qualifiedChannelId(sourceId, c.id),
    nativeId: c.id,
    sourceId,
    name: c.name,
    group: null,
    kind: "point_cloud" as const,
    dtype: null,
    unit: null,
    sampleCount: c.sample_count,
    timeRange: { startNs: c.start_ns, endNs: c.end_ns },
  }));
}

async function fileBytes(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
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
  m: Record<string, MapBinding | null>,
  gone: Set<string>,
): Record<string, MapBinding | null> {
  let changed = false;
  const out: Record<string, MapBinding | null> = {};
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

export const useSession = create<SessionState>((set, get) => {
  let worker: Remote<DataCoreApi> | null = null;
  // Serialise `openFiles` so two rapid drops don't interleave `set()` calls.
  let pending: Promise<unknown> = Promise.resolve();
  // Monotonic key for queued tabular imports (stable across the drop batch /
  // dialog confirm cycle; never reused so a dialog re-render can't target a
  // recycled slot).
  let tabularImportSeq = 0;
  // Monotonic key for queued sidecar-less mp4 bindings (Feature 1). Never
  // reused so a dialog re-render can't target a recycled slot.
  let videoBindingSeq = 0;
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
    pendingVideoBindings: [],

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
      // Spread only the panel's *actual* prior settings (not the full
      // defaults) so an untouched panel keeps a minimal `{ gapThresholdSec }`
      // payload — axisAssignments / transforms stay absent until the user
      // sets them, and readers default via `?? {}`.
      const existing = prev[panelId];
      // Normalise: any non-finite or non-positive value collapses to
      // null (the "off" state), so the persistence layer doesn't have
      // to defend against -Infinity / NaN coming from a numeric input.
      const normalised: number | null =
        sec !== null && Number.isFinite(sec) && sec > 0 ? sec : null;
      if ((existing?.gapThresholdSec ?? null) === normalised) return;
      set({
        plotPanelSettings: {
          ...prev,
          [panelId]: { ...existing, gapThresholdSec: normalised },
        },
      });
    },

    setPlotChannelAxis(panelId, channelId, axis) {
      const prev = get().plotPanelSettings;
      const existing = prev[panelId];
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
      set({
        plotPanelSettings: {
          ...prev,
          [panelId]: {
            ...existing,
            gapThresholdSec: existing?.gapThresholdSec ?? null,
            axisAssignments: nextAssignments,
          },
        },
      });
    },

    setPlotStackAxes(panelId, on) {
      const prev = get().plotPanelSettings;
      const existing = prev[panelId];
      if ((existing?.stackAxes ?? false) === on) return;
      // Spread the panel's prior settings so axisAssignments / transforms /
      // gapThreshold survive. `false` is stored as a deletion (mirrors the
      // axis / transform "default" posture) so an untouched panel keeps a
      // minimal payload.
      const next: PlotPanelSettings = {
        ...existing,
        gapThresholdSec: existing?.gapThresholdSec ?? null,
      };
      if (on) next.stackAxes = true;
      else delete next.stackAxes;
      set({ plotPanelSettings: { ...prev, [panelId]: next } });
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
      // `true` is the default, so persist it as a deletion (mirrors the
      // stack / axis "default" posture); store `false` explicitly. Read the
      // settings map fresh — `setPlotZoomX` above only touched `plotZoom`.
      const next: PlotPanelSettings = {
        ...existing,
        gapThresholdSec: existing?.gapThresholdSec ?? null,
      };
      if (on) delete next.syncTimeAxis;
      else next.syncTimeAxis = false;
      set({
        plotPanelSettings: { ...get().plotPanelSettings, [panelId]: next },
      });
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
      const prev = get().plotPanelSettings;
      const existing = prev[panelId];
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
      set({
        plotPanelSettings: {
          ...prev,
          [panelId]: {
            ...existing,
            gapThresholdSec: existing?.gapThresholdSec ?? null,
            transforms: nextTransforms,
          },
        },
      });
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

    setValueBinding(panelId, ids) {
      const seen = new Set<string>();
      const next: string[] = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
        if (next.length >= MAX_PLOT_SERIES) break;
      }
      set({ valueBindings: { ...get().valueBindings, [panelId]: next } });
    },

    addValueChannel(panelId, channelId) {
      const prev = get().valueBindings;
      const existing = prev[panelId] ?? [];
      if (existing.includes(channelId)) return;
      if (existing.length >= MAX_PLOT_SERIES) return;
      set({
        valueBindings: { ...prev, [panelId]: [...existing, channelId] },
      });
    },

    removeValueChannel(panelId, channelId) {
      const prev = get().valueBindings;
      const existing = prev[panelId];
      if (!existing || !existing.includes(channelId)) return;
      set({
        valueBindings: {
          ...prev,
          [panelId]: existing.filter((x) => x !== channelId),
        },
      });
    },

    setEnumBinding(panelId, ids) {
      const seen = new Set<string>();
      const next: string[] = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
        if (next.length >= MAX_PLOT_SERIES) break;
      }
      set({ enumBindings: { ...get().enumBindings, [panelId]: next } });
    },

    addEnumChannel(panelId, channelId) {
      const prev = get().enumBindings;
      const existing = prev[panelId] ?? [];
      if (existing.includes(channelId)) return;
      if (existing.length >= MAX_PLOT_SERIES) return;
      set({
        enumBindings: { ...prev, [panelId]: [...existing, channelId] },
      });
    },

    removeEnumChannel(panelId, channelId) {
      const prev = get().enumBindings;
      const existing = prev[panelId];
      if (!existing || !existing.includes(channelId)) return;
      set({
        enumBindings: {
          ...prev,
          [panelId]: existing.filter((x) => x !== channelId),
        },
      });
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
        valueBindings,
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
        valueBindings: { ...valueBindings },
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
      // Single `set` so the persist adapter writes one snapshot and
      // FlexLayout's external-rebuild effect sees the restored JSON
      // alongside the active-id update (no race with the `setLayoutJson`
      // clearing path).
      set({
        layoutJson: entry.layoutJson,
        videoBindings: { ...entry.videoBindings },
        plotBindings: { ...entry.plotBindings },
        sceneBindings: { ...entry.sceneBindings },
        mapBindings: { ...entry.mapBindings },
        tableBindings: { ...entry.tableBindings },
        valueBindings: { ...(entry.valueBindings ?? {}) },
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
        beforeNs: 0n,
        afterNs: 0n,
        label: finalLabel,
        color: colorFor(id),
        createdAt: Date.now(),
        tags: {},
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
        beforeNs: 0n,
        afterNs: 0n,
        label: finalLabel,
        color: colorFor(id),
        createdAt: Date.now(),
        tags: {},
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

    setBookmarkRange(id, beforeNs, afterNs) {
      const before = beforeNs < 0n ? 0n : beforeNs;
      const after = afterNs < 0n ? 0n : afterNs;
      const prev = get().bookmarks;
      let changed = false;
      const next = prev.map((b) => {
        if (b.id !== id) return b;
        if (b.beforeNs === before && b.afterNs === after) return b;
        changed = true;
        return { ...b, beforeNs: before, afterNs: after };
      });
      if (!changed) return;
      set({ bookmarks: next });
    },

    setBookmarkTag(id, attributeId, value) {
      const clear = value.trim().length === 0;
      const prev = get().bookmarks;
      let changed = false;
      const next = prev.map((b) => {
        if (b.id !== id) return b;
        const has = attributeId in b.tags;
        if (clear) {
          if (!has) return b;
          const tags = { ...b.tags };
          delete tags[attributeId];
          changed = true;
          return { ...b, tags };
        }
        if (has && b.tags[attributeId] === value) return b;
        changed = true;
        return { ...b, tags: { ...b.tags, [attributeId]: value } };
      });
      if (!changed) return;
      set({ bookmarks: next });
    },

    setEventTagConfig(config) {
      set({ eventTagConfig: config });
      pruneOrphanTags(get, set, config);
    },

    addTagAttribute(name, type) {
      const id = mintId("attr");
      const trimmed = name.trim();
      const attr: TagAttribute = {
        id,
        name: trimmed.length > 0 ? trimmed : "New attribute",
        type,
        options: [],
      };
      set({
        eventTagConfig: {
          attributes: [...get().eventTagConfig.attributes, attr],
        },
      });
      return id;
    },

    removeTagAttribute(attributeId) {
      const prev = get().eventTagConfig.attributes;
      const next = prev.filter((a) => a.id !== attributeId);
      if (next.length === prev.length) return;
      const config: EventTagConfig = { attributes: next };
      set({ eventTagConfig: config });
      pruneOrphanTags(get, set, config);
    },

    updateTagAttribute(attributeId, patch) {
      const prev = get().eventTagConfig.attributes;
      let changed = false;
      const next = prev.map((a) => {
        if (a.id !== attributeId) return a;
        changed = true;
        return {
          ...a,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.options !== undefined ? { options: patch.options } : {}),
        };
      });
      if (!changed) return;
      set({ eventTagConfig: { attributes: next } });
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
      // Feature 2 — per-source time offset. Query the reader with the window
      // shifted back by the offset, then shift every returned `ts` forward by
      // the same offset so the source lines up with the session timeline. Both
      // are cheap `bigint` ops off the cursor/video hot path; a 0n offset is a
      // pass-through (no window shift, no Arrow re-encode).
      const offset = source.timeOffsetNs ?? 0n;
      const win = shiftFetchWindow(startNs, endNs, offset);
      try {
        if (source.kind === "mcap") {
          const bytes = await worker.mcapFetchRange(
            source.handle,
            channel.nativeId,
            win.startNs,
            win.endNs,
            includePrev,
          );
          return shiftRangeArrowTs(bytes, offset);
        }
        if (source.kind === "mf4") {
          const bytes = await worker.mf4FetchRange(
            source.handle,
            channel.nativeId,
            win.startNs,
            win.endNs,
            includePrev,
          );
          return shiftRangeArrowTs(bytes, offset);
        }
        if (source.kind === "tabular") {
          const bytes = await worker.tabularFetchRange(
            source.handle,
            channel.nativeId,
            win.startNs,
            win.endNs,
            includePrev,
          );
          return shiftRangeArrowTs(bytes, offset);
        }
        if (source.kind === "lidar") {
          // Point-cloud batches carry a List<Float32> geometry schema, not the
          // scalar `{ts,value}` shape `shiftRangeArrowTs` rewrites — and lidar
          // sources never carry a time offset (always 0n), so pass the bytes
          // through unmodified. The window is already un-shifted (offset 0).
          return worker.lidarFetchRange(
            source.handle,
            channel.nativeId,
            win.startNs,
            win.endNs,
            includePrev,
          );
        }
        throw new Error(`channel kind not plottable: ${source.kind}`);
      } finally {
        mark(perfEnd);
        measure(`fetch-range:${channelId}`, perfStart, perfEnd);
      }
    },

    async lidarSpinTimes(channelId) {
      if (!worker) throw new Error("session store: worker not initialised");
      const { channels, sources } = get();
      const channel = channels.find((c) => c.id === channelId);
      if (!channel) throw new Error(`unknown channel: ${channelId}`);
      const source = sources.find((s) => s.id === channel.sourceId);
      if (!source) throw new Error(`unknown source for channel: ${channelId}`);
      if (source.kind !== "lidar") {
        throw new Error(`not a point-cloud channel: ${channelId}`);
      }
      return worker.lidarSpinTimes(source.handle);
    },

    async openFiles(files) {
      const run = (): Promise<OpenResult> => timed("open", async () => {
        if (!worker) throw new Error("session store: worker not initialised");
        const w = worker;

        const buckets = bucketFiles(files);
        const opened: string[] = [];
        const errors: BucketError[] = [...buckets.errors];
        const newSources: SourceMeta[] = [];
        const existing = get().sources;

        for (const f of buckets.mcap) {
          try {
            // Pass the `File` itself, not its bytes: the worker copies it into
            // OPFS (streamed) and reads the summary + chunks lazily via a sync
            // access handle, so a multi-gigabyte MCAP is never held in memory.
            const handle = await w.openMcap(f);
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
              timeOffsetNs: 0n,
            });
            opened.push(f.name);
          } catch (e) {
            errors.push({ name: f.name, reason: String(e) });
          }
        }

        for (const f of buckets.mf4) {
          try {
            // Pass the `File` itself, not its bytes: the worker copies it into
            // OPFS (streamed) and reads channels lazily via a sync access
            // handle, so a multi-gigabyte MF4 is never held in memory. Only
            // plotted signals are decoded and retained.
            const handle = await w.openMf4(f);
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
              timeOffsetNs: 0n,
            });
            opened.push(f.name);
          } catch (e) {
            errors.push({ name: f.name, reason: String(e) });
          }
        }

        for (const f of buckets.lidar) {
          try {
            // Point-cloud Parquet opens eagerly (like a tabular source): the
            // bytes are decoded into per-spin buffers in wasm and the JS copy
            // is dropped once `openLidar` returns. One point-cloud channel per
            // source, bindable to a 3D scene panel.
            const bytes = await fileBytes(f);
            const handle = await w.openLidar(bytes);
            const summary = await w.lidarSummary(handle);
            const id = uniqueSourceId(f.name, [...existing, ...newSources]);
            const channels = lidarChannels(id, summary);
            newSources.push({
              id,
              kind: "lidar",
              name: f.name,
              handle,
              timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
              channels,
              // Point clouds carry no time offset; alignment is in the spin
              // timestamps and the fetch path passes bytes through unshifted.
              timeOffsetNs: 0n,
            });
            opened.push(f.name);
          } catch (e) {
            errors.push({ name: f.name, reason: String(e) });
          }
        }

        for (const pair of buckets.mp4Pairs) {
          try {
            // Only the `ftyp` + `moov` boxes are needed by the WASM
            // parser — `mdat` (the actual encoded video, often
            // multi-GB) is never dereferenced during `open_pair`.
            // Reading the whole mp4 here would allocate a contiguous
            // gigabytes-sized `Uint8Array` on the main thread before
            // the lazy sample cache could take over, OOMing tabs on
            // long recordings. `readMp4HeaderBytes` walks the box
            // structure via `File.slice()` and returns just the
            // header, typically a few MB even for 2 GB sources.
            let mp4HeaderBytes: Uint8Array | null = await readMp4HeaderBytes(
              pair.mp4,
            );
            let tsBytes: Uint8Array | null = await fileBytes(pair.ts);
            const handle = await w.openMp4Sidecar(mp4HeaderBytes, tsBytes);
            const summary = await w.mp4SidecarSummary(handle);
            const index: Mp4SidecarIndex = await w.mp4SidecarIndex(handle);
            // Release transient ingest buffers as soon as WASM has the
            // index — peak memory during open drops back to steady state.
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
        // each one (without retaining the bytes in wasm), then queue a pending
        // import the dialog will turn into a source on confirm. We DON'T add
        // them to `opened` here — they're not loaded yet.
        const newPending: PendingTabularImport[] = [];
        for (const t of buckets.tabular) {
          try {
            const bytes = await fileBytes(t.file);
            const schema = await w.tabularInspect(bytes, t.format);
            newPending.push({
              id: `tab-${tabularImportSeq++}`,
              name: t.file.name,
              format: t.format,
              bytes,
              schema,
              suggested: draftFromSchema(schema),
            });
          } catch (e) {
            errors.push({ name: t.file.name, reason: String(e) });
          }
        }

        commitOpenedSources(newSources, errors);
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
          const handle = await w.openTabular(
            pendingImport.bytes,
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
      set({
        sources: prev.map((s) =>
          s.id === sourceId ? { ...s, timeOffsetNs: parsed } : s,
        ),
      });
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
            errors.push({ name: trimmed, reason: String(e) });
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
        if (!worker) return;
        const w = worker;
        for (const s of get().sources) {
          try {
            if (s.kind === "mcap") await w.closeMcap(s.handle);
            else if (s.kind === "mf4") await w.closeMf4(s.handle);
            else if (s.kind === "tabular") await w.closeTabular(s.handle);
            else if (s.kind === "lidar") await w.closeLidar(s.handle);
            else await w.closeMp4Sidecar(s.handle);
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
          videoBindings: {},
          plotBindings: {},
          plotPanelSettings: {},
          plotZoom: {},
          sharedPlotZoomX: null,
          unitOverrides: {},
          videoHudOn: {},
          sceneBindings: {},
          mapBindings: {},
          tableBindings: {},
          valueBindings: {},
          enumBindings: {},
          lastOpenErrors: [],
          loadedRanges: {},
          pendingFetch: {},
          pendingTabularImports: [],
          pendingVideoBindings: [],
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

        if (worker) {
          const w = worker;
          try {
            if (src.kind === "mcap") await w.closeMcap(src.handle);
            else if (src.kind === "mf4") await w.closeMf4(src.handle);
            else if (src.kind === "tabular") await w.closeTabular(src.handle);
            else if (src.kind === "lidar") await w.closeLidar(src.handle);
            else await w.closeMp4Sidecar(src.handle);
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

        // Re-read in case `openFiles` mutated state while the close awaited.
        const cur = get();
        const goneChannelIds = new Set(
          cur.channels
            .filter((c) => c.sourceId === sourceId)
            .map((c) => c.id),
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
          videoBindings: pruneSingleBindings(
            cur.videoBindings,
            goneChannelIds,
          ),
          plotBindings: pruneMultiBindings(cur.plotBindings, goneChannelIds),
          sceneBindings: pruneSingleBindings(
            cur.sceneBindings,
            goneChannelIds,
          ),
          mapBindings: pruneMapBindings(cur.mapBindings, goneChannelIds),
          tableBindings: pruneMultiBindings(
            cur.tableBindings,
            goneChannelIds,
          ),
          valueBindings: pruneMultiBindings(
            cur.valueBindings,
            goneChannelIds,
          ),
          enumBindings: pruneMultiBindings(cur.enumBindings, goneChannelIds),
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
