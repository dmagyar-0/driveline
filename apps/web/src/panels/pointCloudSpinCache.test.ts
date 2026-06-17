import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy the worker-backed range fetch and the Arrow decoder so the cache can be
// exercised without a real store/worker or Arrow bytes. `fetchChannelRange` is
// reached through `useSession.getState()`, so the mock returns a fake store.
const fetchSpy = vi.fn(
  async (channelId: string, startNs: bigint): Promise<Uint8Array> =>
    new TextEncoder().encode(`${channelId}@${startNs}`),
);

vi.mock("../state/store", () => ({
  useSession: { getState: () => ({ fetchChannelRange: fetchSpy }) },
}));

// decodePointCloud echoes the bytes back as a "count" so each (channel, ts)
// maps to a distinguishable, successful result.
const decodeSpy = vi.fn((bytes: Uint8Array) => {
  const s = new TextDecoder().decode(bytes);
  if (s.includes("@-1")) {
    return { ok: false as const, reason: "decode" as const, message: "boom" };
  }
  return {
    ok: true as const,
    tsNs: 0n,
    positions: new Float32Array([1, 2, 3]),
    intensities: new Float32Array([0.5]),
    count: 1,
  };
});

vi.mock("./pointCloudFromArrow", () => ({
  decodePointCloud: (b: Uint8Array) => decodeSpy(b),
}));

import {
  clearPointCloudSpinCache,
  fetchDecodedSpin,
  pointCloudSpinCacheSize,
} from "./pointCloudSpinCache";

beforeEach(() => {
  clearPointCloudSpinCache();
  fetchSpy.mockClear();
  decodeSpy.mockClear();
});

afterEach(() => {
  clearPointCloudSpinCache();
});

describe("fetchDecodedSpin", () => {
  it("decodes a spin once and serves repeats from cache", async () => {
    const a = await fetchDecodedSpin("ch", 100n);
    const b = await fetchDecodedSpin("ch", 100n);
    expect(a).toBe(b); // same object, not a re-decode
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(pointCloudSpinCacheSize()).toBe(1);
  });

  it("coalesces concurrent requests for the same spin into one fetch", async () => {
    const [a, b] = await Promise.all([
      fetchDecodedSpin("ch", 200n),
      fetchDecodedSpin("ch", 200n),
    ]);
    expect(a).toBe(b);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(decodeSpy).toHaveBeenCalledTimes(1);
  });

  it("keys by channel and timestamp", async () => {
    await fetchDecodedSpin("ch", 100n);
    await fetchDecodedSpin("ch", 200n);
    await fetchDecodedSpin("other", 100n);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(pointCloudSpinCacheSize()).toBe(3);
  });

  it("requests the exact [ts, ts+1) one-row window", async () => {
    await fetchDecodedSpin("ch", 555n);
    expect(fetchSpy).toHaveBeenCalledWith("ch", 555n, 556n, false);
  });

  it("evicts the least-recently-used beyond the cap, refetching it later", async () => {
    // Cap is 4. Fill 1..4, then a 5th evicts the oldest (ts=1).
    for (const ts of [1n, 2n, 3n, 4n]) await fetchDecodedSpin("ch", ts);
    expect(pointCloudSpinCacheSize()).toBe(4);
    await fetchDecodedSpin("ch", 5n);
    expect(pointCloudSpinCacheSize()).toBe(4);
    fetchSpy.mockClear();
    // ts=1 was evicted -> refetch; ts=5 is hot -> cached.
    await fetchDecodedSpin("ch", 1n);
    await fetchDecodedSpin("ch", 5n);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a cache hit refreshes recency (LRU, not FIFO)", async () => {
    for (const ts of [1n, 2n, 3n, 4n]) await fetchDecodedSpin("ch", ts);
    await fetchDecodedSpin("ch", 1n); // touch oldest -> now most-recent
    await fetchDecodedSpin("ch", 5n); // evicts ts=2 (now oldest), not ts=1
    fetchSpy.mockClear();
    await fetchDecodedSpin("ch", 1n); // still cached
    expect(fetchSpy).not.toHaveBeenCalled();
    await fetchDecodedSpin("ch", 2n); // was evicted -> refetch
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed decodes", async () => {
    const res = await fetchDecodedSpin("ch", -1n); // decode returns ok:false
    expect(res.ok).toBe(false);
    expect(pointCloudSpinCacheSize()).toBe(0);
    await fetchDecodedSpin("ch", -1n);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // re-attempted, not cached
  });

  it("never throws when the fetch rejects — resolves ok:false", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network"));
    const res = await fetchDecodedSpin("ch", 900n);
    expect(res.ok).toBe(false);
    expect(pointCloudSpinCacheSize()).toBe(0);
  });

  it("clearPointCloudSpinCache empties the cache", async () => {
    await fetchDecodedSpin("ch", 100n);
    expect(pointCloudSpinCacheSize()).toBe(1);
    clearPointCloudSpinCache();
    expect(pointCloudSpinCacheSize()).toBe(0);
  });
});
