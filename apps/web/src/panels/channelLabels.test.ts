// @vitest-environment jsdom
//
// Unit tests for the chip label helpers. The most important assertion
// here is `shouldShowSourceBadges` — the designer audit found that the
// v1 collision-only rule hid the source badge on the most common
// cross-source pattern (two files, distinct channel names) where the
// user most needs to know which file each chip came from. Issue #2 of
// the iter2 UX overhaul flips the rule to "≥2 distinct sources →
// always show the badge".

import { describe, expect, it } from "vitest";
import {
  shortChannelLabel,
  shouldShowSourceBadges,
  shortenSourceName,
  sourceBadge,
  fullChannelLabel,
} from "./channelLabels";
import type { Channel, SourceMeta } from "../state/store";

function mkChannel(over: Partial<Channel>): Channel {
  return {
    id: over.id ?? "id",
    nativeId: over.nativeId ?? "n",
    sourceId: over.sourceId ?? "src",
    name: over.name ?? "/vehicle/speed",
    kind: over.kind ?? "scalar",
    dtype: over.dtype ?? "f64",
    unit: over.unit ?? null,
    sampleCount: over.sampleCount ?? 0,
    timeRange: over.timeRange ?? { startNs: 0n, endNs: 0n },
  };
}

function mkSource(id: string, name: string): SourceMeta {
  return {
    id,
    kind: "mcap",
    name,
    handle: 0,
    timeRange: { startNs: 0n, endNs: 0n },
    channels: [],
  };
}

describe("shortChannelLabel", () => {
  it("returns the trailing path segment when slashes are present", () => {
    expect(shortChannelLabel(mkChannel({ name: "/vehicle/speed" }))).toBe(
      "speed",
    );
  });

  it("returns the full name when there is no slash", () => {
    expect(shortChannelLabel(mkChannel({ name: "RPM" }))).toBe("RPM");
  });

  it("returns the empty string when the name is missing", () => {
    // Bypass the `mkChannel` defaulting (which would replace `undefined`
    // with `/vehicle/speed`) by mutating the field after construction —
    // we want to exercise the helper's defensive nullish path explicitly.
    const c = mkChannel({});
    (c as unknown as { name: string | undefined }).name = undefined;
    expect(shortChannelLabel(c)).toBe("");
  });
});

describe("fullChannelLabel", () => {
  it("appends the unit in parens when present", () => {
    expect(
      fullChannelLabel(mkChannel({ name: "/vehicle/speed", unit: "m/s" })),
    ).toBe("/vehicle/speed (m/s)");
  });

  it("returns the bare name when the unit is null", () => {
    expect(fullChannelLabel(mkChannel({ name: "RPM", unit: null }))).toBe(
      "RPM",
    );
  });
});

describe("shortenSourceName", () => {
  it("strips the path and extension", () => {
    expect(shortenSourceName("/tmp/foo.mcap")).toBe("foo");
  });
  it("truncates very long stems", () => {
    const long = "comma2k19-segment-12_2018-08-13-15-08-32_03.mcap";
    const stem = shortenSourceName(long);
    expect(stem.length).toBeLessThan(20);
    expect(stem).toContain("…");
  });
  it("returns empty for an empty input", () => {
    expect(shortenSourceName("")).toBe("");
  });
});

describe("sourceBadge", () => {
  it("returns the shortened name of the channel's source", () => {
    const sources = [mkSource("a", "a.mcap"), mkSource("b", "b.mf4")];
    expect(sourceBadge(mkChannel({ sourceId: "b" }), sources)).toBe("b");
  });
  it("returns empty when the source is missing", () => {
    expect(sourceBadge(mkChannel({ sourceId: "missing" }), [])).toBe("");
  });
});

describe("shouldShowSourceBadges (Issue #2 — ≥2 sources rule)", () => {
  it("returns false for an empty or single binding", () => {
    expect(shouldShowSourceBadges([])).toBe(false);
    expect(shouldShowSourceBadges([mkChannel({ sourceId: "a" })])).toBe(false);
  });

  it("returns false when all bindings share a single source", () => {
    const channels = [
      mkChannel({ id: "1", sourceId: "a", name: "/a/speed" }),
      mkChannel({ id: "2", sourceId: "a", name: "/a/rpm" }),
      mkChannel({ id: "3", sourceId: "a", name: "/a/torque" }),
    ];
    expect(shouldShowSourceBadges(channels)).toBe(false);
  });

  it("returns true with two distinct sources, even when short labels do not collide", () => {
    // This is the comma2k19 mcap+mf4 case the audit flagged: `speed`
    // from one file vs `WheelSpeedFL` from another — distinct short
    // labels so the v1 collision rule hid the badge, leaving the user
    // unable to tell which file each chip came from.
    const channels = [
      mkChannel({ id: "1", sourceId: "mcap", name: "/vehicle/speed" }),
      mkChannel({ id: "2", sourceId: "mf4", name: "WheelSpeedFL" }),
    ];
    expect(shouldShowSourceBadges(channels)).toBe(true);
  });

  it("returns true when short labels collide and sources differ", () => {
    const channels = [
      mkChannel({ id: "1", sourceId: "a", name: "/x/speed" }),
      mkChannel({ id: "2", sourceId: "b", name: "/y/speed" }),
    ];
    expect(shouldShowSourceBadges(channels)).toBe(true);
  });
});
