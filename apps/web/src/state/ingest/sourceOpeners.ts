// Eager source-open dispatch table (STATE-02).
//
// `openFiles` historically ran ~11 copy-paste `for (const f of buckets.X)`
// loops, each: call the matching `w.open*` worker method → fetch the summary →
// build the channel list → push a `SourceMeta`. The only things that varied
// per kind were (a) which worker open/summary methods to call and (b) which
// channel builder + `SourceMeta.kind` to use. This module collapses the
// uniform openers into a single `SOURCE_OPENERS` table keyed by the bucket
// name, mirroring the `FETCH_RANGE_BY_KIND` / `CLOSE_METHOD_BY_KIND` dispatch
// tables the audit praises.
//
// The two non-uniform paths stay in `store.ts`:
//   - `mp4Pairs` / video-binding: needs header-byte slicing, an `Mp4SampleCache`
//     plus its loaded-range / pending-fetch subscriptions, and a parallel
//     summary+index fetch.
//   - `unknown` / recipe: needs the Format-Registry match + stale-recipe gate.
// Both have genuinely distinct control flow, so forcing them into the table
// would obscure more than it shares.
//
// Each opener is a thin async shim over the worker proxy; no business logic
// (bucket sniffing, id minting, range merging, error capture) lives here — the
// caller in `store.ts` still owns the surrounding loop, `uniqueSourceId`, and
// the try/catch that records `BucketError`s. CRITICAL: `start_ns`/`end_ns`
// flow straight through as `bigint`; never narrow a timestamp to `Number`.

import type { Remote } from "comlink";
import type { DataCoreApi } from "../../workerClient";
import {
  calibrationChannels,
  lidarChannels,
  mapGeometryChannels,
  mcapChannels,
  mf4Channels,
  openLabelChannels,
  trajectoryChannels,
} from "../channels";
import type { Channel, SourceKind, TimeRange } from "../types";

/** What an opener produces for a single file: everything the caller needs to
 *  assemble the `SourceMeta` (it adds the id/name/`timeOffsetNs: 0n` itself). */
export interface OpenedSource {
  kind: SourceKind;
  handle: number;
  timeRange: TimeRange;
  channels: Channel[];
}

/**
 * One eager opener: open the file in the worker, fetch its summary, and build
 * the `Channel[]`. `format` is only meaningful for the lidar bucket (where a
 * `.pcd` / raw-Alpamayo / Driveline parquet pick a different worker open
 * method); other openers ignore it.
 */
export type SourceOpener = (
  w: Remote<DataCoreApi>,
  file: File,
  sourceId: string,
  format?: string,
) => Promise<OpenedSource>;

/**
 * Bucket name → eager opener. Keyed by the `bucketFiles` bucket the file
 * landed in (not by `SourceKind`) because `openFiles` iterates buckets; the
 * resulting `OpenedSource.kind` is the `SourceKind` the table hardcodes per
 * opener.
 */
export const SOURCE_OPENERS = {
  // Pass the `File` itself, not its bytes: the worker copies it into OPFS
  // (streamed) and reads the summary + chunks lazily via a sync access handle,
  // so a multi-gigabyte MCAP is never held in memory.
  mcap: async (w, file, sourceId) => {
    const handle = await w.openMcap(file);
    const summary = await w.mcapSummary(handle);
    return {
      kind: "mcap",
      handle,
      timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
      channels: mcapChannels(sourceId, summary),
    };
  },
  // ROS 1 bags open whole-file in wasm memory (no OPFS/ranged path). Pass the
  // `File` directly — the worker reads it there, so no structured-clone of the
  // full bytes crosses the Comlink boundary. ROS summaries reuse the MCAP
  // channel shape (per-channel kind/dtype).
  ros1: async (w, file, sourceId) => {
    const handle = await w.openRos1Bag(file);
    const summary = await w.ros1BagSummary(handle);
    return {
      kind: "ros1",
      handle,
      timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
      channels: mcapChannels(sourceId, summary),
    };
  },
  // ROS 2 rosbag2 `.db3` bags open whole-file in wasm memory (no OPFS/ranged
  // path). Pass the `File` directly; no full-file clone crosses the boundary.
  ros2db3: async (w, file, sourceId) => {
    const handle = await w.openRos2Db3(file);
    const summary = await w.ros2Db3Summary(handle);
    return {
      kind: "ros2db3",
      handle,
      timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
      channels: mcapChannels(sourceId, summary),
    };
  },
  // Pass the `File` itself, not its bytes: the worker copies it into OPFS
  // (streamed) and reads channels lazily via a sync access handle, so a
  // multi-gigabyte MF4 is never held in memory. Only plotted signals are
  // decoded and retained.
  mf4: async (w, file, sourceId) => {
    const handle = await w.openMf4(file);
    const summary = await w.mf4Summary(handle);
    return {
      kind: "mf4",
      handle,
      timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
      channels: mf4Channels(sourceId, summary),
    };
  },
  // Point-cloud sources open eagerly: decoded into per-spin buffers in wasm.
  // Pass the `File` directly — the worker reads it there so no full-file clone
  // crosses the Comlink boundary. A Driveline point-cloud parquet carries many
  // spins; a `.pcd` carries a single cloud; a raw Alpamayo parquet is
  // Draco-decoded in-browser — all three surface as `kind: "lidar"`.
  lidar: async (w, file, sourceId, format) => {
    const handle =
      format === "pcd"
        ? await w.openLidarPcd(file)
        : format === "alpamayo"
          ? await w.openAlpamayoLidar(file)
          : await w.openLidar(file);
    const summary = await w.lidarSummary(handle);
    return {
      kind: "lidar",
      handle,
      timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
      channels: lidarChannels(sourceId, summary),
    };
  },
  // OpenLABEL annotation sources open eagerly: the JSON is decoded into
  // per-frame box buffers in wasm. Surfaces as a single `kind: "openlabel"`
  // source with one `bounding_box` channel, routed to the 3D scene pipeline as
  // wireframe boxes.
  openlabel: async (w, file, sourceId) => {
    const handle = await w.openOpenlabel(file);
    const summary = await w.openlabelSummary(handle);
    return {
      kind: "openlabel",
      handle,
      timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
      channels: openLabelChannels(sourceId, summary),
    };
  },
  // Camera-calibration sources open eagerly: the wasm reader validates the
  // `driveline.calibration/v1` marker and owns the decoded cameras for the
  // source's lifetime. Surfaces as a single `kind: "calibration"` source with
  // one `camera_calibration` channel carrying every camera (one row each on
  // fetch), routed to the point-cloud-on-video overlay rather than a plot.
  calibration: async (w, file, sourceId) => {
    const handle = await w.openCalibration(file);
    const summary = await w.calibrationSummary(handle);
    return {
      kind: "calibration",
      handle,
      timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
      channels: calibrationChannels(sourceId, summary),
    };
  },
  // Trajectory sources open eagerly: the JSON is decoded into per-frame
  // polyline buffers in wasm. Surfaces as a single `kind: "trajectory"` source
  // with one `trajectory` channel, routed to the 3D scene pipeline as predicted
  // polylines.
  trajectory: async (w, file, sourceId) => {
    const handle = await w.openTrajectory(file);
    const summary = await w.trajectorySummary(handle);
    return {
      kind: "trajectory",
      handle,
      timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
      channels: trajectoryChannels(sourceId, summary),
    };
  },
  // Map-geometry sources open eagerly: the reader auto-detects OpenDRIVE
  // (`.xodr`) vs the simple `drivelineMap` JSON and decodes every polyline into
  // a single static frame in wasm. Surfaces as a single `kind: "map_geometry"`
  // source with one `map_geometry` channel, routed to the 3D scene pipeline as
  // road polylines coloured by feature type.
  mapGeometry: async (w, file, sourceId) => {
    const handle = await w.openMapGeometry(file);
    const summary = await w.mapGeometrySummary(handle);
    return {
      kind: "map_geometry",
      handle,
      timeRange: { startNs: summary.start_ns, endNs: summary.end_ns },
      channels: mapGeometryChannels(sourceId, summary),
    };
  },
} satisfies Record<string, SourceOpener>;
