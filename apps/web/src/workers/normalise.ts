// Pure normalisation helpers extracted from `dataCore.worker.ts` so vitest
// can exercise the `number` ↔ `bigint` boundary directly. The worker module
// itself triggers wasm `init()` and `Comlink.expose()` at evaluation, which
// makes it awkward to import from a test; the logic below has no side
// effects and can be imported from either side.
//
// serde_wasm_bindgen serialises an i64 as JS `number` when the value fits
// in `Number.MAX_SAFE_INTEGER` and as `bigint` otherwise. The mp4 fixture
// uses ns timestamps around 1.7e18, so every summary and every pulled
// video chunk crosses the boundary — `toBig` normalises through `BigInt()`
// once so consumers always see `bigint`.

export type ChannelKindWire =
  | "scalar"
  | "vector"
  | "video"
  | "enum"
  | "bytes"
  | "point_cloud";

export interface Mf4ChannelInfo {
  id: string;
  name: string;
  unit: string | null;
  /** Channel-group label, used to nest MF4 channels under their group in
   *  the Channels tree. `null` when the reader could not resolve one. */
  group: string | null;
  sample_count: number;
  start_ns: bigint;
  end_ns: bigint;
}

export interface Mf4Summary {
  start_ns: bigint;
  end_ns: bigint;
  channels: Mf4ChannelInfo[];
}

export interface McapChannelInfo {
  id: string;
  name: string;
  kind: ChannelKindWire;
  dtype: string | null;
  unit: string | null;
  sample_count: number;
  start_ns: bigint;
  end_ns: bigint;
}

export interface McapSummary {
  start_ns: bigint;
  end_ns: bigint;
  channels: McapChannelInfo[];
}

export interface Mp4SidecarChannelInfo {
  id: string;
  name: string;
  sample_count: number;
  start_ns: bigint;
  end_ns: bigint;
}

export interface Mp4SidecarSummary {
  start_ns: bigint;
  end_ns: bigint;
  channels: Mp4SidecarChannelInfo[];
}

/// One encoded access unit pulled from a video stream. Annex-B framing per
/// the MCAP `foxglove.CompressedVideo` payload; the TS video-decode worker
/// feeds these directly to `VideoDecoder.decode`.
export interface EncodedChunkWire {
  pts_ns: bigint;
  is_keyframe: boolean;
  data: Uint8Array;
}

export function toBig(n: unknown): bigint {
  return typeof n === "bigint" ? n : BigInt(n as number | string);
}

interface RawMf4Channel
  extends Omit<Mf4ChannelInfo, "start_ns" | "end_ns" | "group"> {
  // serde_wasm_bindgen serialises `Option::None` as `undefined`, so the
  // field may be absent on the wire; `normaliseMf4` coalesces it to `null`.
  group?: string | null;
  start_ns: number | bigint;
  end_ns: number | bigint;
}
export interface RawMf4Summary {
  start_ns: number | bigint;
  end_ns: number | bigint;
  channels: RawMf4Channel[];
}

export function normaliseMf4(raw: RawMf4Summary): Mf4Summary {
  return {
    start_ns: toBig(raw.start_ns),
    end_ns: toBig(raw.end_ns),
    channels: raw.channels.map((c) => ({
      id: c.id,
      name: c.name,
      unit: c.unit,
      group: c.group ?? null,
      sample_count: Number(c.sample_count),
      start_ns: toBig(c.start_ns),
      end_ns: toBig(c.end_ns),
    })),
  };
}

interface RawMcapChannel extends Omit<McapChannelInfo, "start_ns" | "end_ns"> {
  start_ns: number | bigint;
  end_ns: number | bigint;
}
export interface RawMcapSummary {
  start_ns: number | bigint;
  end_ns: number | bigint;
  channels: RawMcapChannel[];
}

export function normaliseMcap(raw: RawMcapSummary): McapSummary {
  return {
    start_ns: toBig(raw.start_ns),
    end_ns: toBig(raw.end_ns),
    channels: raw.channels.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      dtype: c.dtype,
      unit: c.unit,
      sample_count: Number(c.sample_count),
      start_ns: toBig(c.start_ns),
      end_ns: toBig(c.end_ns),
    })),
  };
}

interface RawMp4Channel
  extends Omit<Mp4SidecarChannelInfo, "start_ns" | "end_ns"> {
  start_ns: number | bigint;
  end_ns: number | bigint;
}
export interface RawMp4Summary {
  start_ns: number | bigint;
  end_ns: number | bigint;
  channels: RawMp4Channel[];
}

export function normaliseMp4(raw: RawMp4Summary): Mp4SidecarSummary {
  return {
    start_ns: toBig(raw.start_ns),
    end_ns: toBig(raw.end_ns),
    channels: raw.channels.map((c) => ({
      id: c.id,
      name: c.name,
      sample_count: Number(c.sample_count),
      start_ns: toBig(c.start_ns),
      end_ns: toBig(c.end_ns),
    })),
  };
}

export interface RawEncodedChunk {
  pts_ns: number | bigint;
  is_keyframe: boolean;
  data: Uint8Array;
}

export function normaliseEncodedChunk(raw: RawEncodedChunk): EncodedChunkWire {
  return {
    pts_ns: toBig(raw.pts_ns),
    is_keyframe: !!raw.is_keyframe,
    data: raw.data,
  };
}
