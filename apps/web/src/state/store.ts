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
import { bucketFiles, type BucketError } from "./bucket";
import { MAX_PLOT_SERIES } from "../panels/palette";
import { loadLayoutFromStorage } from "../layout/persist";
import { mark, measure, timed } from "../perf";
import type {
  ChannelKindWire,
  DataCoreApi,
  McapSummary,
  Mf4Summary,
  Mp4SidecarSummary,
} from "../workerClient";

export type SourceKind = "mcap" | "mf4" | "mp4+sidecar";
export type ChannelKind = ChannelKindWire;

export interface TimeRange {
  startNs: bigint;
  endNs: bigint;
}

export interface Channel {
  id: string;
  sourceId: string;
  name: string;
  kind: ChannelKind;
  dtype: string | null;
  unit: string | null;
  sampleCount: number;
  timeRange: TimeRange;
}

export interface SourceMeta {
  id: string;
  kind: SourceKind;
  name: string;
  handle: number;
  timeRange: TimeRange;
  channels: Channel[];
}

export interface OpenResult {
  opened: string[];
  errors: BucketError[];
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
  // Layout + bindings slice (T6.2). `layoutJson` is the opaque FlexLayout
  // model (`Model.toJson()` output); the binding maps are keyed by the
  // FlexLayout tab id so a closed-and-reopened panel can reclaim its
  // configuration on reload.
  layoutJson: unknown | null;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  /** Drives a drop batch through bucket → per-source open → merge. */
  openFiles(files: File[]): Promise<OpenResult>;
  /** Close every loaded wasm handle and reset to the empty session. */
  clear(): Promise<void>;
  /** Test / dev seam: inject the Comlink worker proxy exactly once. */
  setWorker(worker: Remote<DataCoreApi>): void;
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
  /** Move the cursor; clamped to `globalRange`. Pauses if at `endNs`. */
  setCursor(ns: bigint): void;
  /** Replace the FlexLayout JSON model wholesale. */
  setLayoutJson(json: unknown | null): void;
  /** Bind a video panel to a channel, or `null` to clear. */
  setVideoBinding(panelId: string, channelId: string | null): void;
  /** Replace a plot panel's bound channels wholesale (capped, deduped). */
  setPlotBinding(panelId: string, ids: string[]): void;
  /** Append one channel to a plot panel (no-op if present or at cap). */
  addPlotChannel(panelId: string, channelId: string): void;
  /** Remove one channel from a plot panel (no-op if absent). */
  removePlotChannel(panelId: string, channelId: string): void;
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
    id: c.id,
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
    id: c.id,
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
    id: c.id,
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

  return {
    sources: [],
    channels: [],
    globalRange: null,
    cursorNs: 0n,
    playing: false,
    speed: 1,
    layoutJson: hydrated?.layoutJson ?? null,
    videoBindings: hydrated?.videoBindings ?? {},
    plotBindings: hydrated?.plotBindings ?? {},

    setWorker(w) {
      worker = w;
    },

    getWorker() {
      return worker;
    },

    play() {
      const { globalRange, cursorNs } = get();
      if (!globalRange) return;
      if (cursorNs >= globalRange.endNs) {
        set({ cursorNs: globalRange.startNs, playing: true });
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

    setCursor(ns) {
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
      set({ layoutJson: json });
    },

    setVideoBinding(panelId, channelId) {
      const prev = get().videoBindings;
      if (prev[panelId] === channelId) return;
      set({ videoBindings: { ...prev, [panelId]: channelId } });
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
            channel.id,
            startNs,
            endNs,
            includePrev,
          );
        }
        if (source.kind === "mf4") {
          return await worker.mf4FetchRange(
            source.handle,
            channel.id,
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
            const mp4Bytes = await fileBytes(pair.mp4);
            const tsBytes = await fileBytes(pair.ts);
            const handle = await w.openMp4Sidecar(mp4Bytes, tsBytes);
            const summary = await w.mp4SidecarSummary(handle);
            const id = uniqueSourceId(pair.mp4.name, [
              ...existing,
              ...newSources,
            ]);
            const channels = mp4Channels(id, summary);
            newSources.push({
              id,
              kind: "mp4+sidecar",
              name: pair.mp4.name,
              handle,
              timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
              channels,
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
          // Seed / reseat the cursor so it is always inside `globalRange`.
          // On the first successful drop, `cursorNs` is still the 0n
          // default; on later drops, leave it alone unless it now falls
          // outside the (possibly widened) union range.
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

    async clear() {
      const run = async () => {
        if (!worker) return;
        const w = worker;
        for (const s of get().sources) {
          try {
            if (s.kind === "mcap") await w.closeMcap(s.handle);
            else if (s.kind === "mf4") await w.closeMf4(s.handle);
            else await w.closeMp4Sidecar(s.handle);
          } catch {
            // Swallow close errors — the slab entry either stays for the
            // lifetime of the worker, or was already freed.
          }
        }
        // Wipe session + transport + per-panel bindings, but keep
        // `layoutJson` so the user's dock layout survives a clear (T6.2 —
        // layout outlives a session, per docs/06-ui-and-panels.md:167).
        set({
          sources: [],
          channels: [],
          globalRange: null,
          cursorNs: 0n,
          playing: false,
          speed: 1,
          videoBindings: {},
          plotBindings: {},
        });
      };
      const next = pending.then(run, run);
      pending = next.catch(() => undefined);
      await next;
    },
  };
});
