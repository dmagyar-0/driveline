// Zustand store for T2.4. Scope: the "session" slice — sources, flat
// channel list, and union `globalRange`. Transport / panel bindings /
// layout (per `docs/06-ui-and-panels.md:47-77`) belong to later milestones.
//
// The store is worker-aware: it holds the `Remote<DataCoreApi>` proxy and
// dispatches to the correct `open_*` / `close_*` WASM function based on the
// bucketed file type. Each live `SourceMeta` carries the wasm slab handle
// so `clear()` can tear everything down without a separate handle table.

import type { Remote } from "comlink";
import { create } from "zustand";
import { bucketFiles, type BucketError } from "./bucket";
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
  /** Drives a drop batch through bucket → per-source open → merge. */
  openFiles(files: File[]): Promise<OpenResult>;
  /** Close every loaded wasm handle and reset to the empty session. */
  clear(): Promise<void>;
  /** Test / dev seam: inject the Comlink worker proxy exactly once. */
  setWorker(worker: Remote<DataCoreApi>): void;
}

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

  return {
    sources: [],
    channels: [],
    globalRange: null,

    setWorker(w) {
      worker = w;
    },

    async openFiles(files) {
      const run = async (): Promise<OpenResult> => {
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
          set({
            sources: allSources,
            channels: allChannels,
            globalRange: mergeGlobalRange(allSources),
          });
        }

        return { opened, errors };
      };

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
        set({ sources: [], channels: [], globalRange: null });
      };
      const next = pending.then(run, run);
      pending = next.catch(() => undefined);
      await next;
    },
  };
});
