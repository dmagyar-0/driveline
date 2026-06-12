// Agent interface — `window.__drivelineAgent`.
//
// A deliberately small, JSON-safe surface for automation (LLM agents,
// scripts, CI) to *analyse and tag* a session: enumerate sources and
// channels, pull ranged channel data, drive the transport, read/write
// events (bookmarks + tags), and capture the decoded video frame at the
// cursor. It is scoped to analysis & annotation — no file ingestion, no
// layout mutation; those stay on the dev-hook surface.
//
// Unlike `__drivelineDevHooks` (DEV-only, tree-shaken from production),
// this surface ships in the production bundle and installs when the page
// is opened with `?agent` in the query (always in DEV). Everything it can
// do, the user sitting at the page can already do — it only automates the
// same-origin session — so exposing it opt-in is safe.
//
// Contract rules (see docs/11-agent-interface.md):
//   - Every nanosecond timestamp crosses this boundary as a DECIMAL
//     STRING (the project-wide BigInt rule); `page.evaluate` and JSON
//     cannot carry bigints.
//   - Methods never throw for "not found" — they return `null` so an
//     agent can probe without try/catch scaffolding.

import { tableFromIPC } from "apache-arrow";
import { useSession } from "../state/store";
import {
  parseBookmarksImport,
  serializeBookmarks,
  type Bookmark,
} from "../state/persist/bookmarks";
import type { EventTagConfig } from "../state/persist/eventTagConfig";
import {
  getVideoCanvas,
  listVideoCanvasPanelIds,
} from "../panels/videoCanvasRegistry";

export const AGENT_API_VERSION = 1 as const;

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

export interface AgentFrameCapture {
  panelId: string;
  /** PNG data URL of the decoded frame currently on the panel canvas. */
  dataUrl: string;
  width: number;
  height: number;
}

export interface AgentApi {
  version: typeof AGENT_API_VERSION;

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
  setEventTag(id: string, attributeId: string, value: string): void;
  setEventRange(id: string, beforeNs: string, afterNs: string): void;
  renameEvent(id: string, label: string): void;
  removeEvent(id: string): void;
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
   * PNG-capture the decoded frame on a video panel's canvas (defaults
   * to the first registered panel). `null` when no panel/canvas exists.
   */
  captureVideoFrame(panelId?: string): AgentFrameCapture | null;
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

function makeAgentApi(): AgentApi {
  return {
    version: AGENT_API_VERSION,

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
      const table = tableFromIPC(bytes);
      const columns: AgentColumn[] = table.schema.fields.map((f) => {
        const col = table.getChild(f.name);
        const values: Array<number | string | null> = [];
        if (col) {
          // Per the T1.4 contract (see seriesFromArrow.ts), `.get(i)` on
          // a Timestamp column round-trips through Date semantics and
          // drops sub-ms precision — ns columns must be read from their
          // BigInt64 backing buffer and stringified.
          const chunks: ReadonlyArray<{
            values: unknown;
            length: number;
            offset: number;
          }> = col.data;
          let g = 0;
          for (const chunk of chunks) {
            const raw = chunk.values;
            const big =
              raw instanceof BigInt64Array || raw instanceof BigUint64Array
                ? raw
                : null;
            for (let i = 0; i < chunk.length; i++, g++) {
              if (big !== null) {
                values.push(big[chunk.offset + i].toString());
                continue;
              }
              const v: unknown = col.get(g);
              if (v === null || v === undefined) values.push(null);
              else if (typeof v === "bigint") values.push(v.toString());
              else if (typeof v === "number") values.push(v);
              else values.push(String(v));
            }
          }
        }
        return { name: f.name, values };
      });
      return { rows: table.numRows, columns };
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
      useSession.getState().setBookmarkTag(id, attributeId, value);
    },
    setEventRange(id, beforeNs, afterNs) {
      const before = tryBigInt(beforeNs);
      const after = tryBigInt(afterNs);
      if (before === null || after === null) return;
      useSession.getState().setBookmarkRange(id, before, after);
    },
    renameEvent(id, label) {
      useSession.getState().renameBookmark(id, label);
    },
    removeEvent(id) {
      useSession.getState().removeBookmark(id);
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

    captureVideoFrame(panelId) {
      const id = panelId ?? listVideoCanvasPanelIds()[0];
      if (id === undefined) return null;
      const canvas = getVideoCanvas(id);
      if (canvas === null || canvas.width === 0 || canvas.height === 0) {
        return null;
      }
      return {
        panelId: id,
        dataUrl: canvas.toDataURL("image/png"),
        width: canvas.width,
        height: canvas.height,
      };
    },
  };
}

/**
 * Install `window.__drivelineAgent`. Idempotent per install; returns the
 * uninstaller (App calls it on unmount, mirroring the dev hooks).
 */
export function installAgentApi(): () => void {
  window.__drivelineAgent = makeAgentApi();
  return () => {
    delete window.__drivelineAgent;
  };
}
