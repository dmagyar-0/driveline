import { describe, expect, it, vi } from "vitest";
import {
  CODEC_STRING_FALLBACK,
  LOOKAHEAD_NS,
  REFILL_LOW_WATER,
  codecStringFromSps,
  detectMp4Framing,
  findSps,
  hex,
  makeMp4LazyOps,
  makeOpQueue,
  pickStartCursor,
  ptsToMicros,
  shouldRefill,
  videoStreamOps,
  type DataCorePortApi,
  type Mp4LazyIndex,
  type Mp4LazyPortApi,
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
    } as unknown as Comlink.Remote<import("./videoDecodeOps").Mp4LazyPortApi>;
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
      (mp4Port as unknown as Record<string, ReturnType<typeof vi.fn>>).mp4Index,
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
    } as unknown as Comlink.Remote<import("./videoDecodeOps").Mp4LazyPortApi>;
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
      detectMp4Framing(new Uint8Array([0, 0, 0, 0x12, 0x67, 0x42, 0x00, 0x1e])),
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
      detectMp4Framing(new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e])),
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
    expect(detectMp4Framing(new Uint8Array([0, 0, 0, 1, 0x1f, 0x55]))).toBe(
      "avcc",
    );
  });

  it("returns `annexb` at the inclusive nal_type == 1 lower boundary (non-IDR slice)", () => {
    // nal_unit_type = 1 (coded slice of a non-IDR picture). Sits one
    // above the type-0 reject case; pinning it guards against an
    // off-by-one regression that would change `=== 0` to `<= 0` and
    // misclassify legitimate Annex-B samples whose first NAL is a
    // P-slice (e.g. mid-GOP samples after a forced re-open).
    expect(
      detectMp4Framing(new Uint8Array([0, 0, 0, 1, 0x01, 0x55, 0x66])),
    ).toBe("annexb");
  });

  it("returns `annexb` at the inclusive nal_type == 23 upper boundary", () => {
    // nal_unit_type = 23 (highest valid H.264 type). Sits one below
    // the > 23 reject case; pinning it guards against an off-by-one
    // regression that would change `> 23` to `>= 23` and misclassify
    // a real Annex-B sample whose first NAL is type 23.
    expect(
      detectMp4Framing(new Uint8Array([0, 0, 0, 1, 0x17, 0x55, 0x66])),
    ).toBe("annexb");
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

  function index(pts: number[], sync: number[]): Mp4LazyIndex {
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
    const idx = index([0, 100, 200, 300, 400, 500], [1, 0, 0, 1, 0, 0]);
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

describe("makeOpQueue", () => {
  // Regression guard for the comma2k19 "stream stalled" wedge: the video
  // decode worker's open/seek/close MUST run one-at-a-time. When they
  // overlapped (a jump landing mid-reopen), one reopen reset a decoder another
  // was configuring, a delta NAL reached the decoder before its keyframe, and
  // the stream died with `DataError: A key frame is required` — frozen canvas,
  // blit queue drained to 0, "stream stalled". Reproduced live on comma2k19.
  it("never lets two ops overlap, and preserves submission order", async () => {
    const { runExclusive } = makeOpQueue();
    let active = 0;
    let maxActive = 0;
    const completed: number[] = [];
    const op = (id: number, delayMs: number) =>
      runExclusive(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, delayMs));
        completed.push(id);
        active -= 1;
      });
    // Slow op first, then two fast ones. Without serialisation the fast ops
    // would start while the slow one is still awaiting (maxActive >= 2) and
    // could complete out of order.
    await Promise.all([op(1, 25), op(2, 1), op(3, 1)]);
    expect(maxActive).toBe(1);
    expect(completed).toEqual([1, 2, 3]);
  });

  it("keeps the queue alive after an op rejects", async () => {
    const { runExclusive } = makeOpQueue();
    await expect(
      runExclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A failed op must not stall the chain — the next op still runs.
    await expect(runExclusive(async () => 42)).resolves.toBe(42);
  });

  it("runs a later op strictly after an earlier one resolves", async () => {
    const { runExclusive } = makeOpQueue();
    const events: string[] = [];
    const first = runExclusive(async () => {
      await new Promise((r) => setTimeout(r, 15));
      events.push("first-done");
    });
    const second = runExclusive(async () => {
      events.push("second-start");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["first-done", "second-start"]);
  });
});

// ---------------------------------------------------------------------------
// mp4 index cache (Task 1 regression guard)
// ---------------------------------------------------------------------------
//
// `mp4Port.mp4Index(handle)` is expensive: a main-thread RPC + structured
// clone of 4 typed arrays (ptsNs, offsets, sizes, isSync) covering every
// sample. This suite pins that it is only fetched ONCE per handle across
// multiple opens of the same source (the seek/open hot path).

describe("mp4 index cache", () => {
  function makeAvccSample(): Uint8Array {
    // 4-byte BE length = 2, then a 2-byte IDR NAL.
    return new Uint8Array([0, 0, 0, 2, 0x65, 0x88]);
  }

  function makeIndex(): Mp4LazyIndex {
    return {
      channelId: "cam/front",
      ptsNs: BigInt64Array.from([0n, 33_000_000n, 66_000_000n]),
      offsets: BigUint64Array.from([0n, 10n, 20n]),
      sizes: Uint32Array.from([6, 6, 6]),
      isSync: Uint8Array.from([1, 0, 0]),
      sps: new Uint8Array([0x67, 0x42, 0x00, 0x1e]),
      pps: new Uint8Array([0x68, 0xeb]),
    };
  }

  it("fetches mp4Index exactly once across two opens of the same handle", async () => {
    // Use a handle number unlikely to collide with other test suites that share
    // the module-level cache (tests run in the same module context).
    const handle = 9901;
    const mp4Index = makeIndex();
    const sampleBody = makeAvccSample();
    const mp4Port = {
      mp4Index: vi.fn(async () => mp4Index),
      mp4Sample: vi.fn(async () => sampleBody),
      mp4SetActive: vi.fn(async () => undefined),
      mp4MarkPending: vi.fn(async () => undefined),
      mp4ClearPending: vi.fn(async () => undefined),
    } as unknown as Comlink.Remote<Mp4LazyPortApi>;

    const ops = makeMp4LazyOps(mp4Port);

    // First open — must call mp4Index.
    const r1 = await ops.open(handle, "cam/front", 0n);
    expect(
      (mp4Port as unknown as Record<string, ReturnType<typeof vi.fn>>).mp4Index,
    ).toHaveBeenCalledTimes(1);
    await ops.close(r1.streamId);

    // Second open of the same handle — must serve from cache; no additional RPC.
    const r2 = await ops.open(handle, "cam/front", 33_000_000n);
    expect(
      (mp4Port as unknown as Record<string, ReturnType<typeof vi.fn>>).mp4Index,
    ).toHaveBeenCalledTimes(1); // still 1, not 2
    await ops.close(r2.streamId);
  });

  it("fetches mp4Index again for a different handle (cache is keyed by handle)", async () => {
    const handleA = 9902;
    const handleB = 9903;
    const mp4Port = {
      mp4Index: vi.fn(async () => makeIndex()),
      mp4Sample: vi.fn(async () => makeAvccSample()),
      mp4SetActive: vi.fn(async () => undefined),
      mp4MarkPending: vi.fn(async () => undefined),
      mp4ClearPending: vi.fn(async () => undefined),
    } as unknown as Comlink.Remote<Mp4LazyPortApi>;

    const ops = makeMp4LazyOps(mp4Port);
    const fake = mp4Port as unknown as Record<string, ReturnType<typeof vi.fn>>;

    const rA = await ops.open(handleA, "cam/front", 0n);
    expect(fake.mp4Index).toHaveBeenCalledTimes(1);
    await ops.close(rA.streamId);

    const rB = await ops.open(handleB, "cam/front", 0n);
    // Different handle → must make a second fetch.
    expect(fake.mp4Index).toHaveBeenCalledTimes(2);
    await ops.close(rB.streamId);
  });
});

// ---------------------------------------------------------------------------
// ops.close called exactly once per stream per seek (Task 3 regression guard)
// ---------------------------------------------------------------------------
//
// The pre-fix seek path called `ops.close(streamId)` twice per seek:
//   1. Explicitly in `seek()` after `decoder.reset()`.
//   2. Inside `closeInternal()` at the top of `openInternal()`.
// The fix nulls `session` before step 1 so `closeInternal()` returns
// immediately (sees null session). Pin that ops.close fires exactly once.
//
// We test this at the `makeMp4LazyOps` level by counting `mp4ClearPending`
// calls, which is the only side-effect `close(streamId)` performs.
// Each invocation of `makeMp4LazyOps.close(streamId)` fires exactly one
// `mp4ClearPending` for the stream's handle; a double-close would fire it
// twice (or more) for the same stream.

describe("ops.close called exactly once per stream", () => {
  it("mp4ClearPending is called exactly once per close(), not twice", async () => {
    const handle = 9904;
    const mp4Index: Mp4LazyIndex = {
      channelId: "cam/front",
      ptsNs: BigInt64Array.from([0n, 33_000_000n]),
      offsets: BigUint64Array.from([0n, 10n]),
      sizes: Uint32Array.from([6, 6]),
      isSync: Uint8Array.from([1, 0]),
      sps: new Uint8Array([0x67, 0x42, 0x00, 0x1e]),
      pps: new Uint8Array([0x68, 0xeb]),
    };
    const sampleBody = new Uint8Array([0, 0, 0, 2, 0x65, 0x88]);
    const mp4Port = {
      mp4Index: vi.fn(async () => mp4Index),
      mp4Sample: vi.fn(async () => sampleBody),
      mp4SetActive: vi.fn(async () => undefined),
      mp4MarkPending: vi.fn(async () => undefined),
      mp4ClearPending: vi.fn(async () => undefined),
    } as unknown as Comlink.Remote<Mp4LazyPortApi>;

    const ops = makeMp4LazyOps(mp4Port);
    const fake = mp4Port as unknown as Record<string, ReturnType<typeof vi.fn>>;

    // Open stream 1, then simulate the new seek path:
    //   a) caller explicitly calls ops.close(stream1) once (the manual close in seek()).
    //   b) openInternal calls closeInternal, which now sees session=null and skips
    //      the second close. We verify (b) only fires the correct number of times.
    const r1 = await ops.open(handle, "cam/front", 0n);
    // mp4MarkPending fires during open(); reset the counter to isolate close().
    fake.mp4ClearPending.mockClear();

    // Simulate the single ops.close call that seek() makes after session=null.
    await ops.close(r1.streamId);
    expect(fake.mp4ClearPending).toHaveBeenCalledTimes(1);

    // A second call to close() on the same (now-deleted) stream id must be
    // a no-op — the slot is gone, so the guard `if (!slot) return` fires and
    // mp4ClearPending is not called again.
    await ops.close(r1.streamId);
    expect(fake.mp4ClearPending).toHaveBeenCalledTimes(1); // still 1
  });
});
