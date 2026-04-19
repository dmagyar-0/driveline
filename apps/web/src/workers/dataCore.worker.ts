import * as Comlink from "comlink";
import init, {
  ping as wasmPing,
  fetch_range_stub,
  open_mf4,
  close_mf4,
  mf4_summary,
  mf4_fetch_range,
  open_mcap,
  close_mcap,
  mcap_summary,
  mcap_fetch_range,
  mcap_video_open,
  mcap_video_next_batch,
  mcap_video_close,
  open_mp4_sidecar,
  close_mp4_sidecar,
  mp4_sidecar_summary,
  mp4_video_open,
  mp4_video_next_batch,
  mp4_video_close,
} from "../wasm/wasm_bindings.js";

// Register the Comlink listener BEFORE awaiting wasm init. A top-level await
// here would suspend module evaluation; any messages posted by the main
// thread during that window fire on an empty listener list and are lost.
// Each API method awaits the init promise instead.
const ready = init();

export interface Mf4ChannelInfo {
  id: string;
  name: string;
  unit: string | null;
  sample_count: number;
  start_ns: bigint;
  end_ns: bigint;
}

export interface Mf4Summary {
  start_ns: bigint;
  end_ns: bigint;
  channels: Mf4ChannelInfo[];
}

export type ChannelKindWire =
  | "scalar"
  | "vector"
  | "video"
  | "enum"
  | "bytes";

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

// serde_wasm_bindgen serialises i64 as JS `number` when the value fits in a
// safe integer, otherwise it may appear as a `bigint`. The mp4 fixture uses
// ns timestamps around 1.7e18 which exceed Number.MAX_SAFE_INTEGER, so every
// summary crossing the boundary normalises through BigInt() once here. JS
// consumers always get `bigint`, matching the type declarations.
function toBig(n: unknown): bigint {
  return typeof n === "bigint" ? n : BigInt(n as number | string);
}

interface RawMf4Channel extends Omit<Mf4ChannelInfo, "start_ns" | "end_ns"> {
  start_ns: number | bigint;
  end_ns: number | bigint;
}
interface RawMf4Summary {
  start_ns: number | bigint;
  end_ns: number | bigint;
  channels: RawMf4Channel[];
}
function normaliseMf4(raw: RawMf4Summary): Mf4Summary {
  return {
    start_ns: toBig(raw.start_ns),
    end_ns: toBig(raw.end_ns),
    channels: raw.channels.map((c) => ({
      id: c.id,
      name: c.name,
      unit: c.unit,
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
interface RawMcapSummary {
  start_ns: number | bigint;
  end_ns: number | bigint;
  channels: RawMcapChannel[];
}
function normaliseMcap(raw: RawMcapSummary): McapSummary {
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
interface RawMp4Summary {
  start_ns: number | bigint;
  end_ns: number | bigint;
  channels: RawMp4Channel[];
}
function normaliseMp4(raw: RawMp4Summary): Mp4SidecarSummary {
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

export const dataCoreApi = {
  async ping(): Promise<string> {
    await ready;
    return wasmPing();
  },
  async fetchRangeStub(): Promise<Uint8Array> {
    await ready;
    return fetch_range_stub();
  },
  async openMf4(bytes: Uint8Array): Promise<number> {
    await ready;
    return open_mf4(bytes);
  },
  async closeMf4(handle: number): Promise<void> {
    await ready;
    close_mf4(handle);
  },
  async mf4Summary(handle: number): Promise<Mf4Summary> {
    await ready;
    return normaliseMf4(mf4_summary(handle) as RawMf4Summary);
  },
  async mf4FetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
    maxPoints: number | undefined,
  ): Promise<Uint8Array> {
    await ready;
    return mf4_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
      maxPoints,
    );
  },
  async openMcap(bytes: Uint8Array): Promise<number> {
    await ready;
    return open_mcap(bytes);
  },
  async closeMcap(handle: number): Promise<void> {
    await ready;
    close_mcap(handle);
  },
  async mcapSummary(handle: number): Promise<McapSummary> {
    await ready;
    return normaliseMcap(mcap_summary(handle) as RawMcapSummary);
  },
  async mcapFetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
    maxPoints: number | undefined,
  ): Promise<Uint8Array> {
    await ready;
    return mcap_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
      maxPoints,
    );
  },
  async openMp4Sidecar(
    mp4Bytes: Uint8Array,
    sidecarBytes: Uint8Array,
  ): Promise<number> {
    await ready;
    return open_mp4_sidecar(mp4Bytes, sidecarBytes);
  },
  async closeMp4Sidecar(handle: number): Promise<void> {
    await ready;
    close_mp4_sidecar(handle);
  },
  async mp4SidecarSummary(handle: number): Promise<Mp4SidecarSummary> {
    await ready;
    return normaliseMp4(mp4_sidecar_summary(handle) as RawMp4Summary);
  },
  async openMcapVideoStream(
    handle: number,
    channelId: string,
    fromPtsNs: bigint,
  ): Promise<number> {
    await ready;
    return mcap_video_open(handle, channelId, fromPtsNs);
  },
  async mcapVideoNextBatch(
    streamId: number,
    maxN: number,
  ): Promise<EncodedChunkWire[]> {
    await ready;
    const raw = mcap_video_next_batch(streamId, maxN) as RawEncodedChunk[];
    return raw.map((c) => ({
      pts_ns: toBig(c.pts_ns),
      is_keyframe: !!c.is_keyframe,
      data: c.data,
    }));
  },
  async closeMcapVideoStream(streamId: number): Promise<void> {
    await ready;
    mcap_video_close(streamId);
  },
  async openMp4VideoStream(
    handle: number,
    channelId: string,
    fromPtsNs: bigint,
  ): Promise<number> {
    await ready;
    return mp4_video_open(handle, channelId, fromPtsNs);
  },
  async mp4VideoNextBatch(
    streamId: number,
    maxN: number,
  ): Promise<EncodedChunkWire[]> {
    await ready;
    const raw = mp4_video_next_batch(streamId, maxN) as RawEncodedChunk[];
    return raw.map((c) => ({
      pts_ns: toBig(c.pts_ns),
      is_keyframe: !!c.is_keyframe,
      data: c.data,
    }));
  },
  async closeMp4VideoStream(streamId: number): Promise<void> {
    await ready;
    mp4_video_close(streamId);
  },
};

interface RawEncodedChunk {
  pts_ns: number | bigint;
  is_keyframe: boolean;
  data: Uint8Array;
}

export type DataCoreApi = typeof dataCoreApi;

Comlink.expose(dataCoreApi);
