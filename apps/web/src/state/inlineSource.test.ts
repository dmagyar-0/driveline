// Inline-source storage + ranged Arrow IPC. Proves the batches built here
// round-trip through `decodeSeries` (the exact schema the strip/plot panels
// consume) to the right xs/ys/rawTsNs, and that the `[startNs, endNs)` window,
// `includePrev` step-hold, and degenerate-range handling behave.

import { afterEach, describe, expect, it } from "vitest";
import { decodeSeries } from "../panels/seriesFromArrow";
import {
  setInlineSource,
  resetInlineSources,
  fetchRange,
  type InlineChannelData,
} from "./inlineSource";

afterEach(() => resetInlineSources());

function seedScalar(): void {
  // ts = 0,10,20,30,40 ; value = ts/10
  const tsNs = new BigInt64Array([0n, 10n, 20n, 30n, 40n]);
  const values = Float64Array.from([0, 1, 2, 3, 4]);
  const ch: InlineChannelData = { kind: "scalar", tsNs, values };
  setInlineSource("src", new Map([["sig", ch]]));
}

function seedEnum(): void {
  const tsNs = new BigInt64Array([0n, 10n, 20n]);
  const values = Int32Array.from([5, 6, 7]);
  setInlineSource("esrc", new Map([["e", { kind: "enum", tsNs, values }]]));
}

function decode(bytes: Uint8Array | null) {
  expect(bytes).not.toBeNull();
  const res = decodeSeries(bytes!);
  if (!res.ok) throw new Error(`decode failed: ${res.reason} ${res.message}`);
  return res;
}

describe("fetchRange — scalar round-trip", () => {
  it("returns only samples in [startNs, endNs)", () => {
    seedScalar();
    // [10, 30) → ts 10, 20 (30 excluded by the half-open upper bound).
    const res = decode(fetchRange("src", "sig", 10n, 30n, false));
    expect(res.kind).toBe("scalar");
    expect([...res.rawTsNs]).toEqual([10n, 20n]);
    expect([...res.ys]).toEqual([1, 2]);
    // xs are ns→seconds.
    expect(res.xs[0]).toBeCloseTo(10 / 1e9, 12);
  });

  it("includePrev prepends the last sample before the window", () => {
    seedScalar();
    // [20, 40) with prev → ts 10 (held), 20, 30.
    const res = decode(fetchRange("src", "sig", 20n, 40n, true));
    expect([...res.rawTsNs]).toEqual([10n, 20n, 30n]);
    expect([...res.ys]).toEqual([1, 2, 3]);
  });

  it("includePrev at the very start has no prior sample", () => {
    seedScalar();
    const res = decode(fetchRange("src", "sig", 0n, 20n, true));
    expect([...res.rawTsNs]).toEqual([0n, 10n]);
  });

  it("an empty window decodes to an empty (ok) series", () => {
    seedScalar();
    // No samples in [11, 12).
    const res = decode(fetchRange("src", "sig", 11n, 12n, false));
    expect(res.rawTsNs.length).toBe(0);
    expect(res.ys.length).toBe(0);
  });

  it("a degenerate window (end <= start) with includePrev still holds", () => {
    seedScalar();
    // end <= start, but includePrev → just the held sample before 25.
    const res = decode(fetchRange("src", "sig", 25n, 25n, true));
    expect([...res.rawTsNs]).toEqual([20n]);
  });

  it("a degenerate window without includePrev is empty", () => {
    seedScalar();
    const res = decode(fetchRange("src", "sig", 25n, 25n, false));
    expect(res.rawTsNs.length).toBe(0);
  });
});

describe("fetchRange — enum round-trip", () => {
  it("decodes the code column as an enum series", () => {
    seedEnum();
    const res = decode(fetchRange("esrc", "e", 0n, 20n, false));
    expect(res.kind).toBe("enum");
    expect([...res.rawTsNs]).toEqual([0n, 10n]);
    expect([...res.ys]).toEqual([5, 6]);
  });
});

describe("fetchRange — unknown source/channel", () => {
  it("returns null", () => {
    seedScalar();
    expect(fetchRange("nope", "sig", 0n, 10n, false)).toBeNull();
    expect(fetchRange("src", "nope", 0n, 10n, false)).toBeNull();
  });
});
