import * as Comlink from "comlink";
import init, {
  ping as wasmPing,
  fetch_range_stub,
  open_mf4_ranged,
  close_mf4,
  mf4_release_channel,
  mf4_summary,
  mf4_fetch_range,
  open_mcap,
  open_mcap_ranged,
  close_mcap,
  mcap_summary,
  mcap_fetch_range,
  mcap_video_open,
  mcap_video_next_batch,
  mcap_video_close,
  open_mp4_sidecar,
  close_mp4_sidecar,
  mp4_sidecar_summary,
  mp4_sidecar_index,
  tabular_inspect,
  open_tabular,
  tabular_summary,
  tabular_fetch_range,
  tabular_time_column_ns,
  close_tabular,
  open_lidar,
  open_lidar_pcd,
  open_alpamayo_lidar,
  lidar_summary,
  lidar_fetch_range,
  lidar_spin_times,
  close_lidar,
  open_openlabel,
  close_openlabel,
  openlabel_summary,
  openlabel_fetch_range,
  openlabel_frame_times,
  open_calibration,
  close_calibration,
  calibration_summary,
  calibration_fetch_range,
  open_trajectory,
  close_trajectory,
  trajectory_summary,
  trajectory_fetch_range,
  trajectory_frame_times,
  open_map_geometry,
  close_map_geometry,
  map_geometry_summary,
  map_geometry_fetch_range,
  map_geometry_frame_times,
  open_ros1_bag,
  close_ros1_bag,
  ros1_bag_summary,
  ros1_bag_fetch_range,
  open_ros2_db3,
  close_ros2_db3,
  ros2_db3_summary,
  ros2_db3_fetch_range,
  recipe_dry_run,
  open_recipe,
  recipe_summary,
  recipe_fetch_range,
  close_recipe,
} from "../wasm/wasm_bindings.js";
import {
  normaliseEncodedChunk,
  normaliseMcap,
  normaliseMf4,
  normaliseMp4,
  type EncodedChunkWire,
  type McapSummary,
  type Mf4Summary,
  type Mp4SidecarSummary,
  type RawEncodedChunk,
  type RawMcapSummary,
  type RawMf4Summary,
  type RawMp4Summary,
} from "./normalise";
import type { RawTabularSchema } from "../state/tabularImport";
import type { RawRecipeDryRunReport } from "../state/recipe";
import { UrlFetchBlockedError, urlProbeSize, urlReadRange } from "./urlRange";

/**
 * Per-sample table for an mp4+sidecar source. Returned by
 * `mp4SidecarIndex` and consumed by `Mp4SampleCache` (JS-side) to map
 * `(sampleIdx) → (offset, size, is_sync, pts_ns)` for lazy reads from the
 * source `File` blob. `sps`/`pps` are the raw NAL bytes (no start-code
 * prefix) the JS-side stream prepends to the first emitted Annex-B chunk.
 */
export interface Mp4SidecarIndex {
  channelId: string;
  ptsNs: BigInt64Array;
  offsets: BigUint64Array;
  sizes: Uint32Array;
  isSync: Uint8Array;
  sps: Uint8Array;
  pps: Uint8Array;
}

interface RawMp4SidecarIndex {
  channel_id: string;
  pts_ns: BigInt64Array;
  offsets: BigUint64Array;
  sizes: Uint32Array;
  is_sync: Uint8Array;
  sps: Uint8Array;
  pps: Uint8Array;
}

function normaliseMp4Index(raw: RawMp4SidecarIndex): Mp4SidecarIndex {
  return {
    channelId: raw.channel_id,
    ptsNs: raw.pts_ns,
    offsets: raw.offsets,
    sizes: raw.sizes,
    isSync: raw.is_sync,
    sps: raw.sps,
    pps: raw.pps,
  };
}

// Re-export the wire types so existing `workerClient` imports keep working.
export type {
  ChannelKindWire,
  EncodedChunkWire,
  McapChannelInfo,
  McapSummary,
  Mf4ChannelInfo,
  Mf4Summary,
  Mp4SidecarChannelInfo,
  Mp4SidecarSummary,
} from "./normalise";

// Register the Comlink listener BEFORE awaiting wasm init. A top-level await
// here would suspend module evaluation; any messages posted by the main
// thread during that window fire on an empty listener list and are lost.
// Each API method awaits the init promise instead.
const ready = init();

/**
 * Lazy-read backing for MF4 sources.
 *
 * MF4 decoding happens synchronously inside wasm, so we can't feed it the
 * async `File.slice()` the mp4 path uses. Instead we copy the dropped file
 * into the Origin Private File System (streamed — never fully in memory) and
 * open a `FileSystemSyncAccessHandle`, the only browser primitive offering
 * *synchronous* ranged reads. wasm calls back into `readRange` per data block,
 * so a multi-gigabyte file is read on demand and never materialised in memory.
 *
 * Keyed by the wasm reader handle so `closeMf4` can release the sync handle
 * and delete the OPFS copy.
 */
interface Mf4Backing {
  access: FileSystemSyncAccessHandle;
  fileName: string;
}
const mf4Backings = new Map<number, Mf4Backing>();
const MF4_OPFS_DIR = "mf4-lazy";

async function mf4OpfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(MF4_OPFS_DIR, { create: true });
}

/**
 * Lazy-read backing for dropped MCAP sources — same shape as `Mf4Backing`.
 * MCAP decoding is synchronous inside wasm, so a dropped `.mcap` is streamed
 * into OPFS and read through a `FileSystemSyncAccessHandle`; only the summary
 * is read at open and chunks stream on demand, so a multi-gigabyte file is
 * never held in memory. Keyed by the wasm reader handle.
 */
interface McapBacking {
  access: FileSystemSyncAccessHandle;
  fileName: string;
}
const mcapBackings = new Map<number, McapBacking>();
const MCAP_OPFS_DIR = "mcap-lazy";

async function mcapOpfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(MCAP_OPFS_DIR, { create: true });
}

/**
 * Stream `file` into a fresh OPFS entry under `mcap-lazy` and return a
 * synchronous access handle plus the entry name.
 */
async function openMcapSyncAccess(
  file: File,
): Promise<{ access: FileSystemSyncAccessHandle; fileName: string }> {
  const dir = await mcapOpfsDir();
  const fileName = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}.mcap`;
  const fh = await dir.getFileHandle(fileName, { create: true });
  const writable = await fh.createWritable();
  await file.stream().pipeTo(writable);
  const access = await fh.createSyncAccessHandle();
  return { access, fileName };
}

/**
 * Stream `file` into a fresh OPFS entry and return a synchronous access
 * handle plus the entry name. The copy uses a streaming pipe, so peak memory
 * is one chunk rather than the whole file.
 */
async function openMf4SyncAccess(
  file: File,
): Promise<{ access: FileSystemSyncAccessHandle; fileName: string }> {
  const dir = await mf4OpfsDir();
  // Unique per source so concurrently-open files don't collide.
  const fileName = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}.mf4`;
  const fh = await dir.getFileHandle(fileName, { create: true });
  const writable = await fh.createWritable();
  await file.stream().pipeTo(writable);
  const access = await fh.createSyncAccessHandle();
  return { access, fileName };
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
  async openMf4(file: File): Promise<number> {
    await ready;
    const { access, fileName } = await openMf4SyncAccess(file);
    // Synchronous range read serviced from the OPFS sync handle. wasm invokes
    // this once per data block while decoding a channel.
    const readRange = (offset: number, length: number): Uint8Array => {
      const buf = new Uint8Array(length);
      const got = access.read(buf, { at: offset });
      if (got !== length) {
        throw new Error(
          `mf4 readRange short read at ${offset}: wanted ${length}, got ${got}`,
        );
      }
      return buf;
    };
    let handle: number;
    try {
      handle = open_mf4_ranged(readRange, file.size);
    } catch (e) {
      // Opening failed — don't leak the OPFS copy or the sync handle.
      access.close();
      try {
        const dir = await mf4OpfsDir();
        await dir.removeEntry(fileName);
      } catch {
        /* best-effort cleanup */
      }
      throw e;
    }
    mf4Backings.set(handle, { access, fileName });
    return handle;
  },
  /**
   * Open an MF4 straight from a URL, reading it lazily over HTTP range
   * requests via the index — no full download, no OPFS copy. Memory stays
   * bounded exactly like the dropped-file path; the bytes for a channel are
   * only fetched when that channel is plotted. Requires a server that
   * honours `Range` (CORS-enabled if cross-origin). Nothing is registered in
   * `mf4Backings` — there's no OPFS entry or sync handle to release, so
   * `closeMf4` just frees the wasm reader.
   */
  async openMf4Url(url: string): Promise<number> {
    await ready;
    const fileSize = urlProbeSize(url);
    const readRange = (offset: number, length: number): Uint8Array =>
      urlReadRange(url, offset, length);
    return open_mf4_ranged(readRange, fileSize);
  },
  async closeMf4(handle: number): Promise<void> {
    await ready;
    close_mf4(handle);
    const backing = mf4Backings.get(handle);
    if (backing) {
      mf4Backings.delete(handle);
      backing.access.close();
      try {
        const dir = await mf4OpfsDir();
        await dir.removeEntry(backing.fileName);
      } catch {
        /* best-effort: the OPFS entry may already be gone */
      }
    }
  },
  async releaseMf4Channel(handle: number, channelId: string): Promise<void> {
    await ready;
    mf4_release_channel(handle, channelId);
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
  ): Promise<Uint8Array> {
    await ready;
    const buf = mf4_fetch_range(handle, channelId, startNs, endNs, includePrev);
    // Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
    return Comlink.transfer(buf, [buf.buffer]);
  },
  /**
   * Open a dropped `.mcap` lazily. Like the MF4 path, the file is streamed
   * into OPFS and read through a sync access handle: only the summary is read
   * at open, and channel samples / video chunks stream on demand, so a
   * multi-gigabyte recording is never materialised in wasm memory.
   */
  async openMcap(file: File): Promise<number> {
    await ready;
    const { access, fileName } = await openMcapSyncAccess(file);
    const readRange = (offset: number, length: number): Uint8Array => {
      const buf = new Uint8Array(length);
      const got = access.read(buf, { at: offset });
      if (got !== length) {
        throw new Error(
          `mcap readRange short read at ${offset}: wanted ${length}, got ${got}`,
        );
      }
      return buf;
    };
    let handle: number;
    try {
      handle = open_mcap_ranged(readRange, file.size);
    } catch (e) {
      // Opening failed — don't leak the OPFS copy or the sync handle.
      access.close();
      try {
        const dir = await mcapOpfsDir();
        await dir.removeEntry(fileName);
      } catch {
        /* best-effort cleanup */
      }
      throw e;
    }
    mcapBackings.set(handle, { access, fileName });
    return handle;
  },
  /**
   * Open an MCAP straight from a URL, reading it lazily over HTTP range
   * requests — no full download, no OPFS copy. Falls back to a whole-body
   * fetch + in-memory open when the server does not honour `Range` (a lazy
   * reader is impossible without range support). The range path registers
   * nothing in `mcapBackings`; the fallback path also has no handle to
   * release, so `closeMcap` is a no-op for both URL shapes.
   */
  async openMcapUrl(url: string): Promise<number> {
    await ready;
    let fileSize: number;
    try {
      fileSize = urlProbeSize(url);
    } catch (e) {
      // A CORS/network block dooms the whole-body fetch too — surface the
      // actionable message instead of retrying into the same wall.
      if (e instanceof UrlFetchBlockedError) throw e;
      // Range genuinely unsupported (e.g. status 200, or no usable size):
      // fetch the whole body once.
      let res: Response;
      try {
        res = await fetch(url);
      } catch {
        // `fetch` rejects with an opaque TypeError on a CORS/network block.
        throw new UrlFetchBlockedError(url);
      }
      if (!res.ok) {
        throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
      }
      return open_mcap(new Uint8Array(await res.arrayBuffer()));
    }
    const readRange = (offset: number, length: number): Uint8Array =>
      urlReadRange(url, offset, length);
    return open_mcap_ranged(readRange, fileSize);
  },
  async closeMcap(handle: number): Promise<void> {
    await ready;
    close_mcap(handle);
    const backing = mcapBackings.get(handle);
    if (backing) {
      mcapBackings.delete(handle);
      backing.access.close();
      try {
        const dir = await mcapOpfsDir();
        await dir.removeEntry(backing.fileName);
      } catch {
        /* best-effort: the OPFS entry may already be gone */
      }
    }
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
  ): Promise<Uint8Array> {
    await ready;
    const buf = mcap_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
    );
    // Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
    return Comlink.transfer(buf, [buf.buffer]);
  },
  /**
   * Open a ROS 1 bag (rosbag v2.0). The whole file is decoded in wasm memory
   * (no OPFS/ranged path). Passing a `File` keeps the bytes on the worker
   * side — no structured-clone copy across the Comlink boundary.
   */
  async openRos1Bag(file: File): Promise<number> {
    await ready;
    return open_ros1_bag(new Uint8Array(await file.arrayBuffer()));
  },
  /**
   * `SourceMeta` for an open ROS 1 bag. ROS 1 bag channels carry the same
   * `kind` / optional `dtype` shape as mcap channels, so the wire summary is
   * identical and reuses `normaliseMcap`.
   */
  async ros1BagSummary(handle: number): Promise<McapSummary> {
    await ready;
    return normaliseMcap(ros1_bag_summary(handle) as RawMcapSummary);
  },
  async ros1BagFetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array> {
    await ready;
    const buf = ros1_bag_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
    );
    // Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
    return Comlink.transfer(buf, [buf.buffer]);
  },
  async closeRos1Bag(handle: number): Promise<void> {
    await ready;
    close_ros1_bag(handle);
  },
  /**
   * Open a ROS 2 rosbag2 SQLite (`.db3`) bag. The whole file is decoded in
   * wasm memory (no OPFS/ranged path). Passing a `File` keeps the bytes on
   * the worker side — no structured-clone copy across the Comlink boundary.
   */
  async openRos2Db3(file: File): Promise<number> {
    await ready;
    return open_ros2_db3(new Uint8Array(await file.arrayBuffer()));
  },
  /**
   * `SourceMeta` for an open ROS 2 db3 bag. ROS 2 db3 channels carry the same
   * `kind` / optional `dtype` shape as mcap channels, so the wire summary is
   * identical and reuses `normaliseMcap`.
   */
  async ros2Db3Summary(handle: number): Promise<McapSummary> {
    await ready;
    return normaliseMcap(ros2_db3_summary(handle) as RawMcapSummary);
  },
  async ros2Db3FetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array> {
    await ready;
    const buf = ros2_db3_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
    );
    // Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
    return Comlink.transfer(buf, [buf.buffer]);
  },
  async closeRos2Db3(handle: number): Promise<void> {
    await ready;
    close_ros2_db3(handle);
  },
  /**
   * Open an mp4+sidecar pair. `mp4Bytes` is the pre-sliced `ftyp`+`moov` header
   * (a small `Uint8Array`). `sidecar` is either:
   *   - a `File` (the `.mp4.timestamps` drop path) — read here, zero main-thread copy
   *   - a `Uint8Array` (synthesized by `confirmVideoBinding`) — used directly
   */
  async openMp4Sidecar(
    mp4Bytes: Uint8Array,
    sidecar: Uint8Array | File,
  ): Promise<number> {
    await ready;
    const sidecarBytes =
      sidecar instanceof File
        ? new Uint8Array(await sidecar.arrayBuffer())
        : sidecar;
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
  /**
   * Lazy-load index for an mp4+sidecar source. Returns the per-sample
   * `(offset, size, is_sync, pts_ns)` table plus the SPS/PPS NAL bytes;
   * the `mdat` bytes never cross this boundary. JS holds the index +
   * the original `File` blob and reads sample bodies on demand via
   * `File.slice()`. See `apps/web/src/state/mp4SampleCache.ts`.
   *
   * All typed arrays are fresh from wasm for this call — transfer them to
   * avoid a structured-clone copy. The worker never touches these buffers
   * after returning; the main-thread `Mp4SampleCache` owns them.
   */
  async mp4SidecarIndex(handle: number): Promise<Mp4SidecarIndex> {
    await ready;
    const idx = normaliseMp4Index(
      mp4_sidecar_index(handle) as RawMp4SidecarIndex,
    );
    return Comlink.transfer(idx, [
      idx.ptsNs.buffer,
      idx.offsets.buffer,
      idx.sizes.buffer,
      idx.isSync.buffer,
      idx.sps.buffer,
      idx.pps.buffer,
    ]);
  },
  /**
   * Inspect a CSV / Parquet file without retaining it: returns the
   * `TabularSchema` (`{ columns, suggested }`) the import dialog drives its
   * column list and default time-basis from. `format` is `"csv"` or
   * `"parquet"`. Accepting a `File` keeps the bytes on the worker side —
   * no structured-clone copy. The file is re-read by `openTabular` on confirm.
   */
  async tabularInspect(file: File, format: string): Promise<RawTabularSchema> {
    await ready;
    return tabular_inspect(
      new Uint8Array(await file.arrayBuffer()),
      format,
    ) as RawTabularSchema;
  },
  /**
   * Open a CSV / Parquet file with an explicit `TimeBasis` (JSON string) and
   * register the resulting reader in the wasm slab. Returns the integer handle
   * the other `tabular*` methods take. Accepting a `File` keeps the bytes on
   * the worker side — no structured-clone copy; the wasm reader owns the
   * decoded data for the source's lifetime, freed by `closeTabular`.
   */
  async openTabular(
    file: File,
    format: string,
    basisJson: string,
  ): Promise<number> {
    await ready;
    return open_tabular(
      new Uint8Array(await file.arrayBuffer()),
      format,
      basisJson,
    );
  },
  /**
   * `SourceMeta` for an open tabular reader, in the MF4-style shape
   * (`{ start_ns, end_ns, channels:[{ id, name, unit, group, sample_count,
   * start_ns, end_ns }] }` with `group` always null), normalised so every
   * `*_ns` field is a `bigint`. Reuses `normaliseMf4` since the wire shape is
   * identical.
   */
  async tabularSummary(handle: number): Promise<Mf4Summary> {
    await ready;
    return normaliseMf4(tabular_summary(handle) as RawMf4Summary);
  },
  async tabularFetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array> {
    await ready;
    const buf = tabular_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
    );
    // Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
    return Comlink.transfer(buf, [buf.buffer]);
  },
  /**
   * The converted, ascending ns-UTC time column of an opened tabular source,
   * as a `BigInt64Array`. Used to derive per-frame video timestamps for a
   * sidecar-less mp4 (row i → frame i); see `state/videoTimestampBinding.ts`.
   *
   * Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
   */
  async tabularTimeColumnNs(handle: number): Promise<BigInt64Array> {
    await ready;
    const col = tabular_time_column_ns(handle);
    return Comlink.transfer(col, [col.buffer]);
  },
  async closeTabular(handle: number): Promise<void> {
    await ready;
    close_tabular(handle);
  },
  /**
   * Dry-run a candidate Ingest Recipe against (a bounded prefix of) a file and
   * return a `DryRunReport` — the Format Agent's `validate_recipe` feedback
   * signal (see `docs/12-format-agent.md`). Decodes at most `budget` records;
   * never retains the source. Accepting a `File` keeps the bytes worker-side.
   */
  async recipeDryRun(
    file: File,
    recipeJson: string,
    budget: number,
  ): Promise<RawRecipeDryRunReport> {
    await ready;
    return recipe_dry_run(
      new Uint8Array(await file.arrayBuffer()),
      recipeJson,
      budget,
    ) as RawRecipeDryRunReport;
  },
  /**
   * Open a file with an Ingest Recipe (JSON) and register the resulting reader
   * in the wasm slab. Returns the integer handle the other `recipe*` methods
   * take. Every channel is a scalar f64 signal, so the summary/fetch shape is
   * identical to the tabular path.
   */
  async openRecipe(file: File, recipeJson: string): Promise<number> {
    await ready;
    return open_recipe(new Uint8Array(await file.arrayBuffer()), recipeJson);
  },
  async recipeSummary(handle: number): Promise<Mf4Summary> {
    await ready;
    return normaliseMf4(recipe_summary(handle) as RawMf4Summary);
  },
  async recipeFetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array> {
    await ready;
    const buf = recipe_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
    );
    return Comlink.transfer(buf, [buf.buffer]);
  },
  async closeRecipe(handle: number): Promise<void> {
    await ready;
    close_recipe(handle);
  },
  /**
   * Open a Driveline point-cloud Parquet (one row per LiDAR spin). The wasm
   * reader owns the decoded per-spin buffers for the source's lifetime, freed
   * by `closeLidar`. Accepting a `File` keeps the bytes on the worker side —
   * no structured-clone copy across the Comlink boundary.
   */
  async openLidar(file: File): Promise<number> {
    await ready;
    return open_lidar(new Uint8Array(await file.arrayBuffer()));
  },
  /**
   * Open a PCD (Point Cloud Data) file — the PCL/ROS LiDAR interchange format.
   * A PCD holds a single cloud, so the reader surfaces one point-cloud channel
   * with one spin; every other `lidar*` method then works unchanged. Supports
   * `ascii`, `binary`, and `binary_compressed` payloads. Accepting a `File`
   * keeps the bytes on the worker side — no structured-clone copy.
   */
  async openLidarPcd(file: File): Promise<number> {
    await ready;
    return open_lidar_pcd(new Uint8Array(await file.arrayBuffer()));
  },
  /**
   * Open a **raw NVIDIA Alpamayo LiDAR** Parquet (Draco-compressed spins),
   * decoding the Draco blobs in-browser so no Python pre-conversion is needed.
   * The Draco decoder (Google's reference build) is imported lazily here — only
   * when a raw clip is actually dropped — and resolved to a synchronous spin
   * decoder that the wasm reader calls once per spin. Surfaces as a
   * `kind: "lidar"` source, identical to `openLidar`, so every other `lidar*`
   * method works unchanged. Pass the `File` directly so its (large) bytes stay
   * on the worker side.
   */
  async openAlpamayoLidar(file: File): Promise<number> {
    await ready;
    const { loadDracoSpinDecoder } = await import("./dracoDecode");
    const decode = await loadDracoSpinDecoder();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return open_alpamayo_lidar(bytes, decode, undefined);
  },
  /**
   * `SourceMeta` for an open point-cloud reader, in the MF4-style shape
   * (single channel, `group` null, `sample_count` = peak points/spin),
   * normalised so every `*_ns` field is a `bigint`.
   */
  async lidarSummary(handle: number): Promise<Mf4Summary> {
    await ready;
    return normaliseMf4(lidar_summary(handle) as RawMf4Summary);
  },
  /**
   * Arrow IPC for the spins overlapping `[startNs, endNs)`. The scene panel
   * passes a zero/one-width window + `includePrev` to fetch exactly the spin
   * active at the cursor. Schema: `{ ts, positions: List<f32>, intensities:
   * List<f32> }`, one row per spin.
   *
   * Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
   */
  async lidarFetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array> {
    await ready;
    const buf = lidar_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
    );
    return Comlink.transfer(buf, [buf.buffer]);
  },
  /**
   * Ascending spin start timestamps (ns) for a point-cloud source, one per
   * frame. The scene panel binary-searches this locally so it only refetches
   * point data when the active spin changes.
   *
   * Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
   */
  async lidarSpinTimes(handle: number): Promise<BigInt64Array> {
    await ready;
    const times = lidar_spin_times(handle);
    return Comlink.transfer(times, [times.buffer]);
  },
  async closeLidar(handle: number): Promise<void> {
    await ready;
    close_lidar(handle);
  },
  /**
   * Open an ASAM OpenLABEL JSON (one row per labelled frame of 3D bounding
   * boxes). The wasm reader owns the decoded per-frame buffers for the
   * source's lifetime, freed by `closeOpenlabel`. Accepting a `File` keeps
   * the bytes on the worker side — no structured-clone copy across Comlink.
   */
  async openOpenlabel(file: File): Promise<number> {
    await ready;
    return open_openlabel(new Uint8Array(await file.arrayBuffer()));
  },
  /**
   * `SourceMeta` for an open OpenLABEL reader, in the MF4-style shape (single
   * channel, `group` null, `sample_count` = peak boxes/frame), normalised so
   * every `*_ns` field is a `bigint`. No `kind` on the wire — the store stamps
   * `bounding_box`, exactly like lidar stamps `point_cloud`.
   */
  async openlabelSummary(handle: number): Promise<Mf4Summary> {
    await ready;
    return normaliseMf4(openlabel_summary(handle) as RawMf4Summary);
  },
  /**
   * Arrow IPC for the frames overlapping `[startNs, endNs)`. The scene panel
   * passes a zero/one-width window + `includePrev` to fetch exactly the frame
   * active at the cursor. Schema: `{ ts, centers, sizes, rotations: List<f32>,
   * labels: List<Utf8> }`, one row per frame.
   *
   * Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
   */
  async openlabelFetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array> {
    await ready;
    const buf = openlabel_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
    );
    return Comlink.transfer(buf, [buf.buffer]);
  },
  /**
   * Ascending frame timestamps (ns) for an OpenLABEL source, one per frame.
   * The scene panel binary-searches this locally so it only refetches box
   * data when the active frame changes.
   *
   * Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
   */
  async openlabelFrameTimes(handle: number): Promise<BigInt64Array> {
    await ready;
    const times = openlabel_frame_times(handle);
    return Comlink.transfer(times, [times.buffer]);
  },
  async closeOpenlabel(handle: number): Promise<void> {
    await ready;
    close_openlabel(handle);
  },
  /**
   * Open a `driveline.calibration/v1` JSON (camera ↔ LiDAR calibration). The
   * wasm reader validates the schema marker and owns the decoded cameras for
   * the source's lifetime, freed by `closeCalibration`. Accepting a `File`
   * keeps the bytes on the worker side — no structured-clone copy across
   * Comlink.
   */
  async openCalibration(file: File): Promise<number> {
    await ready;
    return open_calibration(new Uint8Array(await file.arrayBuffer()));
  },
  /**
   * `SourceMeta` for an open calibration reader, in the MF4-style shape (single
   * `camera_calibration` channel, `group` null, `sample_count` = camera count),
   * normalised so every `*_ns` field is a `bigint`.
   */
  async calibrationSummary(handle: number): Promise<Mf4Summary> {
    await ready;
    return normaliseMf4(calibration_summary(handle) as RawMf4Summary);
  },
  /**
   * Arrow IPC for the calibration channel. Calibration is config, not a time
   * series: there is no range — every camera is returned, one row each. Schema:
   * `{ name: Utf8, intrinsics: List<f32>, resolution: List<i32>, distortion:
   * List<f32>, translation: List<f32>, quaternion: List<f32> }`.
   *
   * Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
   */
  async calibrationFetch(
    handle: number,
    channelId: string,
  ): Promise<Uint8Array> {
    await ready;
    const buf = calibration_fetch_range(handle, channelId);
    return Comlink.transfer(buf, [buf.buffer]);
  },
  async closeCalibration(handle: number): Promise<void> {
    await ready;
    close_calibration(handle);
  },
  /**
   * Open a Driveline `*.trajectory.json` (one row per frame of predicted ego
   * future trajectories — candidate waypoint polylines). The wasm reader owns
   * the decoded per-frame buffers for the source's lifetime, freed by
   * `closeTrajectory`. Accepting a `File` keeps the bytes on the worker side —
   * no structured-clone copy across Comlink.
   */
  async openTrajectory(file: File): Promise<number> {
    await ready;
    return open_trajectory(new Uint8Array(await file.arrayBuffer()));
  },
  /**
   * `SourceMeta` for an open trajectory reader, in the MF4-style shape (single
   * channel, `group` null, `sample_count` = peak paths/frame), normalised so
   * every `*_ns` field is a `bigint`. No `kind` on the wire — the store stamps
   * `trajectory`, exactly like lidar stamps `point_cloud`.
   */
  async trajectorySummary(handle: number): Promise<Mf4Summary> {
    await ready;
    return normaliseMf4(trajectory_summary(handle) as RawMf4Summary);
  },
  /**
   * Arrow IPC for the frames overlapping `[startNs, endNs)`. The scene panel
   * passes a zero/one-width window + `includePrev` to fetch exactly the frame
   * active at the cursor. Schema: `{ ts, points: List<f32>, path_lengths:
   * List<i32>, confidences: List<f32> }`, one row per frame.
   *
   * Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
   */
  async trajectoryFetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array> {
    await ready;
    const buf = trajectory_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
    );
    return Comlink.transfer(buf, [buf.buffer]);
  },
  /**
   * Ascending frame timestamps (ns) for a trajectory source, one per frame.
   * The scene panel binary-searches this locally so it only refetches
   * trajectory data when the active frame changes.
   *
   * Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
   */
  async trajectoryFrameTimes(handle: number): Promise<BigInt64Array> {
    await ready;
    const times = trajectory_frame_times(handle);
    return Comlink.transfer(times, [times.buffer]);
  },
  async closeTrajectory(handle: number): Promise<void> {
    await ready;
    close_trajectory(handle);
  },
  /**
   * Open a road-network map-geometry file — OpenDRIVE (`.xodr`) or the simple
   * `drivelineMap` JSON. The reader auto-detects the format and decodes every
   * polyline (lane boundaries, road edges, centerlines, …) into a single static
   * frame. The wasm reader owns the decoded geometry for the source's lifetime,
   * freed by `closeMapGeometry`. Accepting a `File` keeps the bytes on the
   * worker side — no structured-clone copy across Comlink.
   */
  async openMapGeometry(file: File): Promise<number> {
    await ready;
    return open_map_geometry(new Uint8Array(await file.arrayBuffer()));
  },
  /**
   * `SourceMeta` for an open map-geometry reader, in the MF4-style shape (single
   * channel, `group` null, `sample_count` = polyline count), normalised so every
   * `*_ns` field is a `bigint`. No `kind` on the wire — the store stamps
   * `map_geometry`, exactly like lidar stamps `point_cloud`.
   */
  async mapGeometrySummary(handle: number): Promise<Mf4Summary> {
    await ready;
    return normaliseMf4(map_geometry_summary(handle) as RawMf4Summary);
  },
  /**
   * Arrow IPC for the road network. Map geometry is STATIC (one frame at ts=0),
   * so the scene panel passes the single-frame window + `includePrev` to fetch
   * it. Schema: `{ ts, points: List<f32>, path_lengths: List<i32>, types:
   * List<Utf8> }`, one row.
   *
   * Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
   */
  async mapGeometryFetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array> {
    await ready;
    const buf = map_geometry_fetch_range(
      handle,
      channelId,
      startNs,
      endNs,
      includePrev,
    );
    return Comlink.transfer(buf, [buf.buffer]);
  },
  /**
   * Frame timestamps (ns) for a map-geometry source. Map geometry is static, so
   * this always returns `[0]`; the scene panel reads frame[0] and fetches the
   * single frame once per binding (no per-cursor refetch).
   *
   * Fresh allocation from wasm every call — transfer to avoid structured-clone copy.
   */
  async mapGeometryFrameTimes(handle: number): Promise<BigInt64Array> {
    await ready;
    const times = map_geometry_frame_times(handle);
    return Comlink.transfer(times, [times.buffer]);
  },
  async closeMapGeometry(handle: number): Promise<void> {
    await ready;
    close_map_geometry(handle);
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
    const chunks = raw.map(normaliseEncodedChunk);
    // Collect unique underlying ArrayBuffers (wasm may theoretically back
    // multiple chunks from a single allocation; deduplicate via Set so each
    // buffer appears in the transfer list at most once).
    // Cast to ArrayBuffer: wasm-allocated Uint8Array buffers are never
    // SharedArrayBuffers; the cast satisfies the Comlink.transfer overload.
    const buffers = new Set<ArrayBuffer>(
      chunks.map((c) => c.data.buffer as ArrayBuffer),
    );
    return Comlink.transfer(chunks, [...buffers]);
  },
  async closeMcapVideoStream(streamId: number): Promise<void> {
    await ready;
    mcap_video_close(streamId);
  },
  /**
   * Worker-to-worker MCAP video bridge. Exposes a minimal
   * `{ openMcapVideoStream, mcapVideoNextBatch, closeMcapVideoStream }` API
   * on the provided `MessagePort` so the videoDecode worker can talk to the
   * dataCore worker directly — without routing video chunk batches through
   * the main thread.
   *
   * Why not open a second dataCore inside the videoDecode worker? Because the
   * wasm slab is per-worker-instance: a fresh wasm init in videoDecode would
   * have an empty slab, making `sourceHandle` invalid there. This bridge
   * reuses the existing slab so all handle-keyed state (OPFS sync handles,
   * channel reader state) remains valid.
   *
   * Lifecycle: the port is closed by the videoDecode worker (or its owner)
   * when the panel unmounts. `Comlink.expose` on a closed/detached port is
   * inert — no explicit teardown is needed on this side beyond port.close()
   * at the caller.
   */
  connectMcapVideoBridge(port: MessagePort): void {
    // Re-expose the MCAP video stream methods on the provided port.
    // mcapVideoNextBatch wraps the chunk buffers in Comlink.transfer so the
    // worker-to-worker hop is also zero-copy.
    Comlink.expose(
      {
        openMcapVideoStream: (h: number, c: string, p: bigint) =>
          mcap_video_open(h, c, p),
        mcapVideoNextBatch: async (streamId: number, maxN: number) => {
          await ready;
          const raw = mcap_video_next_batch(
            streamId,
            maxN,
          ) as RawEncodedChunk[];
          const chunks = raw.map(normaliseEncodedChunk);
          // Cast to ArrayBuffer: wasm buffers are never SharedArrayBuffers.
          const buffers = new Set<ArrayBuffer>(
            chunks.map((ch) => ch.data.buffer as ArrayBuffer),
          );
          return Comlink.transfer(chunks, [...buffers]);
        },
        closeMcapVideoStream: (streamId: number) => mcap_video_close(streamId),
      },
      port,
    );
  },
};

export type DataCoreApi = typeof dataCoreApi;

Comlink.expose(dataCoreApi);
