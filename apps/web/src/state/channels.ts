// Pure source/channel construction helpers, extracted from `store.ts`
// (STATE-01). These map a wasm reader `*Summary` into the flat `Channel[]`
// the store holds, compute the union `globalRange`, mint unique source ids,
// and build an inline (agent-pushed) source from its spec. No store, no
// worker — every function is a pure transform over its arguments, so they are
// unit-testable in isolation and the factory in `store.ts` just calls them.
//
// CRITICAL: `start_ns`/`end_ns` flow straight through as `bigint`; never
// narrow a timestamp to `Number`.

import type {
  McapSummary,
  Mf4Summary,
  Mp4SidecarSummary,
} from "../workerClient";
import type { InlineChannelData } from "./inlineSource";
import {
  qualifiedChannelId,
  type Channel,
  type ChannelKind,
  type InlineSourceSpec,
  type SourceKind,
  type SourceMeta,
  type TimeRange,
} from "./types";

export function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
export function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

// Source kinds that are STATIC / config layers, not part of the playable
// timeline. They either carry no time (`calibration`, an empty `[0, 0]`) or a
// purely cosmetic single-frame placeholder anchored at ts 0 (`map_geometry`,
// e.g. `[0, 33ms]`). Folding either into the union would drag `startNs` to the
// epoch: combined with epoch-scale sensor data (~1.7e18 ns), the resulting
// `[0, 1.7e18]` span blows past `Number.MAX_SAFE_INTEGER`, so every pixel
// projection that does `Number(off) / Number(span)` (the Transport scrubber's
// `percentOf`/`nsFromRatio`, the plot's `cursorXPx`) collapses to the right
// edge and playback looks frozen / unscrubbable. These kinds never define the
// global range; the real sensor sources do.
const CONFIG_SOURCE_KINDS: ReadonlySet<SourceKind> = new Set([
  "calibration",
  "map_geometry",
]);

export function mergeGlobalRange(sources: SourceMeta[]): TimeRange | null {
  // Only sources that (a) are NOT a static/config layer and (b) carry a real,
  // non-empty span define the playable timeline. The kind guard is what stops
  // a static `map_geometry` frame at `[0, 33ms]` from surviving the span check
  // and pulling the timeline start down to the epoch.
  const spanned = sources.filter(
    (s) =>
      !CONFIG_SOURCE_KINDS.has(s.kind) &&
      s.timeRange.endNs > s.timeRange.startNs,
  );
  if (spanned.length === 0) return null;
  let start = spanned[0].timeRange.startNs;
  let end = spanned[0].timeRange.endNs;
  for (let i = 1; i < spanned.length; i++) {
    start = bigMin(start, spanned[i].timeRange.startNs);
    end = bigMax(end, spanned[i].timeRange.endNs);
  }
  return { startNs: start, endNs: end };
}

export function uniqueSourceId(base: string, existing: SourceMeta[]): string {
  if (!existing.some((s) => s.id === base)) return base;
  let n = 2;
  while (existing.some((s) => s.id === `${base} (${n})`)) n++;
  return `${base} (${n})`;
}

export function mcapChannels(sourceId: string, s: McapSummary): Channel[] {
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

// Shared shape for every "simple" channel builder. The wasm readers emit one
// kind of channel per source, so the JS side hardcodes the `kind`/`dtype` here
// rather than widening the summary. Each builder differs only by that
// kind/dtype pair and whether it carries the per-channel `group`/`unit`
// (scalar sources do; the scene/video kinds force both to `null`). MCAP is the
// lone exception — its channels carry per-channel kind/dtype — so it keeps its
// own specialization above.
type ChannelKindDefaults = {
  kind: ChannelKind;
  dtype: string | null;
  // When true, carry the summary's per-channel `group`/`unit`; otherwise force
  // both to `null` (matches the scene/video builders).
  carryGroupUnit?: boolean;
};

// Common shape across every "simple" summary: the id/name/count/range fields
// each builder reads. `group`/`unit` are optional so the mp4 sidecar channel
// (which carries neither) and the MF4-shaped channel (which carries both) both
// fit; the `carryGroupUnit` flag decides whether to surface them.
type SummaryChannel = {
  id: string;
  name: string;
  group?: string | null;
  unit?: string | null;
  sample_count: number;
  start_ns: bigint;
  end_ns: bigint;
};

function channelsFromSummary(
  sourceId: string,
  s: { channels: readonly SummaryChannel[] },
  { kind, dtype, carryGroupUnit = false }: ChannelKindDefaults,
): Channel[] {
  return s.channels.map((c) => ({
    id: qualifiedChannelId(sourceId, c.id),
    nativeId: c.id,
    sourceId,
    name: c.name,
    group: carryGroupUnit ? (c.group ?? null) : null,
    kind,
    dtype,
    unit: carryGroupUnit ? (c.unit ?? null) : null,
    sampleCount: c.sample_count,
    timeRange: { startNs: c.start_ns, endNs: c.end_ns },
  }));
}

// Readers currently emit one kind per source: Mf4Reader always yields scalar
// F64 channels, carrying the per-channel group/unit.
export function mf4Channels(sourceId: string, s: Mf4Summary): Channel[] {
  return channelsFromSummary(sourceId, s, {
    kind: "scalar",
    dtype: "f64",
    carryGroupUnit: true,
  });
}
// Tabular (CSV / Parquet) summaries arrive in the MF4 shape — one scalar F64
// channel per surfaced numeric column — so the channel mapping mirrors
// `mf4Channels`. Building these the same way is what makes a tabular source
// indistinguishable to the panels (Plot/Table/Map/Value/Enum all consume the
// flat `channels` list and the ranged `fetchChannelRange` path).
export function tabularChannels(sourceId: string, s: Mf4Summary): Channel[] {
  return channelsFromSummary(sourceId, s, {
    kind: "scalar",
    dtype: "f64",
    carryGroupUnit: true,
  });
}
export function mp4Channels(sourceId: string, s: Mp4SidecarSummary): Channel[] {
  return channelsFromSummary(sourceId, s, { kind: "video", dtype: null });
}
// Point-cloud (LiDAR) summaries arrive in the MF4 shape — the reader emits a
// single channel — so the mapping mirrors `mf4Channels` but hardcodes the
// `point_cloud` kind so the ScenePanel/PanelDrawer route it to the 3D scene
// pipeline rather than a plot. `sample_count` carries peak points-per-spin.
export function lidarChannels(sourceId: string, s: Mf4Summary): Channel[] {
  return channelsFromSummary(sourceId, s, {
    kind: "point_cloud",
    dtype: null,
  });
}
// OpenLABEL summaries arrive in the same MF4 shape as LiDAR (a single channel,
// `sample_count` = peak boxes/frame). Mirrors `lidarChannels` but hardcodes the
// `bounding_box` kind so the ScenePanel/PanelDrawer route it to the 3D scene
// pipeline as wireframe boxes rather than a plot or a point cloud.
export function openLabelChannels(sourceId: string, s: Mf4Summary): Channel[] {
  return channelsFromSummary(sourceId, s, {
    kind: "bounding_box",
    dtype: null,
  });
}
// Trajectory summaries arrive in the same MF4 shape as LiDAR/OpenLABEL (a
// single channel, `sample_count` = peak paths/frame). Mirrors
// `openLabelChannels` but hardcodes the `trajectory` kind so the
// ScenePanel/PanelDrawer route it to the 3D scene pipeline as predicted
// polylines.
export function trajectoryChannels(sourceId: string, s: Mf4Summary): Channel[] {
  return channelsFromSummary(sourceId, s, {
    kind: "trajectory",
    dtype: null,
  });
}
// Map-geometry summaries arrive in the same MF4 shape as LiDAR/OpenLABEL/
// trajectory (a single channel, `sample_count` = polyline count). Mirrors
// `trajectoryChannels` but hardcodes the `map_geometry` kind so the
// ScenePanel/PanelDrawer route it to the 3D scene pipeline as road polylines.
export function mapGeometryChannels(
  sourceId: string,
  s: Mf4Summary,
): Channel[] {
  return channelsFromSummary(sourceId, s, {
    kind: "map_geometry",
    dtype: null,
  });
}

// Calibration summaries arrive in the same MF4 shape (a single channel,
// `sample_count` = camera count). Mirrors `lidarChannels`/`openLabelChannels`
// but hardcodes the `camera_calibration` kind so the PanelDrawer/overlay picker
// route it to the point-cloud-on-video overlay rather than a plot. Calibration
// is config, not a time series — `timeRange` mirrors the summary's bounds (the
// reader emits a degenerate range) and is never used for fetching.
export function calibrationChannels(
  sourceId: string,
  s: Mf4Summary,
): Channel[] {
  return channelsFromSummary(sourceId, s, {
    kind: "camera_calibration",
    dtype: null,
  });
}

// Validate + build an inline (agent-pushed) source from its spec: parse every
// decimal-string timestamp to `bigint`, enforce equal-length non-decreasing
// columns, and produce the `SourceMeta` (synthetic handle, `kind: "inline"`),
// the per-channel columnar storage, and the qualified channel id/name list the
// API returns. Returns `null` on ANY violation (never throws) so the agent
// surface can probe without try/catch. Leading-slash the displayed channel name
// (matching how MCAP topics surface) so the Channels tree splits on `/`.
export function buildInlineSource(
  spec: InlineSourceSpec,
  existing: SourceMeta[],
): {
  source: SourceMeta;
  data: Map<string, InlineChannelData>;
  channels: Array<{ id: string; name: string }>;
} | null {
  if (
    spec === null ||
    typeof spec !== "object" ||
    typeof spec.name !== "string" ||
    spec.name.trim().length === 0 ||
    !Array.isArray(spec.channels) ||
    spec.channels.length === 0
  ) {
    return null;
  }

  const sourceId = uniqueSourceId(spec.name.trim(), existing);
  const data = new Map<string, InlineChannelData>();
  const channels: Channel[] = [];
  const channelOut: Array<{ id: string; name: string }> = [];
  const seenNative = new Set<string>();

  let srcStart: bigint | null = null;
  let srcEnd: bigint | null = null;

  for (const c of spec.channels) {
    if (
      c === null ||
      typeof c !== "object" ||
      typeof c.name !== "string" ||
      c.name.trim().length === 0 ||
      !Array.isArray(c.timestampsNs) ||
      !Array.isArray(c.values) ||
      c.timestampsNs.length === 0 ||
      c.timestampsNs.length !== c.values.length
    ) {
      return null;
    }
    const kind = c.kind === "enum" ? "enum" : "scalar";
    // The native id is the raw channel name; uniqueness within the source keeps
    // `qualifiedChannelId` injective and the storage map keyed cleanly.
    const nativeName = c.name.trim();
    if (seenNative.has(nativeName)) return null;
    seenNative.add(nativeName);

    const n = c.timestampsNs.length;
    const tsNs = new BigInt64Array(n);
    let prev: bigint | null = null;
    for (let i = 0; i < n; i++) {
      const raw = c.timestampsNs[i];
      if (typeof raw !== "string") return null;
      let v: bigint;
      try {
        v = BigInt(raw);
      } catch {
        return null;
      }
      if (prev !== null && v < prev) return null; // must be non-decreasing
      tsNs[i] = v;
      prev = v;
    }
    for (let i = 0; i < n; i++) {
      if (typeof c.values[i] !== "number") return null;
    }
    const values =
      kind === "enum"
        ? Int32Array.from(c.values, (x) => x | 0)
        : Float64Array.from(c.values);

    data.set(nativeName, { kind, tsNs, values });

    const chStart = tsNs[0];
    const chEnd = tsNs[n - 1];
    srcStart = srcStart === null ? chStart : bigMin(srcStart, chStart);
    srcEnd = srcEnd === null ? chEnd : bigMax(srcEnd, chEnd);

    // Display name leading-slashed so the Channels tree splits it like a topic.
    const displayName = nativeName.startsWith("/")
      ? nativeName
      : `/${nativeName}`;
    const id = qualifiedChannelId(sourceId, nativeName);
    channels.push({
      id,
      nativeId: nativeName,
      sourceId,
      name: displayName,
      group: null,
      kind,
      dtype: kind === "enum" ? "i32" : "f64",
      unit: typeof c.unit === "string" && c.unit.length > 0 ? c.unit : null,
      sampleCount: n,
      timeRange: { startNs: chStart, endNs: chEnd },
    });
    channelOut.push({ id, name: displayName });
  }

  if (srcStart === null || srcEnd === null) return null;

  const source: SourceMeta = {
    id: sourceId,
    kind: "inline",
    name: sourceId,
    handle: -1, // synthetic: inline sources hold no wasm slab handle
    timeRange: { startNs: srcStart, endNs: srcEnd },
    channels,
    timeOffsetNs: 0n,
  };
  return { source, data, channels: channelOut };
}
