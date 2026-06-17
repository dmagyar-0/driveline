// Shared LRU cache of decoded LiDAR spins. The 3D scene panel and the
// point-cloud-on-video overlay both project the *same* point-cloud channel at
// the same cursor, so without sharing they each fetch the spin and run a full
// `tableFromIPC` Arrow parse — twice the per-spin main-thread work for one
// cloud. Routing both through `fetchDecodedSpin` parses each spin once and
// hands both consumers the same read-only typed-array views.
//
// Keyed by `${channelId}|${tsNs}`. The cursor only crosses into a new spin at
// the spin rate (~10-20 Hz), and at any instant every panel wants the same
// few spins, so a tiny cache covers the steady state. Entries hold `subarray`
// views over the Arrow backing buffer (zero-copy); both consumers treat them
// as read-only (the scene panel uploads to the GPU, the overlay projects), so
// sharing one decode between them is safe.

import { useSession } from "../state/store";
import { decodePointCloud, type PointCloudResult } from "./pointCloudFromArrow";

// Small bound: the scene panel + overlay want the current spin, and a backward
// scrub or a second panel wants at most a couple of neighbours. Four keeps the
// retained Arrow buffers to a few hundred KB while covering every live viewer.
const MAX_ENTRIES = 4;

// Insertion-ordered Map doubles as the LRU: a hit is re-inserted to mark it
// most-recent; eviction drops the oldest key.
const cache = new Map<string, PointCloudResult>();
// In-flight dedup so two panels asking for the same spin in the same frame
// share one fetch+decode rather than racing two.
const inflight = new Map<string, Promise<PointCloudResult>>();

/**
 * Fetch + decode the LiDAR spin starting at `tsNs` on `channelId`, sharing the
 * decode across callers. Resolves the same `PointCloudResult` shape
 * `decodePointCloud` returns; never throws (a fetch/parse failure resolves to
 * an `ok: false` result), so callers probe without try/catch scaffolding.
 */
export async function fetchDecodedSpin(
  channelId: string,
  tsNs: bigint,
): Promise<PointCloudResult> {
  const key = `${channelId}|${tsNs}`;
  const hit = cache.get(key);
  if (hit) {
    // Mark most-recently-used.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async (): Promise<PointCloudResult> => {
    let res: PointCloudResult;
    try {
      // Narrow window [ts, ts+1) returns exactly this spin (one row).
      const bytes = await useSession
        .getState()
        .fetchChannelRange(channelId, tsNs, tsNs + 1n, false);
      res = decodePointCloud(bytes);
    } catch (err) {
      res = {
        ok: false,
        reason: "decode",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    // Only cache a successful decode. Errors/empties are cheap to recompute and
    // pinning a transient failure would mask a later good fetch.
    if (res.ok) {
      cache.set(key, res);
      while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    return res;
  })();

  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

/** Drop every cached spin. Called when the session is cleared/reset so a fresh
 *  load never serves geometry from a previous session's channels. */
export function clearPointCloudSpinCache(): void {
  cache.clear();
  inflight.clear();
}

/** Test seam: current number of cached spins. */
export function pointCloudSpinCacheSize(): number {
  return cache.size;
}
