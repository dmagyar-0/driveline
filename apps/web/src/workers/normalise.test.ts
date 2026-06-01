import { describe, expect, it } from "vitest";
import {
  normaliseEncodedChunk,
  normaliseMcap,
  normaliseMf4,
  normaliseMp4,
  toBig,
  type RawEncodedChunk,
  type RawMcapSummary,
  type RawMf4Summary,
  type RawMp4Summary,
} from "./normalise";

// serde_wasm_bindgen serialises i64 as JS `number` within the safe-integer
// range and as `bigint` outside it. The real mp4 fixture uses ns timestamps
// near 1.7e18 (> 2^53), so every summary / video chunk coming out of the
// worker crosses the boundary. Pin the translation both ways.
//
// Previously these helpers were module-private; e2e was the only guard. A
// regression would silently drop ns precision on the mp4 timeline and only
// surface as a wrong-time seek in the UI.

describe("toBig", () => {
  it("passes bigint values through unchanged", () => {
    expect(toBig(0n)).toBe(0n);
    expect(toBig(1_700_000_000_000_000_000n)).toBe(1_700_000_000_000_000_000n);
  });

  it("converts safe-integer numbers to bigint", () => {
    expect(toBig(0)).toBe(0n);
    expect(toBig(1_000)).toBe(1_000n);
    // MAX_SAFE_INTEGER fits in Number and BigInt() handles it losslessly.
    expect(toBig(Number.MAX_SAFE_INTEGER)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });

  it("parses numeric strings — serde_wasm_bindgen may emit string for i64", () => {
    expect(toBig("1700000000000000000")).toBe(1_700_000_000_000_000_000n);
  });

  it("round-trips bigint values above Number.MAX_SAFE_INTEGER without loss", () => {
    // Plain `Number(bigStr)` would lose precision; the normaliser must go
    // through BigInt. Pin the three sample magnitudes the corpus hits:
    //   - the real mp4 base (1.7e18)
    //   - base + 1 (unit distinct from base)
    //   - a value well past (1 << 62)
    const samples: bigint[] = [
      1_700_000_000_000_000_000n,
      1_700_000_000_000_000_001n,
      1n << 62n,
    ];
    for (const v of samples) {
      expect(toBig(v)).toBe(v);
    }
  });
});

describe("normaliseMf4", () => {
  it("coerces number channels into bigint", () => {
    const raw: RawMf4Summary = {
      start_ns: 1_000,
      end_ns: 5_000,
      channels: [
        {
          id: "0/speed",
          name: "speed",
          unit: "m/s",
          sample_count: 3,
          start_ns: 1_000,
          end_ns: 5_000,
        },
      ],
    };
    const s = normaliseMf4(raw);
    expect(s.start_ns).toBe(1_000n);
    expect(s.end_ns).toBe(5_000n);
    expect(s.channels[0].start_ns).toBe(1_000n);
    expect(s.channels[0].end_ns).toBe(5_000n);
    expect(s.channels[0].sample_count).toBe(3);
  });

  it("preserves bigint channels beyond the safe-integer range", () => {
    const raw: RawMf4Summary = {
      start_ns: 1_700_000_000_000_000_000n,
      end_ns: 1_700_000_000_000_000_500n,
      channels: [
        {
          id: "0/speed",
          name: "speed",
          unit: null,
          sample_count: 1,
          start_ns: 1_700_000_000_000_000_000n,
          end_ns: 1_700_000_000_000_000_500n,
        },
      ],
    };
    const s = normaliseMf4(raw);
    expect(s.start_ns).toBe(1_700_000_000_000_000_000n);
    expect(s.channels[0].end_ns).toBe(1_700_000_000_000_000_500n);
  });

  it("forwards the channel-group label and defaults a missing one to null", () => {
    const raw: RawMf4Summary = {
      start_ns: 0,
      end_ns: 1,
      channels: [
        {
          id: "0/speed",
          name: "speed",
          unit: null,
          group: "Powertrain",
          sample_count: 1,
          start_ns: 0,
          end_ns: 1,
        },
        {
          id: "1/rpm",
          name: "rpm",
          unit: null,
          sample_count: 1,
          start_ns: 0,
          end_ns: 1,
        },
      ],
    };
    const s = normaliseMf4(raw);
    expect(s.channels[0].group).toBe("Powertrain");
    expect(s.channels[1].group).toBeNull();
  });
});

describe("normaliseMcap", () => {
  it("forwards channel kind/dtype and coerces ns boundaries", () => {
    const raw: RawMcapSummary = {
      start_ns: 0,
      end_ns: 10_000,
      channels: [
        {
          id: "/imu/accel",
          name: "/imu/accel",
          kind: "vector",
          dtype: "f64",
          unit: "m/s^2",
          sample_count: 10,
          start_ns: 0,
          end_ns: 10_000,
        },
        {
          id: "/camera/front",
          name: "/camera/front",
          kind: "video",
          dtype: null,
          unit: null,
          sample_count: 5,
          start_ns: 1_700_000_000_000_000_000n,
          end_ns: 1_700_000_000_000_000_160n,
        },
      ],
    };
    const s = normaliseMcap(raw);
    expect(s.channels[0].kind).toBe("vector");
    expect(s.channels[0].start_ns).toBe(0n);
    expect(s.channels[1].kind).toBe("video");
    expect(s.channels[1].start_ns).toBe(1_700_000_000_000_000_000n);
    expect(s.channels[1].end_ns).toBe(1_700_000_000_000_000_160n);
  });
});

describe("normaliseMp4", () => {
  it("preserves bigint mp4 fixture values above MAX_SAFE_INTEGER", () => {
    // The gen_mp4_fixture uses a 1.7e18 ns base, so every field crossing
    // the wasm boundary arrives as bigint. A regression that dropped the
    // `typeof === "bigint"` early-exit in `toBig` would produce
    // `BigInt(Number(bigintVal))` — lossy.
    const raw: RawMp4Summary = {
      start_ns: 1_700_000_000_000_000_000n,
      end_ns: 1_700_000_000_000_000_333n,
      channels: [
        {
          id: "1/video",
          name: "video",
          sample_count: 10,
          start_ns: 1_700_000_000_000_000_000n,
          end_ns: 1_700_000_000_000_000_333n,
        },
      ],
    };
    const s = normaliseMp4(raw);
    expect(s.start_ns).toBe(1_700_000_000_000_000_000n);
    expect(s.end_ns).toBe(1_700_000_000_000_000_333n);
    expect(s.channels[0].start_ns).toBe(1_700_000_000_000_000_000n);
    expect(s.channels[0].end_ns).toBe(1_700_000_000_000_000_333n);
  });
});

describe("normaliseEncodedChunk", () => {
  it("coerces pts_ns and forces is_keyframe to boolean", () => {
    const data = new Uint8Array([0, 0, 0, 1, 0x67]);
    const raw: RawEncodedChunk = {
      pts_ns: 42,
      is_keyframe: 1 as unknown as boolean,
      data,
    };
    const c = normaliseEncodedChunk(raw);
    expect(c.pts_ns).toBe(42n);
    expect(c.is_keyframe).toBe(true);
    // The byte buffer passes through by reference — no copy.
    expect(c.data).toBe(data);
  });

  it("preserves bigint pts above MAX_SAFE_INTEGER per access unit", () => {
    // mcap_video_next_batch / mp4_video_next_batch run toBig on every
    // chunk. Loss here → every decoded frame tagged with a truncated PTS
    // → the VideoPanel renderer's pts <= cursor predicate becomes
    // meaningless. Guard the exact fixture magnitude.
    const pts = 1_700_000_000_000_040_000n;
    const c = normaliseEncodedChunk({
      pts_ns: pts,
      is_keyframe: true,
      data: new Uint8Array(),
    });
    expect(c.pts_ns).toBe(pts);
  });
});
