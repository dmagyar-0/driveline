// @vitest-environment jsdom
//
// Unit tests for `groupByUnit` and the iter2 issue-#3 axis-tint
// resolver. The grouping algorithm is responsible for two things:
//   1. bucketing channels by unit in first-appearance order so the
//      left/right axes map to the same units across renders;
//   2. assigning a deterministic tint colour per axis so the user can
//      tell which y-axis goes with which trace at a glance.

import { describe, expect, it } from "vitest";
import {
  groupByUnit,
  resolveAxisColor,
  axisLabel,
  NEUTRAL_AXIS_COLOR,
} from "./axisGroups";
import { colorFor } from "./palette";
import type { Channel } from "../state/store";

function mkChannel(over: Partial<Channel>): Channel {
  return {
    id: over.id ?? "id",
    nativeId: over.nativeId ?? "n",
    sourceId: over.sourceId ?? "src",
    name: over.name ?? "/x",
    kind: over.kind ?? "scalar",
    dtype: over.dtype ?? "f64",
    unit: over.unit ?? null,
    sampleCount: over.sampleCount ?? 0,
    timeRange: over.timeRange ?? { startNs: 0n, endNs: 0n },
  };
}

describe("groupByUnit", () => {
  it("buckets channels by unit string in first-appearance order", () => {
    const channels = [
      mkChannel({ id: "a", unit: "m/s" }),
      mkChannel({ id: "b", unit: "rad" }),
      mkChannel({ id: "c", unit: "m/s" }),
    ];
    const groups = groupByUnit(channels);
    expect(groups.map((g) => g.unit)).toEqual(["m/s", "rad"]);
    expect(groups[0].scaleKey).toBe("y");
    expect(groups[1].scaleKey).toBe("y2");
    expect(groups[0].channels.map((c) => c.id)).toEqual(["a", "c"]);
    expect(groups[1].channels.map((c) => c.id)).toEqual(["b"]);
  });

  it("treats null and empty units as one 'unitless' bucket", () => {
    const channels = [
      mkChannel({ id: "a", unit: null }),
      mkChannel({ id: "b", unit: "" }),
    ];
    const groups = groupByUnit(channels);
    expect(groups).toHaveLength(1);
    expect(groups[0].unit).toBe("");
  });
});

describe("resolveAxisColor (Issue #3 — axis tint)", () => {
  it("returns the shared palette colour when every channel hashes to it", () => {
    // Two channels with the same id hash to the same colour.
    const c1 = mkChannel({ id: "same" });
    const c2 = mkChannel({ id: "same" });
    expect(resolveAxisColor([c1, c2])).toBe(colorFor("same"));
  });

  it("returns a neutral tint when channels disagree on palette colour", () => {
    // Find two ids that map to different palette slots; the palette has
    // 8 entries so a small sweep is enough.
    const candidates = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
    let pair: [string, string] | null = null;
    for (let i = 0; i < candidates.length && !pair; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        if (colorFor(candidates[i]) !== colorFor(candidates[j])) {
          pair = [candidates[i], candidates[j]];
          break;
        }
      }
    }
    expect(pair).not.toBeNull();
    const [idA, idB] = pair!;
    expect(
      resolveAxisColor([mkChannel({ id: idA }), mkChannel({ id: idB })]),
    ).toBe(NEUTRAL_AXIS_COLOR);
  });

  it("returns the neutral fallback for an empty group", () => {
    expect(resolveAxisColor([])).toBe(NEUTRAL_AXIS_COLOR);
  });
});

describe("groupByUnit · axisColor wiring", () => {
  it("homogeneous group (single channel) inherits that channel's palette colour", () => {
    const c = mkChannel({ id: "alpha", unit: "m/s" });
    const [g] = groupByUnit([c]);
    expect(g.axisColor).toBe(colorFor("alpha"));
  });

  it("groups with multiple channels surface the neutral tint when palette slots differ", () => {
    const c1 = mkChannel({ id: "alpha", unit: "m/s" });
    const c2 = mkChannel({ id: "beta", unit: "m/s" });
    const c3 = mkChannel({ id: "gamma", unit: "rad" });
    const groups = groupByUnit([c1, c2, c3]);
    const ms = groups.find((g) => g.unit === "m/s")!;
    const rad = groups.find((g) => g.unit === "rad")!;
    // The two `m/s` channels may or may not hash to the same palette
    // slot; assert the contract held: equal colours → that colour;
    // different → neutral.
    const expected =
      colorFor("alpha") === colorFor("beta")
        ? colorFor("alpha")
        : NEUTRAL_AXIS_COLOR;
    expect(ms.axisColor).toBe(expected);
    expect(rad.axisColor).toBe(colorFor("gamma"));
  });
});

describe("axisLabel", () => {
  it("returns the unit when present", () => {
    expect(axisLabel({ scaleKey: "y", unit: "m/s", channels: [], axisColor: NEUTRAL_AXIS_COLOR })).toBe("m/s");
  });
  it("falls back to '(unitless)' for the empty-string bucket", () => {
    expect(axisLabel({ scaleKey: "y", unit: "", channels: [], axisColor: NEUTRAL_AXIS_COLOR })).toBe("(unitless)");
  });
});
