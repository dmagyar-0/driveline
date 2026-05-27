// Unit tests for the shared Plot panel formatter helpers (iter3 issues
// #3, #4, #6). These run under the default vitest environment — they
// touch the Date object only via its UTC-aware constructor and the
// host-local hour/minute/second accessors, so the host TZ matters.
// The tests below avoid asserting on wall-clock-dependent fields and
// pick values that are stable in any TZ.

import { describe, expect, it } from "vitest";
import {
  decimalsForUnit,
  DEFAULT_DECIMALS,
  formatAxisTime24h,
  formatDurationCompact,
  formatFixedForUnit,
  formatRelativeTime24h,
  formatTime24h,
  makeAxisValueFormatter,
  pickTimeIncrements,
  timeAxisTicks,
} from "./plotFormat";

describe("formatTime24h", () => {
  it("pads hour/minute/second to two digits", () => {
    // Build a UTC midnight stamp, then derive the host-local string the
    // helper will produce so the assertion holds in any TZ.
    const ns = 0n; // 1970-01-01T00:00:00Z
    const d = new Date(0);
    const expected = `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    expect(formatTime24h(ns)).toBe(expected);
  });

  it("never includes am/pm — iter2 mixed 12h and 24h, iter3 must not", () => {
    const ns = 1_700_000_000_000_000_000n; // some 2023 stamp
    const s = formatTime24h(ns);
    expect(s).not.toMatch(/am|pm/i);
    expect(s).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("formatRelativeTime24h", () => {
  it("formats positive offsets as HH:MM:SS", () => {
    const origin = 0n;
    expect(formatRelativeTime24h(3_600_000_000_000n, origin)).toBe("01:00:00");
    expect(formatRelativeTime24h(125_000_000_000n, origin)).toBe("00:02:05");
  });

  it("prefixes negative offsets with `-`", () => {
    expect(formatRelativeTime24h(0n, 65_000_000_000n)).toBe("-00:01:05");
  });
});

describe("formatAxisTime24h", () => {
  it("returns HH:MM:SS in 24h notation", () => {
    const secs = 1_700_000_000; // 2023-11-14T22:13:20Z
    const s = formatAxisTime24h(secs);
    expect(s).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(s).not.toMatch(/am|pm/i);
  });
});

describe("decimalsForUnit", () => {
  it("picks 1 decimal for degrees", () => {
    expect(decimalsForUnit("deg")).toBe(1);
    expect(decimalsForUnit("°")).toBe(1);
  });
  it("picks 2 decimals for velocity units", () => {
    expect(decimalsForUnit("m/s")).toBe(2);
    expect(decimalsForUnit("km/h")).toBe(2);
    expect(decimalsForUnit("mph")).toBe(2);
  });
  it("picks 3 decimals for rate / acceleration units", () => {
    expect(decimalsForUnit("rad/s")).toBe(3);
    expect(decimalsForUnit("m/s^2")).toBe(3);
  });
  it("picks 0 decimals for whole-number domains", () => {
    expect(decimalsForUnit("rpm")).toBe(0);
    expect(decimalsForUnit("hpa")).toBe(0);
  });
  it("uses the default for unknown / null units", () => {
    expect(decimalsForUnit(null)).toBe(DEFAULT_DECIMALS);
    expect(decimalsForUnit(undefined)).toBe(DEFAULT_DECIMALS);
    expect(decimalsForUnit("")).toBe(DEFAULT_DECIMALS);
    expect(decimalsForUnit("custom")).toBe(DEFAULT_DECIMALS);
  });
});

describe("formatFixedForUnit", () => {
  it("right-pads zeros so columns align", () => {
    expect(formatFixedForUnit(30.6, "m/s")).toBe("30.60");
    expect(formatFixedForUnit(7.3, "m/s")).toBe("7.30");
    expect(formatFixedForUnit(30, "m/s")).toBe("30.00");
  });
  it("returns em-dash for non-finite values", () => {
    expect(formatFixedForUnit(NaN, "m/s")).toBe("—");
    expect(formatFixedForUnit(Infinity, "m/s")).toBe("—");
  });
});

describe("formatDurationCompact (iter5 issue #4 — in-chart Δ marker)", () => {
  it("uses seconds for sub-minute durations", () => {
    expect(formatDurationCompact(30_000_000_000n)).toBe("30s");
    expect(formatDurationCompact(1_000_000_000n)).toBe("1s");
  });
  it("uses minutes (+seconds) for sub-hour durations", () => {
    expect(formatDurationCompact(60_000_000_000n)).toBe("1m");
    expect(formatDurationCompact(125_000_000_000n)).toBe("2m 5s");
  });
  it("uses hours (+minutes) for ≥1 hour", () => {
    expect(formatDurationCompact(3_600_000_000_000n)).toBe("1h");
    expect(formatDurationCompact(3_900_000_000_000n)).toBe("1h 5m");
  });
  it("emits em-dash for negative durations", () => {
    expect(formatDurationCompact(-1n)).toBe("—");
  });
});

describe("pickTimeIncrements (iter5 issue #3 — tick density)", () => {
  it("picks 10s majors / 2s minors for a 30s window", () => {
    expect(pickTimeIncrements(30, 5)).toEqual({ majorInc: 10, minorInc: 2 });
  });
  it("picks 60s majors / 10s minors for a 5-minute window", () => {
    expect(pickTimeIncrements(300, 5)).toEqual({ majorInc: 60, minorInc: 10 });
  });
  it("picks 1s majors / 0.2s minors for a 3-second window", () => {
    expect(pickTimeIncrements(3, 5)).toEqual({ majorInc: 1, minorInc: 0.2 });
  });
});

describe("timeAxisTicks (iter5 issue #3 — major + minor ladder)", () => {
  it("returns at least 5 minor ticks across a 30s window", () => {
    const { all, majors } = timeAxisTicks(0, 30);
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(majors.size).toBeGreaterThan(0);
    expect(majors.size).toBeLessThanOrEqual(all.length);
  });

  it("majors are a subset of all", () => {
    const { all, majors } = timeAxisTicks(100, 130);
    for (const m of majors) {
      expect(all).toContain(m);
    }
  });

  it("major ticks fall on the major-increment boundary", () => {
    const { majors } = timeAxisTicks(0, 30);
    for (const m of majors) {
      // 30s window → 10s majors → every major divisible by 10.
      expect(Math.abs(m % 10)).toBeLessThan(1e-6);
    }
  });

  it("emits minors between majors so the tick density is at least 3x", () => {
    // 30s window with 4-major target → 10s majors + 2s minors. With
    // majors at 0/10/20/30 we expect minors at 2,4,6,8,12,14,…,28.
    const { all, majors } = timeAxisTicks(0, 30);
    // Minor count must dominate so the user has texture between labels.
    expect(all.length - majors.size).toBeGreaterThanOrEqual(majors.size * 2);
  });

  it("returns empty when min ≥ max or non-finite", () => {
    expect(timeAxisTicks(10, 5)).toEqual({ all: [], majors: new Set() });
    expect(timeAxisTicks(NaN, 1)).toEqual({ all: [], majors: new Set() });
  });
});

describe("makeAxisValueFormatter (iter3 issue #4)", () => {
  it("prints uniform decimals across sub-integer splits", () => {
    const f = makeAxisValueFormatter();
    // The bug: uPlot returns ["33", "33.4", …] for an interval of 0.2.
    // Our formatter must give a consistent ladder.
    const out = f(null, [33, 33.2, 33.4, 33.6, 33.8]);
    expect(out).toEqual(["33.0", "33.2", "33.4", "33.6", "33.8"]);
  });
  it("respects an explicit decimals hint", () => {
    const f = makeAxisValueFormatter(2);
    expect(f(null, [1, 2, 3])).toEqual(["1.00", "2.00", "3.00"]);
  });
  it("uses whole numbers when splits are integers", () => {
    const f = makeAxisValueFormatter();
    expect(f(null, [10, 20, 30])).toEqual(["10", "20", "30"]);
  });
});
