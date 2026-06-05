// Coverage for the lazy mp4 sample cache.
//
// The cache lives on the main thread and reads sample bodies from the
// source `File` via `slice(offset, offset + size)`. JSDOM's `File` /
// `Blob` implementation honours `slice` + `arrayBuffer`, so the tests can
// drive the real code path without mocks beyond a synthetic byte buffer.

import { describe, expect, it } from "vitest";
import type { Mp4SidecarIndex } from "../workers/dataCore.worker";
import {
  Mp4SampleCache,
  findIndexAtOrBeforePts,
  findKeyframeAtOrBefore,
} from "./mp4SampleCache";
import { Mp4BudgetCoordinator } from "./memoryBudget";

function makeFile(): { file: File; index: Mp4SidecarIndex } {
  // Six 4-byte samples laid out contiguously: bytes [0..24).
  const bytes = new Uint8Array(24);
  for (let i = 0; i < 6; i++) {
    bytes[i * 4 + 0] = i;
    bytes[i * 4 + 1] = 0xa0 + i;
    bytes[i * 4 + 2] = 0xb0 + i;
    bytes[i * 4 + 3] = 0xc0 + i;
  }
  const file = new File([bytes], "test.mp4");
  const index: Mp4SidecarIndex = {
    channelId: "1/video",
    ptsNs: BigInt64Array.from([
      0n,
      33_000_000n,
      66_000_000n,
      99_000_000n,
      132_000_000n,
      165_000_000n,
    ]),
    offsets: BigUint64Array.from([0n, 4n, 8n, 12n, 16n, 20n]),
    sizes: Uint32Array.from([4, 4, 4, 4, 4, 4]),
    isSync: Uint8Array.from([1, 0, 0, 1, 0, 0]),
    sps: new Uint8Array(),
    pps: new Uint8Array(),
  };
  return { file, index };
}

async function tick(): Promise<void> {
  // Two ticks to flush the queueMicrotask range-notify scheduler.
  await Promise.resolve();
  await Promise.resolve();
}

describe("Mp4SampleCache", () => {
  it("fetches a sample by slicing the file and returns its bytes", async () => {
    const { file, index } = makeFile();
    const cache = new Mp4SampleCache(file, index, 1024);
    const bytes = await cache.getSample(0);
    expect(Array.from(bytes)).toEqual([0x00, 0xa0, 0xb0, 0xc0]);
    const bytes2 = await cache.getSample(2);
    expect(Array.from(bytes2)).toEqual([0x02, 0xa2, 0xb2, 0xc2]);
    expect(cache.byteSize()).toBe(8);
  });

  it("coalesces concurrent fetches for the same sample", async () => {
    const { file, index } = makeFile();
    const cache = new Mp4SampleCache(file, index, 1024);
    const [a, b, c] = await Promise.all([
      cache.getSample(1),
      cache.getSample(1),
      cache.getSample(1),
    ]);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(b)).toEqual(Array.from(c));
    // Only one entry stored even though three callers raced.
    expect(cache.byteSize()).toBe(4);
  });

  it("evicts the LRU sample once the budget is exceeded", async () => {
    const { file, index } = makeFile();
    // Budget = 12 bytes → at most 3 samples resident.
    const cache = new Mp4SampleCache(file, index, 12);
    await cache.getSample(0);
    await cache.getSample(1);
    await cache.getSample(2);
    expect(cache.byteSize()).toBe(12);
    // Touch idx 0 so it becomes the freshest; idx 1 should be evicted next.
    await cache.getSample(0);
    await cache.getSample(3);
    expect(cache.byteSize()).toBeLessThanOrEqual(12);
    // Notify subscribers fire on a microtask — wait before reading ranges.
    await tick();
  });

  it("keeps active samples pinned during eviction", async () => {
    const { file, index } = makeFile();
    // Generous budget while we warm the cache.
    const cache = new Mp4SampleCache(file, index, 1024);
    await cache.getSample(0);
    await cache.getSample(1);
    await cache.getSample(2);
    expect(cache.byteSize()).toBe(12);
    // Pin samples 0 and 2 then shrink the budget. Sample 1 is the only
    // unpinned entry, so it must be the one evicted; pinned samples
    // stay even though the result is still over budget.
    cache.setActive([0, 2]);
    cache.setBudgetBytes(8);
    expect(cache.byteSize()).toBe(8);
    // With the pins released, evicting brings us under budget on the
    // next eviction pass (triggered by an insert).
    cache.setActive([]);
    await cache.getSample(3);
    expect(cache.byteSize()).toBeLessThanOrEqual(8);
  });

  it("notifies range subscribers with coalesced segments", async () => {
    const { file, index } = makeFile();
    const cache = new Mp4SampleCache(file, index, 1024);
    const seen: Array<Array<{ startNs: bigint; endNs: bigint }>> = [];
    cache.onLoadedRangesChange((ranges) => seen.push(ranges));
    await cache.getSample(0);
    await cache.getSample(1);
    await cache.getSample(3);
    await tick();
    const last = seen[seen.length - 1];
    // Two contiguous runs: [0..1] and [3].
    expect(last.length).toBe(2);
  });

  it("surfaces and clears the pending-fetch indicator", async () => {
    const { file, index } = makeFile();
    const cache = new Mp4SampleCache(file, index, 1024);
    const seen: Array<{ targetNs: bigint } | null> = [];
    cache.onPendingFetchChange((p) => seen.push(p));
    cache.markPendingFetch(132_000_000n);
    cache.clearPendingFetch();
    expect(seen.map((p) => (p ? p.targetNs : null))).toEqual([
      null, // initial fire on subscribe
      132_000_000n,
      null,
    ]);
  });

  it("rejects out-of-range sample indices", async () => {
    const { file, index } = makeFile();
    const cache = new Mp4SampleCache(file, index, 1024);
    await expect(cache.getSample(99)).rejects.toThrow(/out of range/);
  });
});

describe("Mp4SampleCache shared global budget", () => {
  it("evicts based on the aggregate across caches, not just per-cache bytes", async () => {
    // Shared ceiling = 16 bytes total across two caches. Each cache has a
    // generous *local* budget (1024) so per-cache eviction never fires —
    // only the global coordinator should force eviction once the aggregate
    // crosses the ceiling. This is the over-commitment fix: N caches must
    // collectively stay under one ceiling, not each claim the full budget.
    const coord = new Mp4BudgetCoordinator(16);
    const a = makeFile();
    const b = makeFile();
    const cacheA = new Mp4SampleCache(a.file, a.index, 1024, coord);
    const cacheB = new Mp4SampleCache(b.file, b.index, 1024, coord);

    // 4 samples in A (16 bytes) — exactly at the ceiling.
    await cacheA.getSample(0);
    await cacheA.getSample(1);
    await cacheA.getSample(2);
    await cacheA.getSample(3);
    expect(coord.total()).toBe(16);

    // Now fetch into B. The aggregate would be 20 > 16, so the coordinator
    // must drive eviction even though neither cache is over its own 1024
    // budget. Total stays bounded at/under the shared ceiling.
    await cacheB.getSample(0);
    expect(coord.total()).toBeLessThanOrEqual(16);
    expect(cacheA.byteSize() + cacheB.byteSize()).toBeLessThanOrEqual(16);

    cacheA.dispose();
    cacheB.dispose();
  });

  it("reclaims a cache's reported bytes from the aggregate on dispose", async () => {
    const coord = new Mp4BudgetCoordinator(1024);
    const a = makeFile();
    const cache = new Mp4SampleCache(a.file, a.index, 1024, coord);
    await cache.getSample(0);
    await cache.getSample(1);
    expect(coord.total()).toBe(8);
    cache.dispose();
    // Disposal must detach from the coordinator so its bytes stop counting.
    expect(coord.total()).toBe(0);
  });

  it("does not let one cache's pressure starve another via the shared total", async () => {
    // Both caches register with the default-zero ceiling bumped up; the
    // global view is what matters. With a tight ceiling, the freshest
    // inserts win across caches (LRU is global-budget-aware per cache).
    const coord = new Mp4BudgetCoordinator(8);
    const a = makeFile();
    const b = makeFile();
    const cacheA = new Mp4SampleCache(a.file, a.index, 1024, coord);
    const cacheB = new Mp4SampleCache(b.file, b.index, 1024, coord);
    await cacheA.getSample(0);
    await cacheA.getSample(1);
    await cacheB.getSample(0);
    await cacheB.getSample(1);
    // Aggregate never exceeds the 8-byte ceiling.
    expect(coord.total()).toBeLessThanOrEqual(8);
    cacheA.dispose();
    cacheB.dispose();
  });
});

describe("Mp4SampleCache active-set hard bound", () => {
  it("caps resident bytes even when every sample is active", async () => {
    // Build a file big enough that the active set alone would blow past
    // the hard ceiling. 40 samples × 4 bytes = 160 bytes. Budget = 4 →
    // hard ceiling = max(32, 8) = 32 bytes. Pinning all 40 must NOT keep
    // 160 bytes resident: the hard bound evicts LRU active samples.
    const n = 40;
    const bytes = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) bytes[i * 4] = i & 0xff;
    const file = new File([bytes], "big.mp4");
    const pts = new BigInt64Array(n);
    const offsets = new BigUint64Array(n);
    const sizes = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      pts[i] = BigInt(i) * 33_000_000n;
      offsets[i] = BigInt(i * 4);
      sizes[i] = 4;
    }
    const index: Mp4SidecarIndex = {
      channelId: "1/video",
      ptsNs: pts,
      offsets,
      sizes,
      isSync: Uint8Array.from(
        Array.from({ length: n }, (_, i) => (i % 4 === 0 ? 1 : 0)),
      ),
      sps: new Uint8Array(),
      pps: new Uint8Array(),
    };

    const cache = new Mp4SampleCache(file, index, 4); // hard ceiling = 32
    cache.setActive(Array.from({ length: n }, (_, i) => i));
    for (let i = 0; i < n; i++) await cache.getSample(i);

    // Even with everything pinned, the cache cannot grow without limit.
    expect(cache.byteSize()).toBeLessThanOrEqual(32);
    cache.dispose();
  });

  it("still preferentially retains active samples in the common case", async () => {
    // Generous hard ceiling; one unpinned sample present. Soft eviction
    // should drop the unpinned one first and keep the pinned set intact.
    const { file, index } = makeFile();
    const cache = new Mp4SampleCache(file, index, 8); // hard ceiling = 32
    await cache.getSample(0);
    await cache.getSample(1);
    await cache.getSample(2);
    cache.setActive([0, 2]);
    cache.setBudgetBytes(8); // over budget by one sample; evict the unpinned
    // Sample 1 (unpinned) goes; pinned 0 and 2 stay (8 bytes resident).
    expect(cache.byteSize()).toBe(8);
    cache.dispose();
  });
});

describe("findIndexAtOrBeforePts", () => {
  const pts = BigInt64Array.from([0n, 100n, 200n, 300n, 400n]);

  it("returns -1 for targets before the first sample", () => {
    expect(findIndexAtOrBeforePts(pts, -10n)).toBe(-1);
  });

  it("returns the largest sample <= target", () => {
    expect(findIndexAtOrBeforePts(pts, 0n)).toBe(0);
    expect(findIndexAtOrBeforePts(pts, 99n)).toBe(0);
    expect(findIndexAtOrBeforePts(pts, 100n)).toBe(1);
    expect(findIndexAtOrBeforePts(pts, 250n)).toBe(2);
    expect(findIndexAtOrBeforePts(pts, 999n)).toBe(4);
  });
});

describe("findKeyframeAtOrBefore", () => {
  const pts = BigInt64Array.from([0n, 33n, 66n, 99n, 132n, 165n]);
  const isSync = Uint8Array.from([1, 0, 0, 1, 0, 0]);

  it("snaps to the largest sync sample <= target", () => {
    expect(findKeyframeAtOrBefore(pts, isSync, 50n)).toBe(0);
    expect(findKeyframeAtOrBefore(pts, isSync, 99n)).toBe(3);
    expect(findKeyframeAtOrBefore(pts, isSync, 200n)).toBe(3);
  });

  it("falls back to the first sync sample when target predates all", () => {
    expect(findKeyframeAtOrBefore(pts, isSync, -100n)).toBe(0);
  });
});
