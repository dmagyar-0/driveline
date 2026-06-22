// Session-analysis helpers for the agent surface (WAL-02).
//
// `agentApi.ts` is meant to be a THIN facade — JSON-safe wrappers over store
// actions. The playback-independent read ops (`fetchChannelRange`,
// `snapshotAt`) carry real analysis logic, though: Arrow column decoding with
// the ns-as-decimal-string discipline, step-held scalar sampling, and the LiDAR
// spin lookup. That logic lives here so the facade stays thin and this code is
// unit-testable on its own.
//
// Contract (unchanged from the inline version — see docs/11-agent-interface.md):
//   - ns timestamps cross as DECIMAL STRINGS (read from the BigInt64 backing
//     buffer; `.get(i)` on a Timestamp column drops sub-ms precision).
//   - never throws for not-found / bad input — callers get null / empty so an
//     agent can probe without try/catch.

import { tableFromIPC } from "apache-arrow";
import type { useSession } from "../state/store";
import { decodeSeries } from "../panels/seriesFromArrow";
import {
  captureVideoFrameAt as captureFrameOffThread,
  type CapturedVideoFrame,
} from "./videoCapture";
import type {
  AgentColumn,
  AgentCapturedFrame,
  AgentPointCloudRef,
  AgentScalarSample,
  AgentSnapshot,
} from "./agentApi";

type SessionState = ReturnType<typeof useSession.getState>;

/** Decode an Arrow IPC payload into JSON-safe columns. 64-bit integer /
 *  timestamp columns are read from their BigInt64/BigUint64 backing buffer and
 *  stringified (per the T1.4 contract in `seriesFromArrow.ts`: `.get(i)` on a
 *  Timestamp column round-trips through Date semantics and drops sub-ms
 *  precision); float columns arrive as numbers. */
export function decodeAgentColumns(bytes: Uint8Array): {
  rows: number;
  columns: AgentColumn[];
} {
  const table = tableFromIPC(bytes);
  const columns: AgentColumn[] = table.schema.fields.map((f) => {
    const col = table.getChild(f.name);
    const values: Array<number | string | null> = [];
    if (col) {
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
}

// Largest index `i` with `times[i] <= t`, or -1 if `t` precedes the first
// entry. Binary search over an ascending ns timestamp array (spin/frame
// starts), mirroring the panels' active-frame lookup.
function activeSampleIndex(times: BigInt64Array, t: bigint): number {
  if (times.length === 0 || t < times[0]) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// The value of a scalar channel at (or just before) `t`, or null when there is
// no sample at/before `t`. Fetches the bracketing sample (`includePrev`) and
// picks the newest row whose ts <= t. Never throws (advisory snapshot helper).
async function sampleScalarAt(
  st: SessionState,
  channelId: string,
  t: bigint,
): Promise<{ ns: bigint; value: number } | null> {
  try {
    // [t, t+1) catches a sample landing exactly on t; `includePrev` adds the
    // last sample before the window so a t between samples still resolves the
    // step-held value.
    const bytes = await st.fetchChannelRange(channelId, t, t + 1n, true);
    const series = decodeSeries(bytes);
    if (!series.ok) return null;
    const { rawTsNs, ys } = series;
    let best = -1;
    for (let i = 0; i < rawTsNs.length; i++) {
      if (rawTsNs[i] <= t) best = i;
      else break;
    }
    if (best < 0) return null;
    return { ns: rawTsNs[best], value: ys[best] };
  } catch {
    return null;
  }
}

/** Project a worker-decoded frame to the JSON-safe `AgentCapturedFrame` shape
 *  (ns → decimal string). Shared by `captureVideoFrame`, `captureVideoFrameAt`,
 *  and `snapshotAt` so the ns-stringification lives in one spot. */
export function toAgentCapturedFrame(
  cap: CapturedVideoFrame,
): AgentCapturedFrame {
  return {
    channelId: cap.channelId,
    cameraName: cap.cameraName,
    ptsNs: cap.ptsNs.toString(),
    width: cap.width,
    height: cap.height,
    dataUrl: cap.dataUrl,
  };
}

/**
 * Build a complete, playback-independent snapshot of the session at `t`: the
 * decoded frame for every camera, a reference to the LiDAR spin active at `t`
 * for every point-cloud channel, every scalar's value at `t`, and the full
 * channel inventory. Always resolves a bundle (empty arrays when nothing is
 * loaded); never throws.
 */
export async function buildSnapshot(
  st: SessionState,
  t: bigint,
): Promise<AgentSnapshot> {
  const channels = st.channels;

  // Cameras: decode each video channel's frame at T, in parallel.
  const cameras = (
    await Promise.all(
      channels
        .filter((c) => c.kind === "video")
        .map((c) => captureFrameOffThread(c.id, t)),
    )
  )
    .filter((cap): cap is NonNullable<typeof cap> => cap !== null)
    .map(toAgentCapturedFrame);

  // Point clouds: reference the spin active at T (raw points stay fetchable
  // via fetchChannelRange — a spin is too large to inline).
  const pointClouds: AgentPointCloudRef[] = await Promise.all(
    channels
      .filter((c) => c.kind === "point_cloud")
      .map(async (c) => {
        let spinTsNs: string | null = null;
        try {
          const times = await st.lidarSpinTimes(c.id);
          const idx = activeSampleIndex(times, t);
          if (idx >= 0) spinTsNs = times[idx].toString();
        } catch {
          // non-lidar geometry / no spin times — leave null
        }
        return { channelId: c.id, name: c.name, spinTsNs };
      }),
  );

  // Scalars: the value of each scalar channel at (or just before) T.
  const scalars: AgentScalarSample[] = await Promise.all(
    channels
      .filter((c) => c.kind === "scalar")
      .map(async (c) => {
        const sample = await sampleScalarAt(st, c.id, t);
        return {
          channelId: c.id,
          name: c.name,
          unit: c.unit ?? null,
          sampleNs: sample ? sample.ns.toString() : null,
          value: sample ? sample.value : null,
        };
      }),
  );

  return {
    tsNs: t.toString(),
    cameras,
    pointClouds,
    scalars,
    channels: channels.map((c) => ({
      channelId: c.id,
      name: c.name,
      kind: c.kind,
    })),
  };
}
