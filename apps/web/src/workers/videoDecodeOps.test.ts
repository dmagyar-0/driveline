import { describe, expect, it, vi } from "vitest";
import {
  CODEC_STRING_FALLBACK,
  LOOKAHEAD_NS,
  REFILL_LOW_WATER,
  codecStringFromSps,
  detectMp4Framing,
  findSps,
  hex,
  pickStartCursor,
  ptsToMicros,
  shouldRefill,
  videoStreamOps,
  type DataCorePortApi,
  type Mp4LazyIndex,
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
    // worker leaves `VideoDecoderConfig.description` unset. The `framing`
    // field is part of the union type; mcap reports `"avcc"` since the
    // decoder code only consults it in conjunction with a non-null
    // description (and mcap's description is null).
    expect(result).toEqual({
      streamId: 11,
      description: null,
      framing: "avcc",
    });
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
    // Raw AVCC sample: 4-byte BE length=2, then a 2-byte IDR NAL.
    // (Length=1 would collide with the Annex-B start-code sniff.) The body
    // is opaque to the dispatch logic; only the framing detector ever
    // looks at the leading bytes.
    const sampleBody = new Uint8Array([0, 0, 0, 2, 0x65, 0x88]);
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

  it("detects Annex-B framing in mp4 sources and emits raw bytes without a description", async () => {
    // The non-standard Annex-B mp4 fixture (`scripts/video/make_annexb_mp4.py`)
    // overwrites the 4-byte length prefix in mdat with a `00 00 00 01` start
    // code, leaving the rest of the sample bytes intact. The detector picks
    // that up at `open()` time, the worker switches to Annex-B mode (no
    // description, no `stripInlineParameterSets`), and chunks ride straight
    // through to the decoder — same shape the mcap path uses.
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
    // 00 00 00 01 (start code) | 0x67 (SPS NAL header) | trailing payload.
    const annexBSample = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0x99,
    ]);
    const mp4Port = {
      mp4Index: vi.fn(async () => mp4Index),
      mp4Sample: vi.fn(async () => annexBSample),
      mp4SetActive: vi.fn(async () => undefined),
      mp4MarkPending: vi.fn(async () => undefined),
      mp4ClearPending: vi.fn(async () => undefined),
    } as unknown as Comlink.Remote<
      import("./videoDecodeOps").Mp4LazyPortApi
    >;
    const ops = videoStreamOps(dc, "mp4", mp4Port);
    const result = await ops.open(7, "1/video", 0n);
    // Annex-B mode: no avcC description, framing surfaced as `"annexb"`.
    expect(result.description).toBeNull();
    expect(result.framing).toBe("annexb");
    // First `next()` reuses the bytes captured during framing detection
    // instead of refetching: `mp4Sample` was called exactly once (at open),
    // and the emitted body is the same reference.
    const fakePort = mp4Port as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(fakePort.mp4Sample).toHaveBeenCalledTimes(1);
    const batch = await ops.next(result.streamId, 1);
    expect(batch.length).toBe(1);
    expect(batch[0].is_keyframe).toBe(true);
    // Verbatim pass-through — no `stripInlineParameterSets` reformatting.
    expect(batch[0].data).toBe(annexBSample);
    // Still only one fetch: the open() bytes were reused for the first
    // emitted chunk.
    expect(fakePort.mp4Sample).toHaveBeenCalledTimes(1);
    // The next pull goes back to the cache as usual.
    await ops.next(result.streamId, 1);
    expect(fakePort.mp4Sample).toHaveBeenCalledTimes(2);
    await ops.close(result.streamId);
  });
});

describe("detectMp4Framing", () => {
  // The detector runs once per mp4 `open()` against the first sample. It
  // must distinguish standard AVCC layout (4-byte BE length prefix) from
  // the Annex-B start-code layout produced by
  // `scripts/video/make_annexb_mp4.py`. False positives in either
  // direction wedge `VideoDecoder.configure()` with an opaque error, so
  // pin every realistic boundary case here.

  it("returns `avcc` for length-prefixed samples (typical x264 mp4)", () => {
    // 4-byte BE length = 0x12 (18 bytes), then SPS NAL header byte.
    expect(
      detectMp4Framing(
        new Uint8Array([0, 0, 0, 0x12, 0x67, 0x42, 0x00, 0x1e]),
      ),
    ).toBe("avcc");
    // A larger length still well below the 16M boundary.
    expect(
      detectMp4Framing(
        new Uint8Array([0, 0, 0x40, 0x00, 0x67, 0x42, 0x00, 0x1e]),
      ),
    ).toBe("avcc");
  });

  it("returns `annexb` for samples that begin with `00 00 00 01` plus a valid NAL header", () => {
    // SPS (type 7) — the synthesized Annex-B fixture's first NAL.
    expect(
      detectMp4Framing(
        new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e]),
      ),
    ).toBe("annexb");
    // IDR slice (type 5) — also a valid first-NAL kind in the wild.
    expect(
      detectMp4Framing(new Uint8Array([0, 0, 0, 1, 0x65, 0x88, 0x99])),
    ).toBe("annexb");
    // AUD (type 9) — some encoders emit an AUD before the SPS.
    expect(detectMp4Framing(new Uint8Array([0, 0, 0, 1, 0x09, 0x10]))).toBe(
      "annexb",
    );
  });

  it("returns `avcc` for the pathological 16M-NAL whose byte[4] has forbidden_zero_bit set", () => {
    // Length prefix `00 00 00 01` (= 16,777,217-byte NAL) but byte[4]'s
    // top bit is the H.264 forbidden_zero_bit. A real Annex-B NAL header
    // never sets it; treat as AVCC.
    expect(
      detectMp4Framing(new Uint8Array([0, 0, 0, 1, 0x80, 0x00, 0x00])),
    ).toBe("avcc");
  });

  it("returns `avcc` when byte[4] decodes to nal_type 0 (unspecified)", () => {
    // forbidden_zero_bit clear, nal_unit_type = 0. No conformant H.264
    // stream starts a sample with type 0.
    expect(
      detectMp4Framing(new Uint8Array([0, 0, 0, 1, 0x00, 0xff, 0xff])),
    ).toBe("avcc");
  });

  it("returns `avcc` when byte[4] decodes to nal_type > 23 (reserved/extension)", () => {
    // nal_unit_type = 24 (forbidden_zero_bit clear, low 5 bits = 24).
    expect(
      detectMp4Framing(new Uint8Array([0, 0, 0, 1, 0x18, 0x55, 0x66])),
    ).toBe("avcc");
    // nal_unit_type = 31 (max 5-bit value).
    expect(
      detectMp4Framing(new Uint8Array([0, 0, 0, 1, 0x1f, 0x55])),
    ).toBe("avcc");
  });

  it("returns `avcc` for samples shorter than 5 bytes (defensive)", () => {
    expect(detectMp4Framing(new Uint8Array())).toBe("avcc");
    expect(detectMp4Framing(new Uint8Array([0, 0, 0, 1]))).toBe("avcc");
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

describe("pickStartCursor", () => {
  // The mp4 lazy-load path opens the decoder at the largest sync sample
  // whose PTS is `<= target`. A regression here either over-rewinds (waste
  // of decode) or — much worse — starts mid-GOP and the decoder emits a
  // long string of corrupt frames until the next keyframe. Both surface
  // only via end-to-end video playback, so pin the dispatch points here.

  function index(
    pts: number[],
    sync: number[],
  ): Mp4LazyIndex {
    return {
      channelId: "1/video",
      ptsNs: BigInt64Array.from(pts.map((p) => BigInt(p))),
      offsets: BigUint64Array.from(pts.map((_, i) => BigInt(i * 100))),
      sizes: Uint32Array.from(pts.map(() => 100)),
      isSync: Uint8Array.from(sync),
      sps: new Uint8Array(),
      pps: new Uint8Array(),
    };
  }

  it("returns 0 for an empty index (no samples to seek to)", () => {
    expect(pickStartCursor(index([], []), 0n)).toBe(0);
    // Negative target on an empty index also returns 0 — the caller
    // guards against indexing into the empty array.
    expect(pickStartCursor(index([], []), -1n)).toBe(0);
  });

  it("snaps to the first sync sample when target predates every sample", () => {
    // Sync only at indices 0 and 3. Target before sample 0's PTS → must
    // start at the first sync (index 0) so the decoder still gets a
    // decodable prefix. Falling back to mid-GOP would emit garbage frames.
    const idx = index([100, 200, 300, 400, 500], [1, 0, 0, 1, 0]);
    expect(pickStartCursor(idx, 50n)).toBe(0);
  });

  it("snaps exactly onto a sync sample whose PTS equals target", () => {
    const idx = index([0, 100, 200, 300, 400], [1, 0, 0, 1, 0]);
    expect(pickStartCursor(idx, 300n)).toBe(3);
  });

  it("walks back from a non-sync candidate to the preceding sync sample", () => {
    // Target lands on a delta frame (index 2). The decoder cannot start
    // there; it must rewind to the keyframe at index 0.
    const idx = index([0, 100, 200, 300, 400], [1, 0, 0, 1, 0]);
    expect(pickStartCursor(idx, 250n)).toBe(0);
  });

  it("snaps to the largest sync sample <= target across multiple GOPs", () => {
    // Two GOPs: [0..2] starting at sync index 0, [3..5] starting at sync
    // index 3. Target inside the second GOP must rewind to its keyframe.
    const idx = index(
      [0, 100, 200, 300, 400, 500],
      [1, 0, 0, 1, 0, 0],
    );
    expect(pickStartCursor(idx, 450n)).toBe(3);
    expect(pickStartCursor(idx, 500n)).toBe(3);
  });

  it("handles a target past the final sample (snap to last sync)", () => {
    // Common at end-of-session: the cursor sits at endNs. The decoder
    // should still open at the latest keyframe, not at the empty tail.
    const idx = index([0, 100, 200, 300, 400], [1, 0, 0, 1, 0]);
    expect(pickStartCursor(idx, 9_999n)).toBe(3);
  });

  it("returns index 0 when no sync samples are present (treat as keyframe-only)", () => {
    // Pathological track with `isSync` all-zero. The fallback assigns
    // `firstSync = 0` so we still emit a decodable prefix from sample 0
    // rather than throwing or returning -1.
    const idx = index([0, 100, 200], [0, 0, 0]);
    expect(pickStartCursor(idx, 150n)).toBe(0);
    expect(pickStartCursor(idx, -100n)).toBe(0);
  });

  it("never returns an index > target's PTS sample (mutation guard)", () => {
    // Across a 1024-sample GOP grid, the picked index's PTS must always
    // be `<= target` and `isSync === 1`. Sweeping random targets pins the
    // binary-search bounds against off-by-one mutations.
    const N = 64;
    const pts = Array.from({ length: N }, (_, i) => i * 100);
    const sync = Array.from({ length: N }, (_, i) => (i % 8 === 0 ? 1 : 0));
    const idx = index(pts, sync);
    for (let t = -50; t <= 7_000; t += 37) {
      const r = pickStartCursor(idx, BigInt(t));
      expect(idx.isSync[r]).toBe(1);
      // The fallback rule allows the result's PTS to exceed target only
      // when target predates every sample — i.e. we returned the first
      // sync. Otherwise picked PTS must be <= target.
      const pickedPts = Number(idx.ptsNs[r]);
      if (t < pts[0]) {
        expect(r).toBe(0);
      } else {
        expect(pickedPts).toBeLessThanOrEqual(t);
      }
    }
  });
});
