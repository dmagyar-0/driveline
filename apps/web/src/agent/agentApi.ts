// Agent interface — `window.__drivelineAgent`.
//
// A deliberately small, JSON-safe surface for automation (LLM agents,
// scripts, CI) to *analyse, tag, lay out, and — since v3 — feed* a session:
// enumerate sources and channels, pull ranged channel data, drive the
// transport, read/write events (bookmarks + tags), capture the decoded video
// frame at the cursor, mutate the panel layout (create/bind/close panels), and
// push the agent's OWN inline data source (`addDataSource`). The v2 write ops
// are the minimum the Format Agent's visualisation bootstrap (docs/12 §7
// `LayoutProposal` applier) needs, shared with external agents + Playwright;
// v3 adds the "Bring Your Own Agent" surface (docs/13); v4 completes the
// scene-geometry binding (`setSceneBinding`) so an agent can display a point
// cloud / boxes / trajectory — not just create the panel.
//
// File ingestion (decoding bytes through a Rust reader) still stays on the
// dev-hook surface — but that restriction is RELAXED for inline agent data:
// `addDataSource` accepts the agent's own bounded, in-memory columnar dataset
// (no file bytes, no URL), held on the main thread and ranged-fetched exactly
// like a reader-backed source (see `state/inlineSource.ts`). It is the agent
// feeding the page its own data, not Driveline reaching out for a file.
//
// Discovery is ALWAYS on: `version`, `getSkill()` and `describe()` install on
// every load (pure documentation + a capability manifest — no mutation, no
// session data). Every MUTATING / data-reading op (the v1/v2 surface plus
// `addDataSource`) installs only when the page is opened with `?agent` in the
// query (always in DEV). Everything those gated ops can do, the user at the
// page can already do — it only automates the same-origin session — so the
// opt-in gate is the safety boundary.
//
// Contract rules (see docs/11-agent-interface.md):
//   - Every nanosecond timestamp crosses this boundary as a DECIMAL
//     STRING (the project-wide BigInt rule); `page.evaluate` and JSON
//     cannot carry bigints.
//   - Methods never throw for "not found"/bad input — they return
//     `null`/`false` so an agent can probe without try/catch scaffolding. The
//     v2 layout write ops and v3 `addDataSource` keep that posture: unknown
//     panel/kind/channel or an invalid spec → `null` or `false`, never an
//     exception.

import {
  useSession,
  type InlineSourceSpec,
  type InlineSourceResult,
} from "../state/store";
import { AGENT_SKILL } from "./agentSkill";
import {
  parseBookmarksImport,
  serializeBookmarks,
  type Bookmark,
} from "../state/persist/bookmarks";
import type { EventTagConfig } from "../state/persist/eventTagConfig";
import { listVideoCanvasPanelIds } from "../panels/videoCanvasRegistry";
import { getWorkspaceBridge } from "../layout/workspaceBridge";
import { panelKindOf, panelNameFor, type PanelKind } from "../layout/panelId";
// NB: despite the "PLOT" in the name, this cap is applied to EVERY list-binding
// panel kind in `bindChannels` (plot/enum/table/value), not just plots — the
// export lives in `panels/palette.ts` (out of this module's edit scope).
import { MAX_PLOT_SERIES } from "../panels/palette";
import { captureVideoFrameAt as captureFrameOffThread } from "./videoCapture";
// Session-analysis logic (Arrow column decode + the playback-independent
// snapshot) lives in `snapshot.ts` (WAL-02) so this stays a thin facade.
import {
  decodeAgentColumns,
  buildSnapshot,
  toAgentCapturedFrame,
} from "./snapshot";

// v6: `captureVideoFrame` went sync → async (breaking). After the off-thread
// blit refactor the video canvas is transferred to the worker, so the live
// canvas can no longer be read back (`toDataURL` throws on a transferred
// canvas). `captureVideoFrame` now resolves the panel's bound channel and
// decodes the frame at the current cursor off the playback path — the same
// path as `captureVideoFrameAt`, returning an `AgentCapturedFrame`.
//
// v7: the event mutators (`setEventTag`/`setEventRange`/`renameEvent`/
// `removeEvent`) now RETURN `boolean` instead of `void` (breaking), honouring
// the surface's own "return null/false so an agent can probe" contract — they
// forward the underlying store actions' changed/existed result. (Also: the
// off-the-playback-path capture/read ops `captureVideoFrame[At]`/`snapshotAt`
// are now marked `mutating: false` in `describe()` — a manifest fix, not a
// signature change, since they never alter session state.)
export const AGENT_API_VERSION = 7 as const;

/**
 * Spec for `addDataSource` — the agent's own inline (columnar) dataset.
 * Re-exported from the store types so callers import it from one place.
 */
export type AgentDataSourceSpec = InlineSourceSpec;

/** A single method on the agent surface, for the `describe()` manifest. */
export interface AgentCapability {
  name: string;
  summary: string;
  /** `true` if the method mutates state / reads session data (so it is gated
   *  behind `?agent`); `false` for the always-on discovery trio. */
  mutating: boolean;
}

export interface AgentManifest {
  version: number;
  capabilities: AgentCapability[];
  /** Whether the mutating surface requires `?agent` in the URL. */
  agentParamRequired: boolean;
}

/** One decoded Arrow column, JSON-safe (bigints → decimal strings). */
export interface AgentColumn {
  name: string;
  values: Array<number | string | null>;
}

export interface AgentRange {
  rows: number;
  columns: AgentColumn[];
}

export interface AgentEvent {
  id: string;
  ns: string;
  beforeNs: string;
  afterNs: string;
  label: string;
  color: string;
  createdAt: number;
  tags: Record<string, string>;
  origin: "user" | "agent";
  confidence: number | null;
}

export interface AddAgentEventInput {
  /** Event timestamp; defaults to the current cursor. */
  ns?: string;
  label?: string;
  beforeNs?: string;
  afterNs?: string;
  tags?: Record<string, string>;
  /** Confidence in [0, 1]; clamped. */
  confidence?: number;
}

/** A camera frame decoded off the playback path at a requested timestamp
 *  (`captureVideoFrameAt` / `snapshotAt`). No panel is involved. */
export interface AgentCapturedFrame {
  channelId: string;
  cameraName: string;
  /** PTS (ns, decimal string) of the frame actually returned — the newest
   *  frame at or before the requested timestamp. */
  ptsNs: string;
  width: number;
  height: number;
  /** `data:image/png;base64,...` of the decoded frame. */
  dataUrl: string;
}

/** A scalar channel's value at the snapshot instant. */
export interface AgentScalarSample {
  channelId: string;
  name: string;
  unit: string | null;
  /** Timestamp (ns, decimal string) of the sampled point (newest at/<= T), or
   *  null when the channel has no sample at/before T. */
  sampleNs: string | null;
  value: number | null;
}

/** The LiDAR spin active at the snapshot instant. Raw points are not inlined
 *  (a spin is large) — fetch them with `fetchChannelRange(channelId, spinTsNs,
 *  spinTsNs+1)`. */
export interface AgentPointCloudRef {
  channelId: string;
  name: string;
  spinTsNs: string | null;
}

/** A complete, playback-independent view of the session at one timestamp:
 *  camera frame(s), the active LiDAR spin(s), and every scalar's value at T,
 *  plus the channel inventory so an agent can fetch anything else it needs. */
export interface AgentSnapshot {
  /** The timestamp this snapshot was taken at (ns, decimal string). */
  tsNs: string;
  cameras: AgentCapturedFrame[];
  pointClouds: AgentPointCloudRef[];
  scalars: AgentScalarSample[];
  channels: { channelId: string; name: string; kind: string }[];
}

export interface AgentApi {
  version: typeof AGENT_API_VERSION;

  // ── discovery (always on — no ?agent required) ──────────────────
  /**
   * The full "Bring Your Own Agent" guide as Markdown: what Driveline is, the
   * BigInt/decimal-string rule, the `AgentDataSourceSpec` shape with a
   * copy-pasteable worked example, and how to read data back / drive the
   * transport. Pure documentation — available WITHOUT `?agent`.
   */
  getSkill(): string;
  /**
   * Machine-readable manifest of every method (name, one-line summary, whether
   * it mutates / is gated). Pure introspection — available WITHOUT `?agent`.
   */
  describe(): AgentManifest;

  // ── ingestion (v3) ──────────────────────────────────────────────
  /**
   * Register the agent's own inline data source from columnar JSON (no file
   * bytes, no URL). Channels appear in the Channels rail, the scrubber widens
   * to cover them, and they are fetchable/bindable exactly like a file-backed
   * source. Returns the new source id + channel ids, or `null` on any
   * validation failure (never throws). Gated behind `?agent`.
   */
  addDataSource(spec: AgentDataSourceSpec): InlineSourceResult | null;

  // ── session / data (read-only) ──────────────────────────────────
  getSessionSnapshot(): {
    cursorNs: string;
    playing: boolean;
    speed: number;
    globalRange: { startNs: string; endNs: string } | null;
  };
  listSources(): Array<{
    id: string;
    kind: string;
    name: string;
    timeRange: { startNs: string; endNs: string };
    channelIds: string[];
  }>;
  listChannels(): Array<{
    id: string;
    sourceId: string;
    name: string;
    kind: string;
    dtype: string | null;
    unit: string | null;
    sampleCount: number;
  }>;
  /**
   * Fetch `[startNs, endNs)` of one channel, decoded from Arrow into
   * JSON-safe columns (`ts` arrives as decimal-string nanoseconds).
   * Resolves `null` on an unknown channel id.
   */
  fetchChannelRange(
    channelId: string,
    startNs: string,
    endNs: string,
    includePrev?: boolean,
  ): Promise<AgentRange | null>;

  // ── transport ───────────────────────────────────────────────────
  setCursor(ns: string): void;
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;

  // ── events (bookmarks + tags) ───────────────────────────────────
  getEventTagConfig(): EventTagConfig;
  listEvents(): AgentEvent[];
  /** Create an event (origin `"agent"`). Returns its id, or `null`
   *  when no session is loaded and no explicit `ns` was given. */
  addEvent(input?: AddAgentEventInput): string | null;
  /** Set/clear an event tag. Returns `true` if the value changed, `false` for
   *  an unknown id or a no-op (the value already equals what was passed). */
  setEventTag(id: string, attributeId: string, value: string): boolean;
  /** Set an event's before/after range. Returns `true` if it changed, `false`
   *  for an unknown id, unparseable ns, or a no-op. */
  setEventRange(id: string, beforeNs: string, afterNs: string): boolean;
  /** Rename an event. Returns `true` if the label changed, `false` for an
   *  unknown id, an empty/whitespace label, or a no-op. */
  renameEvent(id: string, label: string): boolean;
  /** Delete an event. Returns `true` if it existed and was removed, else
   *  `false`. */
  removeEvent(id: string): boolean;
  /** The full event list as portable JSON (same format Import accepts). */
  exportEvents(): string;
  /** Bulk-import events; `mode` defaults to `"merge"` (by id). Returns
   *  the merge counts, or `null` when the JSON does not parse. */
  importEvents(
    json: string,
    mode?: "merge" | "replace",
  ): { added: number; updated: number } | null;

  // ── video ───────────────────────────────────────────────────────
  /** Panel ids that currently have a live video canvas. */
  listVideoPanels(): string[];
  /**
   * Capture the camera frame for a video panel at the CURRENT cursor
   * (defaults to the first live panel). v6: async + off the playback path —
   * the panel's video canvas is now owned by the decode worker
   * (`transferControlToOffscreen`), so the live canvas can't be read back.
   * This resolves the panel's bound video channel and decodes the frame
   * nearest the cursor via the same path as `captureVideoFrameAt` (returning
   * an `AgentCapturedFrame`). Resolves `null` when no live panel exists, the
   * panel has no resolvable video binding, or the cursor has no covering
   * frame. Never throws.
   */
  captureVideoFrame(panelId?: string): Promise<AgentCapturedFrame | null>;
  /**
   * Decode the camera frame nearest `ns` on `channelId`, OFF the playback path:
   * no video panel required, the playback cursor is not moved, and live
   * playback is undisturbed. Resolves `null` for an unknown/non-video channel,
   * no loaded session, or a timestamp with no covering frame. This is the
   * frame-accurate, headless counterpart to `captureVideoFrame` (which only
   * reads whatever is currently on a panel's canvas).
   */
  captureVideoFrameAt(
    channelId: string,
    ns: string,
  ): Promise<AgentCapturedFrame | null>;
  /**
   * A complete, playback-independent snapshot of the session at `ns` (defaults
   * to the current cursor when `ns` is unparseable): the decoded frame for
   * every camera, a reference to the LiDAR spin active at `ns` for every
   * point-cloud channel, every scalar's value at `ns`, and the full channel
   * inventory. Lets an agent analyse any instant without driving the transport
   * or opening panels. Always resolves a bundle (empty arrays when nothing is
   * loaded); never throws.
   */
  snapshotAt(ns: string): Promise<AgentSnapshot>;

  // ── layout write ops (v2) ───────────────────────────────────────
  // Thin wrappers over the FlexLayout workspace bridge + the store's
  // binding actions. They are the applier surface for the Format Agent's
  // `LayoutProposal` (docs/12 §7), shared with external agents + e2e.
  /**
   * Mint a panel of `kind` (one of `PanelKind`: plot/map/enum/table/value/
   * video/scene) and return its freshly-minted panel id. `null` when the
   * kind is unknown/unsupported or the workspace has not mounted yet.
   */
  createPanel(kind: PanelKind): string | null;
  /**
   * Bind scalar channels to a plot/enum/table/value panel via the matching
   * store action. Validates that the panel exists, is a bindable kind, and
   * that every channel id is known; it also enforces the `MAX_PLOT_SERIES` cap
   * (which despite its name applies to all four list kinds) against the panel's
   * current bindings. Returns `false` (binding nothing) if any precondition
   * fails.
   */
  bindChannels(panelId: string, channelIds: string[]): boolean;
  /**
   * Set a map panel's lat/lon binding. Validates that the panel is a map
   * and that both channel ids exist. Returns `false` otherwise.
   */
  setMapBinding(panelId: string, latId: string, lonId: string): boolean;
  /**
   * Bind a 3D-geometry channel — `point_cloud` (LiDAR), `bounding_box`,
   * `trajectory`, or `map_geometry` — to a `scene` panel. Scene panels hold one
   * geometry channel at a time, so this is a single-channel setter rather than
   * the list-oriented `bindChannels` (which only covers plot/enum/table/value).
   * Pass `null` to clear the binding. Validates the panel is a scene and (when
   * non-null) the channel exists; returns `false` otherwise. This is how an
   * agent displays a point cloud — e.g. a raw NVIDIA Alpamayo LiDAR clip.
   */
  setSceneBinding(panelId: string, channelId: string | null): boolean;
  /**
   * Delete a panel's tab from the layout. Returns `true` if the tab existed
   * and was removed, `false` otherwise.
   */
  closePanel(panelId: string): boolean;
}

declare global {
  interface Window {
    __drivelineAgent?: AgentApi;
  }
}

/** `?agent` (any value) opts the page into the agent API. */
export function agentApiRequested(search: string): boolean {
  return new URLSearchParams(search).has("agent");
}

function tryBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function toAgentEvent(b: Bookmark): AgentEvent {
  return {
    id: b.id,
    ns: b.ns.toString(),
    beforeNs: b.beforeNs.toString(),
    afterNs: b.afterNs.toString(),
    label: b.label,
    color: b.color,
    createdAt: b.createdAt,
    tags: { ...b.tags },
    origin: b.origin,
    confidence: b.confidence,
  };
}

// Capability manifest — the authoritative list `describe()` returns. `mutating`
// is the *semantic* flag (does the call change session state), so an agent can
// reason about dry-run safety; it is NOT the gating signal. Gating is conveyed
// by `agentParamRequired`: the whole non-discovery surface (reads included,
// since they expose session data) needs `?agent`, while the three discovery
// methods install always. Keep in sync with the `AgentApi` interface.
const AGENT_CAPABILITIES: readonly AgentCapability[] = [
  { name: "getSkill", summary: "Full BYOA guide (Markdown).", mutating: false },
  { name: "describe", summary: "This capability manifest.", mutating: false },
  {
    name: "addDataSource",
    summary: "Register an inline columnar data source.",
    mutating: true,
  },
  {
    name: "getSessionSnapshot",
    summary: "Cursor / playing / speed / globalRange.",
    mutating: false,
  },
  { name: "listSources", summary: "Loaded sources.", mutating: false },
  { name: "listChannels", summary: "Loaded channels.", mutating: false },
  {
    name: "fetchChannelRange",
    summary: "Ranged channel data as JSON columns.",
    mutating: false,
  },
  { name: "setCursor", summary: "Move the playback cursor.", mutating: true },
  { name: "play", summary: "Start playback.", mutating: true },
  { name: "pause", summary: "Stop playback.", mutating: true },
  { name: "setSpeed", summary: "Set playback speed.", mutating: true },
  {
    name: "getEventTagConfig",
    summary: "Event tag taxonomy.",
    mutating: false,
  },
  { name: "listEvents", summary: "All events.", mutating: false },
  { name: "addEvent", summary: "Create an agent event.", mutating: true },
  { name: "setEventTag", summary: "Set an event tag value.", mutating: true },
  { name: "setEventRange", summary: "Set an event's range.", mutating: true },
  { name: "renameEvent", summary: "Rename an event.", mutating: true },
  { name: "removeEvent", summary: "Delete an event.", mutating: true },
  {
    name: "exportEvents",
    summary: "Events as portable JSON.",
    mutating: false,
  },
  { name: "importEvents", summary: "Bulk-import events.", mutating: true },
  {
    name: "listVideoPanels",
    summary: "Live video panel ids.",
    mutating: false,
  },
  // The three capture/read ops decode OFF the playback path and never alter
  // session state (cursor untouched, no panel created), so they are
  // `mutating: false` — the same dry-run-safe posture as the gated read
  // `fetchChannelRange`. They stay `?agent`-gated via `agentParamRequired`.
  {
    name: "captureVideoFrameAt",
    summary: "Decode a camera frame at a timestamp, off the playback path.",
    mutating: false,
  },
  {
    name: "snapshotAt",
    summary:
      "Playback-independent bundle (frames + spins + scalars) at a time.",
    mutating: false,
  },
  {
    name: "captureVideoFrame",
    summary:
      "PNG of a panel's camera frame at the current cursor (off-thread, async).",
    mutating: false,
  },
  { name: "createPanel", summary: "Mint a panel of a kind.", mutating: true },
  {
    name: "bindChannels",
    summary: "Bind channels to a panel.",
    mutating: true,
  },
  { name: "setMapBinding", summary: "Bind a map's lat/lon.", mutating: true },
  {
    name: "setSceneBinding",
    summary: "Bind a 3D-geometry channel to a scene panel.",
    mutating: true,
  },
  { name: "closePanel", summary: "Delete a panel.", mutating: true },
];

/** The always-on discovery trio (`version`/`getSkill`/`describe`) — installed
 *  on every load, even without `?agent`. Pure documentation + introspection,
 *  no mutation and no session-data read. */
function makeDiscoverySurface(agentParamRequired: boolean): {
  version: typeof AGENT_API_VERSION;
  getSkill(): string;
  describe(): AgentManifest;
} {
  return {
    version: AGENT_API_VERSION,
    getSkill: () => AGENT_SKILL,
    describe: () => ({
      version: AGENT_API_VERSION,
      capabilities: AGENT_CAPABILITIES.map((c) => ({ ...c })),
      agentParamRequired,
    }),
  };
}

function makeAgentApi(): AgentApi {
  return {
    ...makeDiscoverySurface(true),

    addDataSource(spec) {
      return useSession.getState().addInlineSource(spec);
    },

    getSessionSnapshot() {
      const s = useSession.getState();
      return {
        cursorNs: s.cursorNs.toString(),
        playing: s.playing,
        speed: s.speed,
        globalRange: s.globalRange
          ? {
              startNs: s.globalRange.startNs.toString(),
              endNs: s.globalRange.endNs.toString(),
            }
          : null,
      };
    },

    listSources() {
      return useSession.getState().sources.map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.name,
        timeRange: {
          startNs: s.timeRange.startNs.toString(),
          endNs: s.timeRange.endNs.toString(),
        },
        channelIds: s.channels.map((c) => c.id),
      }));
    },

    listChannels() {
      return useSession.getState().channels.map((c) => ({
        id: c.id,
        sourceId: c.sourceId,
        name: c.name,
        kind: c.kind,
        dtype: c.dtype ?? null,
        unit: c.unit ?? null,
        sampleCount: c.sampleCount,
      }));
    },

    async fetchChannelRange(channelId, startNs, endNs, includePrev = false) {
      const start = tryBigInt(startNs);
      const end = tryBigInt(endNs);
      if (start === null || end === null) return null;
      const st = useSession.getState();
      if (!st.channels.some((c) => c.id === channelId)) return null;
      const bytes = await st.fetchChannelRange(
        channelId,
        start,
        end,
        includePrev,
      );
      return decodeAgentColumns(bytes);
    },

    setCursor(ns) {
      const v = tryBigInt(ns);
      if (v === null) return;
      useSession.getState().setCursor(v);
    },
    play: () => useSession.getState().play(),
    pause: () => useSession.getState().pause(),
    setSpeed: (speed) => useSession.getState().setSpeed(speed),

    getEventTagConfig: () => useSession.getState().eventTagConfig,

    listEvents() {
      return useSession.getState().bookmarks.map(toAgentEvent);
    },

    addEvent(input = {}) {
      const st = useSession.getState();
      const ns = input.ns !== undefined ? tryBigInt(input.ns) : st.cursorNs;
      if (ns === null) return null;
      if (input.ns === undefined && st.globalRange === null) return null;
      const beforeNs =
        input.beforeNs !== undefined ? tryBigInt(input.beforeNs) : 0n;
      const afterNs =
        input.afterNs !== undefined ? tryBigInt(input.afterNs) : 0n;
      if (beforeNs === null || afterNs === null) return null;
      return st.addBookmark(ns, input.label, {
        beforeNs,
        afterNs,
        tags: input.tags,
        origin: "agent",
        confidence: input.confidence ?? null,
      });
    },

    setEventTag(id, attributeId, value) {
      return useSession.getState().setBookmarkTag(id, attributeId, value);
    },
    setEventRange(id, beforeNs, afterNs) {
      const before = tryBigInt(beforeNs);
      const after = tryBigInt(afterNs);
      if (before === null || after === null) return false;
      return useSession.getState().setBookmarkRange(id, before, after);
    },
    renameEvent(id, label) {
      return useSession.getState().renameBookmark(id, label);
    },
    removeEvent(id) {
      return useSession.getState().removeBookmark(id);
    },

    exportEvents() {
      return serializeBookmarks(useSession.getState().bookmarks);
    },

    importEvents(json, mode = "merge") {
      const parsed = parseBookmarksImport(json);
      if (parsed === null) return null;
      return useSession.getState().importBookmarks(parsed, mode);
    },

    listVideoPanels: () => listVideoCanvasPanelIds(),

    async captureVideoFrame(panelId) {
      // v6: thin async alias for "the camera frame this panel shows at the
      // current cursor". The panel's video canvas is owned by the decode
      // worker now (transferControlToOffscreen), so we can't read it back;
      // instead resolve the panel's bound video channel and decode the frame
      // nearest the cursor off the playback path (same code path as
      // `captureVideoFrameAt`). No-throw: null for an unknown/unbound panel.
      const st = useSession.getState();
      const id = panelId ?? listVideoCanvasPanelIds()[0];
      if (id === undefined) return null;
      const channelId = st.videoBindings[id] ?? null;
      if (channelId === null) return null;
      const cap = await captureFrameOffThread(channelId, st.cursorNs);
      return cap ? toAgentCapturedFrame(cap) : null;
    },

    async captureVideoFrameAt(channelId, ns) {
      const t = tryBigInt(ns);
      if (t === null) return null;
      const cap = await captureFrameOffThread(channelId, t);
      return cap ? toAgentCapturedFrame(cap) : null;
    },

    async snapshotAt(ns) {
      const st = useSession.getState();
      const t = tryBigInt(ns) ?? st.cursorNs;
      return buildSnapshot(st, t);
    },

    createPanel(kind) {
      // Reject anything that isn't a real PanelKind before touching the
      // bridge — `kindLabel`/the factory only know the seven kinds, and an
      // unknown string would otherwise mint an "Unknown panel type" tab.
      if (!KNOWN_PANEL_KINDS.has(kind)) return null;
      const bridge = getWorkspaceBridge();
      if (bridge === null) return null;
      return bridge.createPanel(kind) ?? null;
    },

    bindChannels(panelId, channelIds) {
      const kind = panelKindOf(panelId);
      if (kind === null) return false;
      const st = useSession.getState();
      // Confirm the panel actually exists in the layout (a well-formed id
      // for a panel that was never created, or was already closed, must not
      // silently create a binding for a ghost panel).
      if (!panelExists(st.layoutJson, panelId)) return false;
      // Every channel must exist; a partial bind would drop findings.
      const known = new Set(st.channels.map((c) => c.id));
      if (channelIds.some((id) => !known.has(id))) return false;
      // Dedupe the request itself so the cap check matches what the store
      // would actually store.
      const requested = [...new Set(channelIds)];
      switch (kind) {
        case "plot":
        case "enum":
        case "table":
        case "value": {
          const existing = bindingsFor(st, kind, panelId);
          // Only count genuinely new ids against the cap (re-binding an
          // already-bound channel is a no-op in the store).
          const added = requested.filter((id) => !existing.includes(id));
          if (existing.length + added.length > MAX_PLOT_SERIES) return false;
          const add = bindActionFor(st, kind);
          for (const id of requested) add(panelId, id);
          return true;
        }
        // map needs a lat/lon pair (use setMapBinding); video/scene bind
        // through their own single-channel store actions, not this list API.
        default:
          return false;
      }
    },

    setMapBinding(panelId, latId, lonId) {
      if (panelKindOf(panelId) !== "map") return false;
      const st = useSession.getState();
      if (!panelExists(st.layoutJson, panelId)) return false;
      const known = new Set(st.channels.map((c) => c.id));
      if (!known.has(latId) || !known.has(lonId)) return false;
      st.setMapBinding(panelId, { latChannelId: latId, lonChannelId: lonId });
      return true;
    },

    setSceneBinding(panelId, channelId) {
      if (panelKindOf(panelId) !== "scene") return false;
      const st = useSession.getState();
      if (!panelExists(st.layoutJson, panelId)) return false;
      // `null` clears the binding; a non-null id must name a real channel.
      if (channelId !== null && !st.channels.some((c) => c.id === channelId)) {
        return false;
      }
      st.setSceneBinding(panelId, channelId);
      return true;
    },

    closePanel(panelId) {
      const bridge = getWorkspaceBridge();
      if (bridge === null) return false;
      return bridge.closePanel(panelId);
    },
  };
}

const KNOWN_PANEL_KINDS: ReadonlySet<PanelKind> = new Set<PanelKind>([
  "plot",
  "video",
  "scene",
  "map",
  "table",
  "value",
  "enum",
]);

type ListBindingKind = "plot" | "enum" | "table" | "value";

type SessionState = ReturnType<typeof useSession.getState>;

/** The current bound-channel list for a list-binding panel kind. */
function bindingsFor(
  st: SessionState,
  kind: ListBindingKind,
  panelId: string,
): string[] {
  switch (kind) {
    case "plot":
      return st.plotBindings[panelId] ?? [];
    case "enum":
      return st.enumBindings[panelId] ?? [];
    case "table":
      return st.tableBindings[panelId] ?? [];
    case "value":
      return st.valueBindings[panelId] ?? [];
  }
}

/** The single-channel append action for a list-binding panel kind. */
function bindActionFor(
  st: SessionState,
  kind: ListBindingKind,
): (panelId: string, channelId: string) => void {
  switch (kind) {
    case "plot":
      return st.addPlotChannel;
    case "enum":
      return st.addEnumChannel;
    case "table":
      return st.addTableChannel;
    case "value":
      return st.addValueChannel;
  }
}

/** Whether the FlexLayout JSON snapshot contains a tab with `panelId`. The
 *  store keeps only the JSON snapshot in sync; the live Model is reached via
 *  the workspace bridge, but tab existence is cheap to read off the JSON.
 *  `createPanel`/`closePanel` push `model.toJson()` into the store before
 *  returning, so the snapshot is current by the time a binding call runs. */
function panelExists(layoutJson: unknown, panelId: string): boolean {
  return panelNameFor(layoutJson, panelId) !== null;
}

/**
 * Install `window.__drivelineAgent`.
 *
 * `full` selects which surface installs:
 *   - `false` (no `?agent`, not DEV): only the always-on discovery trio
 *     (`version`/`getSkill`/`describe`) — pure documentation + a capability
 *     manifest, no mutation and no session-data read. `describe()` reports
 *     `agentParamRequired: true` so the agent knows to reload with `?agent`.
 *   - `true` (`?agent` present, or DEV): the full surface (discovery +
 *     `addDataSource` + the v1/v2 read/transport/event/video/layout ops).
 *
 * Always prints a one-line console banner pointing agents at `getSkill()`.
 * Idempotent per install; returns the uninstaller (App calls it on unmount,
 * mirroring the dev hooks).
 */
export function installAgentApi(full: boolean): () => void {
  window.__drivelineAgent = full
    ? makeAgentApi()
    : (makeDiscoverySurface(true) as AgentApi);

  // One-line breadcrumb so an agent driving the live page (or a human in the
  // console) finds the surface without reading the source.
  console.info(
    full
      ? "[driveline] Agent surface ready — window.__drivelineAgent.getSkill() for the guide; full ops unlocked (?agent / DEV)."
      : "[driveline] window.__drivelineAgent.getSkill() / describe() available — append ?agent to the URL to unlock the full automation surface.",
  );

  return () => {
    delete window.__drivelineAgent;
  };
}
