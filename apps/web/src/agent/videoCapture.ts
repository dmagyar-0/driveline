// Panel-independent camera-frame capture for the agent surface. Lazily spins up
// a dedicated videoDecode worker, wired to the live dataCore slab (MCAP path)
// and the main-thread `Mp4SampleCache` (mp4+sidecar path) exactly like a video
// panel, and asks it to decode the camera frame nearest a timestamp. This lets
// an automation read the camera at any T with no video panel open and without
// disturbing playback (the worker decodes on a throwaway stream/decoder).
//
// The worker + bridges are created on first use and kept for the page lifetime
// (a capture worker with no open playback session is idle). Returned PNG bytes
// are turned into a data URL so `snapshotAt`/`captureVideoFrameAt` hand the
// agent a self-contained image string.

import * as Comlink from "comlink";
import { makeVideoDecodeClient } from "../workerClient";
import type { VideoDecodeApi } from "../workerClient";
import { useSession } from "../state/store";

interface ResolvedVideoChannel {
  sourceKind: "mcap" | "mp4";
  sourceHandle: number;
  nativeChannelId: string;
  cameraName: string;
}

/** Resolve a qualified video channel id to the worker-facing coordinates the
 *  decode worker needs. Returns null for unknown / non-video channels (so the
 *  agent surface can stay no-throw). */
function resolveVideoChannel(channelId: string): ResolvedVideoChannel | null {
  for (const source of useSession.getState().sources) {
    if (source.kind !== "mcap" && source.kind !== "mp4+sidecar") continue;
    const channel = source.channels.find((c) => c.id === channelId);
    if (channel && channel.kind === "video") {
      return {
        sourceKind: source.kind === "mcap" ? "mcap" : "mp4",
        sourceHandle: source.handle,
        nativeChannelId: channel.nativeId,
        cameraName: channel.name,
      };
    }
  }
  return null;
}

let wiring: Promise<Comlink.Remote<VideoDecodeApi> | null> | null = null;

// Build (once) the capture worker and bridge it to the dataCore slab + the
// main-thread mp4 caches, mirroring `VideoPanel`'s wiring. Resolves null when
// there is no dataCore worker yet (no session).
function ensureCaptureWorker(): Promise<Comlink.Remote<VideoDecodeApi> | null> {
  if (wiring) return wiring;
  wiring = (async () => {
    const dc = useSession.getState().getWorker();
    if (!dc) {
      wiring = null; // allow a retry once a session exists
      return null;
    }
    const { proxy } = makeVideoDecodeClient(() => {
      // A crashed capture worker just disables capture; drop the wiring so the
      // next request rebuilds. Playback (a separate worker) is unaffected.
      wiring = null;
    });

    // MCAP chunk bridge: dataCore exposes the stream API on port1, the capture
    // worker consumes it on port2 — chunks never touch the main thread.
    const bridge = new MessageChannel();
    await dc.connectMcapVideoBridge(
      Comlink.transfer(bridge.port1, [bridge.port1]),
    );
    await proxy.setDataCorePort(Comlink.transfer(bridge.port2, [bridge.port2]));

    // Lazy mp4 bridge: encoded sample bytes for mp4+sidecar come from the
    // per-source `Mp4SampleCache` on the main thread, resolved by handle.
    const findMp4Cache = (handle: number) =>
      useSession
        .getState()
        .sources.find((s) => s.kind === "mp4+sidecar" && s.handle === handle)
        ?.mp4Cache ?? null;
    const mp4Bridge = new MessageChannel();
    const mp4Relay = {
      mp4Index: async (handle: number) => {
        const cache = findMp4Cache(handle);
        if (!cache) throw new Error(`mp4 cache missing for handle ${handle}`);
        return cache.index;
      },
      mp4Sample: async (handle: number, idx: number) => {
        const cache = findMp4Cache(handle);
        if (!cache) throw new Error(`mp4 cache missing for handle ${handle}`);
        return cache.getSample(idx);
      },
      mp4SetActive: async (handle: number, lo: number, hi: number) => {
        const cache = findMp4Cache(handle);
        if (!cache) return;
        cache.prefetchRange(lo, hi);
      },
      mp4MarkPending: async (handle: number, targetNs: bigint) => {
        findMp4Cache(handle)?.markPendingFetch(targetNs);
      },
      mp4ClearPending: async (handle: number) => {
        findMp4Cache(handle)?.clearPendingFetch();
      },
    };
    Comlink.expose(mp4Relay, mp4Bridge.port1);
    await proxy.setMp4LazyPort(
      Comlink.transfer(mp4Bridge.port2, [mp4Bridge.port2]),
    );
    return proxy;
  })();
  return wiring;
}

async function pngToDataUrl(png: ArrayBuffer): Promise<string> {
  const blob = new Blob([png], { type: "image/png" });
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"));
    fr.readAsDataURL(blob);
  });
}

export interface CapturedVideoFrame {
  channelId: string;
  cameraName: string;
  /** PTS (ns) of the frame actually returned (newest at/<= the request). */
  ptsNs: bigint;
  width: number;
  height: number;
  /** `data:image/png;base64,...` of the decoded frame. */
  dataUrl: string;
}

/** Decode the camera frame nearest `atPtsNs` on `channelId`, independent of
 *  playback. Resolves null for an unknown channel, no session, or a timestamp
 *  with no covering frame. Never throws (advisory agent capability). */
export async function captureVideoFrameAt(
  channelId: string,
  atPtsNs: bigint,
): Promise<CapturedVideoFrame | null> {
  const resolved = resolveVideoChannel(channelId);
  if (!resolved) return null;
  try {
    const vd = await ensureCaptureWorker();
    if (!vd) return null;
    const captured = await vd.captureFrameAt(
      resolved.sourceKind,
      resolved.sourceHandle,
      resolved.nativeChannelId,
      atPtsNs,
    );
    if (!captured) return null;
    return {
      channelId,
      cameraName: resolved.cameraName,
      ptsNs: captured.ptsNs,
      width: captured.width,
      height: captured.height,
      dataUrl: await pngToDataUrl(captured.png),
    };
  } catch {
    return null;
  }
}
