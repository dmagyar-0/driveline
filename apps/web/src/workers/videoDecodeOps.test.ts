import { describe, expect, it, vi } from "vitest";
import {
  CODEC_STRING_FALLBACK,
  LOOKAHEAD_NS,
  REFILL_LOW_WATER,
  codecStringFromSps,
  findSps,
  hex,
  ptsToMicros,
  shouldRefill,
  videoStreamOps,
  type DataCorePortApi,
} from "./videoDecodeOps";
import type * as Comlink from "comlink";

// These were module-private in `videoDecode.worker.ts`. E2e (`videoSeek`,
// `videoMp4`, `crossPanelSync`) was the only guard — a regression in SPS
// parsing surfaces as a `VideoDecoder.configure()` codec-unsupported error
// deep in Chromium, and the refill / dispatch dropdowns only show up as a
// stalled frame loop. Pin the pure pieces here so the worker can't silently
// change semantics.

describe("hex", () => {
  it("produces upper-case 2-char hex padded to 2 digits", () => {
    expect(hex(0)).toBe("00");
    expect(hex(5)).toBe("05");
    expect(hex(0x4a)).toBe("4A");
    expect(hex(0xff)).toBe("FF");
  });
});

describe("findSps", () => {
  it("returns null for a buffer with no start code", () => {
    expect(findSps(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });

  it("returns null when a start code is present but no SPS NAL follows", () => {
    // NAL type 5 (IDR), not 7 (SPS).
    const buf = new Uint8Array([0, 0, 0, 1, 0x65, 0x88, 0x99]);
    expect(findSps(buf)).toBeNull();
  });

  it("finds an SPS following a 4-byte start code and excludes the NAL header byte", () => {
    // 00 00 00 01 | 67 (SPS NAL header) | 64 00 2A (profile, flags, level)
    // Two trailing padding bytes: the inner bound-scan is `j+2 < length`, so
    // the tail always trails the end of the buffer by 2 when no next start
    // code is present. For codec derivation only bytes [0..3] matter.
    const buf = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0x99, 0xaa, 0xbb,
    ]);
    const sps = findSps(buf);
    expect(sps).not.toBeNull();
    expect(Array.from(sps!)).toEqual([0x64, 0x00, 0x2a, 0x99]);
  });

  it("finds an SPS following a 3-byte start code", () => {
    const buf = new Uint8Array([
      0, 0, 1, 0x67, 0x42, 0xc0, 0x1e, 0xaa, 0xbb, 0xcc,
    ]);
    const sps = findSps(buf);
    expect(Array.from(sps!)).toEqual([0x42, 0xc0, 0x1e, 0xaa]);
  });

  it("bounds the SPS at the next 3-byte start code", () => {
    // SPS ... then `00 00 01 65 ...` (IDR) after.
    const buf = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0, 0, 1, 0x65, 0xde,
    ]);
    const sps = findSps(buf);
    expect(Array.from(sps!)).toEqual([0x64, 0x00, 0x2a]);
  });

  it("bounds the SPS at the next 4-byte start code", () => {
    const buf = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e, 0, 0, 0, 1, 0x65, 0xaa,
    ]);
    const sps = findSps(buf);
    expect(Array.from(sps!)).toEqual([0x42, 0xc0, 0x1e]);
  });

  it("skips leading non-SPS NAL units and then returns the first SPS found", () => {
    // AUD (nal type 9) first, then SPS; trailing padding so the scan can
    // reach beyond the last byte we care about (see 4-byte test).
    const buf = new Uint8Array([
      0, 0, 0, 1, 0x09, 0x10, 0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xaa, 0xbb,
    ]);
    const sps = findSps(buf);
    expect(Array.from(sps!)).toEqual([0x64, 0x00, 0x2a]);
  });

  it("handles an empty buffer", () => {
    expect(findSps(new Uint8Array())).toBeNull();
  });
});

describe("codecStringFromSps", () => {
  it("formats profile/flags/level as `avc1.XXXXXX` (uppercase)", () => {
    // High profile (0x64), constraint flags 0x00, level 4.2 (0x2A).
    expect(codecStringFromSps(new Uint8Array([0x64, 0x00, 0x2a]))).toBe(
      "avc1.64002A",
    );
    // Baseline profile (0x42), C0, level 3.0 (0x1E).
    expect(codecStringFromSps(new Uint8Array([0x42, 0xc0, 0x1e]))).toBe(
      "avc1.42C01E",
    );
  });

  it("falls back to the safe default when the SPS is too short", () => {
    // Fewer than 3 bytes means we couldn't recover profile/flags/level; the
    // fallback matches the 4K/30 fixture (High @ L4.2, see T0.2 §4).
    expect(codecStringFromSps(new Uint8Array())).toBe(CODEC_STRING_FALLBACK);
    expect(codecStringFromSps(new Uint8Array([0x64]))).toBe(
      CODEC_STRING_FALLBACK,
    );
    expect(codecStringFromSps(new Uint8Array([0x64, 0x00]))).toBe(
      CODEC_STRING_FALLBACK,
    );
  });

  it("ignores bytes after index 2", () => {
    // The codec string is always derived from the first three bytes.
    expect(
      codecStringFromSps(new Uint8Array([0x64, 0x00, 0x2a, 0xff, 0xff])),
    ).toBe("avc1.64002A");
  });
});

describe("ptsToMicros", () => {
  it("converts ns → µs via integer division (truncating toward zero)", () => {
    expect(ptsToMicros(0n)).toBe(0);
    expect(ptsToMicros(999n)).toBe(0);
    expect(ptsToMicros(1_000n)).toBe(1);
    expect(ptsToMicros(1_999n)).toBe(1);
    expect(ptsToMicros(2_000n)).toBe(2);
  });

  it("preserves frame ordering across Number.MAX_SAFE_INTEGER", () => {
    // Near-simultaneous fixture frames at 1.7e18 ns base + 40ms / 80ms.
    // Result is > MAX_SAFE_INTEGER (9.007e15) so the underlying divide
    // MUST happen in bigint; only the final narrow goes via Number().
    const a = ptsToMicros(1_700_000_000_000_040_000n);
    const b = ptsToMicros(1_700_000_000_000_080_000n);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBe(40);
  });
});

describe("videoStreamOps", () => {
  function makeFakeDc(): Comlink.Remote<DataCorePortApi> {
    const dc = {
      openMcapVideoStream: vi.fn(async () => 11),
      mcapVideoNextBatch: vi.fn(async () => []),
      closeMcapVideoStream: vi.fn(async () => undefined),
    };
    // The production type is Comlink.Remote<DataCorePortApi>; the fake
    // mimics the shape closely enough that the dispatch keeps type-checking.
    return dc as unknown as Comlink.Remote<DataCorePortApi>;
  }

  it("dispatches `mcap` through the mcap_* methods", async () => {
    const dc = makeFakeDc();
    const ops = videoStreamOps(dc, "mcap");
    const result = await ops.open(1, "/camera/front", 0n);
    // mcap stays in Annex-B mode — no `description` is surfaced and the
    // worker leaves `VideoDecoderConfig.description` unset.
    expect(result).toEqual({ streamId: 11, description: null });
    await ops.next(11, 4);
    await ops.close(11);

    const fake = dc as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(fake.openMcapVideoStream).toHaveBeenCalledWith(
      1,
      "/camera/front",
      0n,
    );
    expect(fake.mcapVideoNextBatch).toHaveBeenCalledWith(11, 4);
    expect(fake.closeMcapVideoStream).toHaveBeenCalledWith(11);
  });

  it("dispatches `mp4` through the lazy main-thread port", async () => {
    // mp4 sources no longer round-trip through the dataCore worker —
    // they pull encoded bytes from `Mp4SampleCache` over a separate
    // MessagePort. The dispatcher requires that port to be configured
    // before opening an mp4 source.
    const dc = makeFakeDc();
    const mp4Index = {
      channelId: "1/video",
      ptsNs: BigInt64Array.from([0n, 33_000_000n, 66_000_000n]),
      offsets: BigUint64Array.from([100n, 110n, 120n]),
      sizes: Uint32Array.from([10, 10, 10]),
      isSync: Uint8Array.from([1, 0, 0]),
      sps: new Uint8Array([0x67, 0x42, 0x00, 0x1e]),
      pps: new Uint8Array([0x68, 0xeb]),
    };
    // Raw AVCC sample: 4-byte BE length=1, then a single IDR NAL byte.
    const sampleBody = new Uint8Array([0, 0, 0, 1, 0x65]);
    const mp4Port = {
      mp4Index: vi.fn(async () => mp4Index),
      mp4Sample: vi.fn(async () => sampleBody),
      mp4SetActive: vi.fn(async () => undefined),
      mp4MarkPending: vi.fn(async () => undefined),
      mp4ClearPending: vi.fn(async () => undefined),
    } as unknown as Comlink.Remote<
      import("./videoDecodeOps").Mp4LazyPortApi
    >;
    const ops = videoStreamOps(dc, "mp4", mp4Port);
    const result = await ops.open(2, "1/video", 33_000_000n);
    expect(result.streamId).toBeGreaterThan(0);
    // The mp4 path runs in AVC mode: `open` synthesises an avcC
    // description from the index's SPS+PPS, the worker passes it as
    // `VideoDecoderConfig.description`, and chunks ride raw AVCC bytes.
    expect(result.description).not.toBeNull();
    // configurationVersion=1, then profile/compat/level from SPS[1..4].
    expect(result.description!.slice(0, 4)).toEqual(
      new Uint8Array([0x01, 0x42, 0x00, 0x1e]),
    );
    expect(
      (mp4Port as unknown as Record<string, ReturnType<typeof vi.fn>>)
        .mp4Index,
    ).toHaveBeenCalledWith(2);
    const batch = await ops.next(result.streamId, 2);
    expect(batch.length).toBe(2);
    expect(batch[0].is_keyframe).toBe(true);
    // AVC mode: chunk body is the raw mp4 sample, not Annex-B.
    expect(batch[0].data).toBe(sampleBody);
    await ops.close(result.streamId);
  });

  it("throws when the mp4 port is missing for an mp4 source", () => {
    const dc = makeFakeDc();
    expect(() => videoStreamOps(dc, "mp4")).toThrow(/mp4 lazy port/);
  });
});

describe("shouldRefill", () => {
  // Pacing gate extracted from `videoDecode.worker.ts`. The 4K-decoder fix
  // (commit d9f2b83) lives or dies on this predicate: returning `true` too
  // freely lets a HW decoder drain the encoded stream in a fraction of
  // real-time and freeze the canvas; returning `false` too aggressively
  // stalls seek/open priming.

  it("returns false when in-flight frames are at or above the low-water mark", () => {
    expect(
      shouldRefill({
        inFlight: REFILL_LOW_WATER,
        lastEmittedPtsNs: 0n,
        cursorNs: 0n,
      }),
    ).toBe(false);
    expect(
      shouldRefill({
        inFlight: REFILL_LOW_WATER + 10,
        lastEmittedPtsNs: null,
        cursorNs: 0n,
      }),
    ).toBe(false);
  });

  it("returns true while priming (lastEmittedPtsNs === null) so seek/open converges", () => {
    // Even at 0 in-flight, a fresh stream needs priming pulls.
    expect(
      shouldRefill({
        inFlight: 0,
        lastEmittedPtsNs: null,
        cursorNs: 0n,
      }),
    ).toBe(true);
  });

  it("returns false when the most recent emitted frame is more than LOOKAHEAD_NS ahead", () => {
    // 1 ns past the watermark is enough — the comparison is strict.
    expect(
      shouldRefill({
        inFlight: 0,
        lastEmittedPtsNs: LOOKAHEAD_NS + 1n,
        cursorNs: 0n,
      }),
    ).toBe(false);
  });

  it("returns true at the boundary (lastEmittedPtsNs - cursorNs === LOOKAHEAD_NS)", () => {
    // Pinning the boundary prevents an off-by-one mutation from passing.
    expect(
      shouldRefill({
        inFlight: 0,
        lastEmittedPtsNs: LOOKAHEAD_NS,
        cursorNs: 0n,
      }),
    ).toBe(true);
  });

  it("returns true when the decoder is behind the cursor (catch-up case)", () => {
    // Cursor scrubbed forward; the decoder needs to refill aggressively.
    expect(
      shouldRefill({
        inFlight: 0,
        lastEmittedPtsNs: 1_000_000_000n,
        cursorNs: 5_000_000_000n,
      }),
    ).toBe(true);
  });
});
