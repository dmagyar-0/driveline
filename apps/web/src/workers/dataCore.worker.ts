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
  lidar_summary,
  lidar_fetch_range,
  lidar_spin_times,
  close_lidar,
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

/**
 * Probe a remote file over HTTP and return its total byte length.
 *
 * Both the MF4 and MCAP readers decode synchronously inside wasm, so the lazy
 * ranged path needs a *synchronous* reader (the OPFS path uses a sync access
 * handle). For a URL we use synchronous `XMLHttpRequest` — permitted inside a
 * Worker — issuing `Range` requests. This probe asks for a single byte and
 * reads the total size out of the `Content-Range` header, which doubles as a
 * check that the server actually honours range requests (status 206). A server
 * that ignores `Range` (200, whole body) can't back a lazy reader, so we fail
 * loudly here; the MCAP caller catches this and falls back to a whole-body
 * fetch.
 */
function urlProbeSize(url: string): number {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false); // synchronous — only legal off the main thread
  xhr.setRequestHeader("Range", "bytes=0-0");
  xhr.send();
  if (xhr.status !== 206) {
    throw new Error(
      `URL does not support HTTP range requests ` +
        `(got status ${xhr.status}, expected 206). The server must send ` +
        `'Accept-Ranges: bytes' and honour the Range header.`,
    );
  }
  // "bytes 0-0/123456" → total is the part after the slash.
  const contentRange = xhr.getResponseHeader("Content-Range");
  const total = contentRange?.split("/")[1];
  if (!total || total === "*" || !Number.isFinite(Number(total))) {
    throw new Error(
      `URL range response missing a usable total size ` +
        `(Content-Range: ${contentRange ?? "<none>"}).`,
    );
  }
  return Number(total);
}

/**
 * Synchronous ranged read against `url`, used as the wasm `readRange`
 * callback for a URL-backed source. wasm invokes this once per data block /
 * chunk while decoding, so only the bytes actually plotted (or the video
 * chunks actually played) are ever fetched.
 */
function urlReadRange(url: string, offset: number, length: number): Uint8Array {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.responseType = "arraybuffer"; // allowed for sync XHR inside a Worker
  xhr.setRequestHeader("Range", `bytes=${offset}-${offset + length - 1}`);
  xhr.send();
  if (xhr.status !== 206 && xhr.status !== 200) {
    throw new Error(`url readRange failed at ${offset}: status ${xhr.status}`);
  }
  let buf = new Uint8Array(xhr.response as ArrayBuffer);
  // A non-conforming server may answer a Range with the whole body (200);
  // slice the requested window out of it rather than failing.
  if (xhr.status === 200 && buf.length >= offset + length) {
    buf = buf.subarray(offset, offset + length);
  }
  if (buf.length !== length) {
    throw new Error(
      `url short read at ${offset}: wanted ${length}, got ${buf.length}`,
    );
  }
  return buf;
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
    return mf4_fetch_range(handle, channelId, startNs, endNs, includePrev);
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
    } catch {
      // Range unsupported (or probe failed): fetch the whole body once.
      const res = await fetch(url);
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
    return mcap_fetch_range(handle, channelId, startNs, endNs, includePrev);
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
  /**
   * Lazy-load index for an mp4+sidecar source. Returns the per-sample
   * `(offset, size, is_sync, pts_ns)` table plus the SPS/PPS NAL bytes;
   * the `mdat` bytes never cross this boundary. JS holds the index +
   * the original `File` blob and reads sample bodies on demand via
   * `File.slice()`. See `apps/web/src/state/mp4SampleCache.ts`.
   */
  async mp4SidecarIndex(handle: number): Promise<Mp4SidecarIndex> {
    await ready;
    return normaliseMp4Index(mp4_sidecar_index(handle) as RawMp4SidecarIndex);
  },
  /**
   * Inspect a CSV / Parquet blob without retaining it: returns the
   * `TabularSchema` (`{ columns, suggested }`) the import dialog drives its
   * column list and default time-basis from. `format` is `"csv"` or
   * `"parquet"`. The bytes are NOT held in wasm — the JS caller keeps them
   * (in the pending-import slice) and re-passes them to `openTabular` on
   * confirm.
   */
  async tabularInspect(
    bytes: Uint8Array,
    format: string,
  ): Promise<RawTabularSchema> {
    await ready;
    return tabular_inspect(bytes, format) as RawTabularSchema;
  },
  /**
   * Open a CSV / Parquet blob with an explicit `TimeBasis` (JSON string) and
   * register the resulting reader in the wasm slab. Returns the integer
   * handle the other `tabular*` methods take. Like the mp4-sidecar path the
   * bytes are passed wholesale (no OPFS copy); the wasm reader owns them for
   * the source's lifetime, freed by `closeTabular`.
   */
  async openTabular(
    bytes: Uint8Array,
    format: string,
    basisJson: string,
  ): Promise<number> {
    await ready;
    return open_tabular(bytes, format, basisJson);
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
    return tabular_fetch_range(handle, channelId, startNs, endNs, includePrev);
  },
  /**
   * The converted, ascending ns-UTC time column of an opened tabular source,
   * as a `BigInt64Array`. Used to derive per-frame video timestamps for a
   * sidecar-less mp4 (row i → frame i); see `state/videoTimestampBinding.ts`.
   */
  async tabularTimeColumnNs(handle: number): Promise<BigInt64Array> {
    await ready;
    return tabular_time_column_ns(handle);
  },
  async closeTabular(handle: number): Promise<void> {
    await ready;
    close_tabular(handle);
  },
  /**
   * Open a Driveline point-cloud Parquet (one row per LiDAR spin). Like the
   * tabular path the whole blob is passed wholesale (no OPFS copy) and the
   * wasm reader owns the decoded per-spin buffers for the source's lifetime,
   * freed by `closeLidar`. The JS caller can drop its `bytes` once this
   * returns.
   */
  async openLidar(bytes: Uint8Array): Promise<number> {
    await ready;
    return open_lidar(bytes);
  },
  /**
   * Open a PCD (Point Cloud Data) file — the PCL/ROS LiDAR interchange format.
   * A PCD holds a single cloud, so the reader surfaces one point-cloud channel
   * with one spin; every other `lidar*` method then works unchanged. Supports
   * `ascii`, `binary`, and `binary_compressed` payloads.
   */
  async openLidarPcd(bytes: Uint8Array): Promise<number> {
    await ready;
    return open_lidar_pcd(bytes);
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
   */
  async lidarFetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array> {
    await ready;
    return lidar_fetch_range(handle, channelId, startNs, endNs, includePrev);
  },
  /**
   * Ascending spin start timestamps (ns) for a point-cloud source, one per
   * frame. The scene panel binary-searches this locally so it only refetches
   * point data when the active spin changes.
   */
  async lidarSpinTimes(handle: number): Promise<BigInt64Array> {
    await ready;
    return lidar_spin_times(handle);
  },
  async closeLidar(handle: number): Promise<void> {
    await ready;
    close_lidar(handle);
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
    return raw.map(normaliseEncodedChunk);
  },
  async closeMcapVideoStream(streamId: number): Promise<void> {
    await ready;
    mcap_video_close(streamId);
  },
};

export type DataCoreApi = typeof dataCoreApi;

Comlink.expose(dataCoreApi);
