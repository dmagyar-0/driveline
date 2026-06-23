// Shared state-layer types and small data constants.
//
// Extracted from `store.ts` (STATE-01 / STATE-06): these are the pure type
// definitions and tiny data constants that the store, its sibling modules
// (`bindings.ts`, `channels.ts`, `ingest/`, `bookmarks.ts`), and many leaf
// modules (`units.ts`, persist shards) all reference. They lived in the
// god-file, which forced leaf modules to `import type … from "./store"` — an
// inverted dependency. Hoisting them here lets every module depend on a leaf
// type module instead of the factory.
//
// `store.ts` re-exports everything here so the public `./store` import path is
// unchanged for external consumers.
//
// CRITICAL (project-wide): all `*Ns` timestamps are `bigint` nanoseconds.
// Never narrow a timestamp to `Number` outside the rendering boundary.

import type { Remote } from "comlink";
import type { BucketError, TabularFormat } from "./bucket";
import type { BasisDraft, RawTabularSchema } from "./tabularImport";
import type { RawRecipeDryRunReport } from "./recipe";
import type { MapBinding, PointCloudOverlayBinding } from "../layout/persist";
import type { CameraCalibration } from "../panels/calibrationFromArrow";
import type { ChannelKindWire, DataCoreApi } from "../workerClient";
import type { BufferedRange, PendingFetch } from "./mp4SampleCache";
import type { Mp4SampleCache } from "./mp4SampleCache";
import type { TimeMode } from "../timeline/formatTime";
import type { RailTab } from "./persist/ui";
import type { NamedLayout } from "./persist/namedLayouts";
import type { Bookmark, BookmarkOrigin } from "./persist/bookmarks";
import type {
  EventTagConfig,
  TagAttribute,
  TagAttributeType,
} from "./persist/eventTagConfig";

export type SourceKind =
  | "mcap"
  | "mf4"
  | "mp4+sidecar"
  | "tabular"
  | "recipe"
  | "lidar"
  | "openlabel"
  | "calibration"
  | "trajectory"
  | "map_geometry"
  | "ros1"
  | "ros2db3"
  // JS-only: agent-pushed columnar data held on the main thread (no Rust
  // reader, no wasm handle). See `state/inlineSource.ts` + docs/13.
  | "inline";
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
  // (defined in `channels.ts`) keeping every loaded source's id distinct,
  // which pairs with the length-prefix encoding in `qualifiedChannelId` to
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
export function qualifiedChannelId(sourceId: string, nativeId: string): string {
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
  /**
   * Phase 4 (docs/12 §9) — opened from a *draft* recipe (a non-converged /
   * gate-failing best attempt). Surfaced as a "low-confidence decode" banner on
   * the source so the user knows the decode is unverified. Absent on every
   * normal source.
   */
  lowConfidence?: boolean;
  /**
   * Phase 4 (docs/12 §10) — opened from the sandbox-conversion escape hatch: a
   * one-shot converted copy (e.g. the sample/file converted to MCAP inside the
   * code-execution sandbox). No reusable recipe exists and it is never
   * registered, so the UI labels it "converted copy — recipe not available".
   */
  oneShot?: boolean;
}

export interface OpenResult {
  opened: string[];
  errors: BucketError[];
}

/** One channel of an inline (agent-pushed) data source. Timestamps cross the
 *  API as DECIMAL STRINGS (the project-wide BigInt rule); they are parsed to
 *  `bigint` at the `addInlineSource` boundary. */
export interface InlineChannelSpec {
  name: string;
  unit?: string;
  kind?: "scalar" | "enum";
  /** Decimal-string ns, non-decreasing, length N. */
  timestampsNs: string[];
  /** Length N; enum channels carry integer codes. */
  values: number[];
}

/** Spec for `addInlineSource` — the agent-pushed columnar dataset. */
export interface InlineSourceSpec {
  name: string;
  channels: InlineChannelSpec[];
}

/** What `addInlineSource` returns on success: the new source id and the
 *  qualified id + display name of every channel it registered. */
export interface InlineSourceResult {
  sourceId: string;
  channels: Array<{ id: string; name: string }>;
}

/** Lifecycle of the baked-in "Try the demo" load (see `demo/demoSession.ts`).
 *  `idle` covers both "never started" and "finished" — once the demo opens,
 *  `sources` is non-empty and the FirstRun overlay (the only consumer) is
 *  gone anyway. */
export type DemoLoadPhase = "idle" | "fetching" | "opening" | "error";

export interface DemoLoadState {
  phase: DemoLoadPhase;
  /** Bytes received across all demo assets — drives the progress bar. */
  receivedBytes: number;
  totalBytes: number;
  error: string | null;
}

/** A complete workspace (layout + every binding map) applied in ONE `set` —
 *  the demo loader's equivalent of `restoreNamedLayout`, minus the named-
 *  layouts bookkeeping. Maps replace wholesale, so unused kinds pass `{}`. */
export interface WorkspaceSnapshot {
  layoutJson: unknown;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  sceneBindings: Record<string, string | null>;
  mapBindings: Record<string, MapBinding | null>;
  tableBindings: Record<string, string[]>;
  valueBindings: Record<string, string[]>;
  enumBindings: Record<string, string[]>;
  plotPanelSettings: Record<string, PlotPanelSettings>;
  // Optional: a demo workspace may also seed the per-panel HUD bits,
  // point-cloud overlays, and unit overrides. Absent ⇒ reset to `{}` on
  // apply (the common case — most demos don't touch these).
  videoHudOn?: Record<string, boolean>;
  pointCloudOverlays?: Record<string, PointCloudOverlayBinding | null>;
  unitOverrides?: Record<string, string>;
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
  /**
   * The original dropped `File`. Passed to the worker on confirm instead of
   * buffering the bytes in the JS heap for the dialog's lifetime — the worker
   * re-reads it there, so peak memory drops from ~2× file size to near zero
   * between inspect and confirm.
   */
  file: File;
  /** Inspected schema: column list + suggested basis (drives the dialog). */
  schema: RawTabularSchema;
  /** The editable default basis derived from `schema.suggested`. */
  suggested: BasisDraft;
}

/**
 * A dropped file whose format Driveline doesn't recognise and which the Format
 * Registry has no recipe for. Queued by `openFiles` so the `UnknownFormatDialog`
 * can resolve it — by importing an Ingest Recipe JSON, or (Phase 2) deriving one
 * with Claude. The `File` is kept (not a byte copy) and re-read on confirm.
 * See `docs/12-format-agent.md`.
 */
export interface PendingUnknownImport {
  /** Stable queue key (monotonic), distinct from the eventual source id. */
  id: string;
  name: string;
  /** Byte length, shown in the dialog and used to size the consent preview. */
  size: number;
  /** The dropped `File` — re-read by the worker on confirm. */
  file: File;
  /**
   * Phase 4 (docs/12 §9) — a registry recipe matched this drop but the
   * open-time dry-run gate FAILED (coverage too low / framing errors), so the
   * file is queued with the stale recipe attached instead of opening garbage.
   * The dialog surfaces a "re-derive with agent" prompt; the old recipe is kept
   * until replaced. `null`/absent for an ordinary unknown drop.
   */
  staleRecipe?: { name: string; coverage: number } | null;
  /**
   * Phase 4 (docs/12 §3.4) — this entry was queued by a "Re-derive with agent"
   * action in the Formats drawer rather than a drop. Carries the name of the
   * registry recipe being re-derived; on success the new recipe replaces it.
   */
  reDeriveName?: string | null;
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

/** Optional extras for `addBookmark` — used by the agent API and import
 *  so an event lands fully formed in one store update. */
export interface AddBookmarkOpts {
  beforeNs?: bigint;
  afterNs?: bigint;
  tags?: Record<string, string>;
  origin?: BookmarkOrigin;
  confidence?: number | null;
}

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

// ---------------------------------------------------------------------------
// The single store's full state + action surface. The implementations live in
// store.ts (the factory) and its sibling slice modules; this is the public
// type contract every consumer subscribes against.
// ---------------------------------------------------------------------------
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
  layoutJson: unknown;
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
  // Per-video-panel point-cloud overlay bindings (docs/13). Keyed by the
  // FlexLayout video-panel id; `null`/absent ⇒ no overlay. Round-trips
  // through the layout shard like `mapBindings`.
  pointCloudOverlays: Record<string, PointCloudOverlayBinding | null>;
  // Decoded calibration cache, keyed by calibration channel id. Populated by
  // `loadCalibration` (open → fetch → decode) so the overlay binding picker
  // and the VideoPanel draw loop can resolve a `cameraName` to a
  // `CameraCalibration` without re-fetching. Ephemeral: not persisted (the
  // binding is; the decoded cameras are re-fetched from the open source).
  calibrationCache: Record<string, CameraCalibration[]>;
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
  /**
   * FIFO queue of dropped files in an unrecognised format with no matching
   * Format Registry recipe. The `UnknownFormatDialog` renders the head;
   * confirming (with a recipe) opens it as a `recipe` source, cancelling shifts
   * it. Reset by `clear()`. See `docs/12-format-agent.md`.
   */
  pendingUnknownImports: PendingUnknownImport[];
  /**
   * Progress/error state of the baked-in demo load. Written only by
   * `demo/demoSession.ts` (throttled while fetching); FirstRun renders the
   * progress bar and error row from it. Reset by `clear()`.
   */
  demoLoad: DemoLoadState;
  /** Shallow-merge a patch into `demoLoad`. */
  setDemoLoad(patch: Partial<DemoLoadState>): void;
  /**
   * Replace the dock layout and every per-panel binding map atomically —
   * one `set`, mirroring `restoreNamedLayout`, so the FlexLayout rebuild
   * effect sees the new JSON alongside its bindings. Used by the demo
   * loader after its sources open.
   */
  applyDemoWorkspace(snapshot: WorkspaceSnapshot): void;
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
   * Dry-run a candidate Ingest Recipe against a queued unknown import, returning
   * the decode report (records, coverage, monotonicity, per-channel ranges) the
   * dialog renders as a validation preview. No-op (`null`) on an unknown id.
   * Mirrors the Format Agent's `validate_recipe` tool. See
   * `docs/12-format-agent.md`.
   */
  dryRunRecipe(
    id: string,
    recipeJson: string,
  ): Promise<RawRecipeDryRunReport | null>;
  /**
   * Confirm a queued unknown import with an Ingest Recipe: open the file as a
   * `recipe` source, register it like any other source, save the recipe to the
   * Format Registry (so future drops of this format match offline), and dequeue.
   * No-op on an unknown id. Failures surface via `lastOpenErrors`.
   */
  confirmRecipeImport(
    id: string,
    recipeJson: string,
    opts?: {
      /**
       * Phase 4 — opened from a draft recipe: tag the source `lowConfidence`
       * (the "low-confidence decode" banner) and do NOT save the recipe to the
       * real registry (drafts live in the parallel drafts shard).
       */
      lowConfidence?: boolean;
      /**
       * Phase 4 re-derive: the name of the registry recipe this run replaces.
       * On success the old recipe is overwritten with the freshly-derived one
       * (kept until replaced, docs/12 §9). When set the recipe IS saved.
       */
      replaceRecipeName?: string;
    },
  ): Promise<void>;
  /** Cancel (drop) a queued unknown import by id. No-op on an unknown id. */
  cancelUnknownImport(id: string): void;
  /**
   * Phase 4 (docs/12 §3.4) — queue a "Re-derive with agent" run for an existing
   * registry recipe, pointed at a representative file the user picks. Opens the
   * Format Agent dialog in re-derive mode; on success the new recipe replaces
   * the named one. No-op if the file is empty.
   */
  reDeriveRecipe(name: string, file: File): void;
  /**
   * Phase 4 (docs/12 §10) — ingest a sandbox-converted MCAP copy of an unknown
   * file. Opens the bytes through the EXISTING MCAP path (`openFiles`), tags the
   * resulting source `oneShot` ("converted copy — recipe not available"), and
   * dequeues the originating unknown import. Never registers a recipe.
   */
  ingestConvertedMcap(
    id: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<void>;
  /**
   * A freshly-opened source whose channels have not yet been placed on panels,
   * awaiting the visualisation-bootstrap "Layout proposal" affordance
   * (docs/12-format-agent.md §7). `confirmRecipeImport` sets this after a recipe
   * source opens; the `LayoutProposalDialog` renders the heuristic proposal +
   * the "Refine with Claude" / Apply / Skip controls. `null` when there is
   * nothing to propose. Reset by `clear()`.
   */
  pendingLayoutProposal: { sourceId: string } | null;
  /** Queue a layout proposal for a just-opened source (no-op on unknown id). */
  proposeLayoutFor(sourceId: string): void;
  /** Dismiss the pending layout proposal (Apply / Skip / Escape). */
  dismissLayoutProposal(): void;
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
  setLayoutJson(json: unknown): void;
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
  /**
   * Set (or clear with `null`) a video panel's point-cloud overlay binding
   * (docs/13). When a non-null binding names a not-yet-cached calibration
   * channel, also kicks off `loadCalibration` so the decoded cameras are ready
   * for the draw loop.
   */
  setPointCloudOverlay(
    panelId: string,
    binding: PointCloudOverlayBinding | null,
  ): void;
  /**
   * Fetch + decode the cameras for a calibration channel into
   * `calibrationCache` (keyed by channel id). Idempotent: a cached entry
   * short-circuits. Resolves to the decoded cameras (empty array on failure).
   */
  loadCalibration(calibrationChannelId: string): Promise<CameraCalibration[]>;
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
  /** Mark a panel as selected for the Panel drawer (Phase 7). Any
   *  non-string id (`undefined` from an untyped dev-hook caller included)
   *  is stored as `null` so `selectedPanelId` keeps its `string | null`
   *  contract. */
  setSelectedPanelId(id: string | null | undefined): void;
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
   * Add a bookmark at an explicit `ns`. No clamping; caller is
   * responsible for keeping `ns` inside `globalRange`. `opts` lets
   * automated callers (the agent API, import) set the range, tags and
   * provenance in the same update. Returns the new id.
   */
  addBookmark(ns: bigint, label?: string, opts?: AddBookmarkOpts): string;
  /**
   * Bulk-import events (from `parseBookmarksImport`). `"merge"` keeps
   * existing events, replacing any whose id collides with an imported
   * one and appending the rest; `"replace"` swaps the whole list.
   * Returns how many entries were appended vs. replaced-in-place.
   */
  importBookmarks(
    entries: Bookmark[],
    mode: "merge" | "replace",
  ): { added: number; updated: number };
  /**
   * Remove a bookmark; no-op on unknown id. Returns `true` when an entry
   * was actually removed, `false` on a no-op (unknown id) so an agent
   * mutator can report whether anything changed.
   */
  removeBookmark(id: string): boolean;
  /**
   * Rename a bookmark in-place. Trimmed empty labels are rejected
   * (no-op) so an accidental Enter on an empty input doesn't blank
   * the row. Returns `true` when the label changed, `false` on a no-op
   * (unknown id, empty label, or unchanged value).
   */
  renameBookmark(id: string, label: string): boolean;
  /**
   * Set an event's optional before/after range durations (nanoseconds).
   * Both are clamped to `>= 0`; `0/0` is a point event. No-op on an
   * unknown id or when neither value changes. Returns `true` when the
   * range changed, `false` on a no-op.
   */
  setBookmarkRange(id: string, beforeNs: bigint, afterNs: bigint): boolean;
  /**
   * Set (or, when `value` trims to empty, clear) one tag attribute value
   * on an event. No-op on an unknown id or when the value is unchanged.
   * Returns `true` when a tag was set/cleared, `false` on a no-op.
   */
  setBookmarkTag(id: string, attributeId: string, value: string): boolean;
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
  /**
   * Register an inline (agent-pushed) data source: validate `spec`, build its
   * `Channel[]`, store its columnar data on the main thread (no worker), and
   * widen `globalRange` / reseat the cursor exactly like a file open so it
   * appears in the Channels rail and the scrubber covers it. Returns the new
   * source id + channel ids, or `null` on ANY validation failure (never
   * throws). See `state/inlineSource.ts` + docs/13.
   */
  addInlineSource(spec: InlineSourceSpec): InlineSourceResult | null;
  /**
   * Ascending frame timestamps (ns) for an OpenLABEL bounding-box channel —
   * one per labelled frame. The 3D scene panel binary-searches this locally to
   * map the cursor to a frame index, so it only refetches box geometry when
   * the active frame changes (not once per cursor tick). Throws for
   * non-OpenLABEL channels.
   */
  boxFrameTimes(channelId: string): Promise<BigInt64Array>;
  /**
   * Ascending frame timestamps (ns) for a trajectory channel — one per frame
   * of predicted ego future trajectories. The 3D scene panel binary-searches
   * this locally to map the cursor to a frame index, so it only refetches
   * trajectory geometry when the active frame changes (not once per cursor
   * tick). Throws for non-trajectory channels.
   */
  trajectoryFrameTimes(channelId: string): Promise<BigInt64Array>;
  /**
   * Frame timestamps (ns) for a map-geometry channel. Map geometry is STATIC,
   * so this always resolves `[0]`; the 3D scene panel reads frame[0] and
   * fetches the single frame once per binding rather than refetching on every
   * cursor tick. Throws for non-map-geometry channels.
   */
  mapGeometryFrameTimes(channelId: string): Promise<BigInt64Array>;
}
