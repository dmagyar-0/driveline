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
