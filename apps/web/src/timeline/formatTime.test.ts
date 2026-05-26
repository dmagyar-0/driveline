import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatDurationCoarse,
  formatRelative,
  formatAbsolute,
  formatAbsoluteClock,
  formatDate,
  uPlotAxisValues,
} from "./formatTime";

describe("formatDuration", () => {
  it("renders zero as MM:SS.mmm", () => {
    expect(formatDuration(0n)).toBe("00:00.000");
  });

  it("floors sub-millisecond nanoseconds", () => {
    expect(formatDuration(999_999n)).toBe("00:00.000");
    expect(formatDuration(1_000_000n)).toBe("00:00.001");
    expect(formatDuration(1_999_999n)).toBe("00:00.001");
  });

  it("renders exactly one second", () => {
    expect(formatDuration(1_000_000_000n)).toBe("00:01.000");
  });

  it("renders sub-second fractions", () => {
    expect(formatDuration(123_000_000n)).toBe("00:00.123");
    expect(formatDuration(12_345_000_000n)).toBe("00:12.345");
  });

  it("renders the end of a 10 s fixture session", () => {
    // 10 s exactly.
    expect(formatDuration(10_000_000_000n)).toBe("00:10.000");
  });

  it("renders 59.999 s without promoting to the minute", () => {
    expect(formatDuration(59_999_000_000n)).toBe("00:59.999");
  });

  it("adds the HH: prefix at the hours boundary", () => {
    // 1 h exactly.
    const oneHour = 3_600_000_000_000n;
    expect(formatDuration(oneHour)).toBe("01:00:00.000");
    // Just under 1 h stays MM:SS.mmm.
    expect(formatDuration(oneHour - 1_000_000n)).toBe("59:59.999");
  });

  it("renders a multi-hour duration", () => {
    // 2 h 3 m 4 s 5 ms.
    const ns =
      2n * 3_600_000_000_000n +
      3n * 60_000_000_000n +
      4n * 1_000_000_000n +
      5n * 1_000_000n;
    expect(formatDuration(ns)).toBe("02:03:04.005");
  });

  it("preserves ns precision past Number.MAX_SAFE_INTEGER", () => {
    // Base ns used by the mp4 fixture + a fractional offset that depends
    // on bigint math — coercing to Number would drop the trailing digits.
    const base = 1_700_000_000_000_000_000n;
    const offset = 9n * 33_333_333n + 1n;
    // The "duration" from startNs to endNs of that fixture is `offset`.
    expect(formatDuration(offset)).toBe("00:00.299");
    // Sanity: `base` itself is bigger than the ms-safe range for a Date,
    // but we're only formatting the delta here.
    expect(formatRelative(base + offset, base)).toBe("00:00.299");
  });

  it("treats negative durations as zero", () => {
    expect(formatDuration(-1n)).toBe("00:00.000");
  });
});

describe("formatRelative", () => {
  it("clamps when the cursor is before the start", () => {
    expect(formatRelative(0n, 100n)).toBe("00:00.000");
  });

  it("matches formatDuration for cursor >= start", () => {
    expect(formatRelative(2_500_000_000n, 500_000_000n)).toBe("00:02.000");
  });
});

describe("formatAbsolute", () => {
  it("renders a known UTC timestamp", () => {
    // 2021-01-02T03:04:05.006Z.
    const ms = Date.UTC(2021, 0, 2, 3, 4, 5, 6);
    expect(formatAbsolute(BigInt(ms) * 1_000_000n)).toBe(
      "2021-01-02 03:04:05.006",
    );
  });

  it("renders the unix epoch", () => {
    expect(formatAbsolute(0n)).toBe("1970-01-01 00:00:00.000");
  });
});

describe("formatDurationCoarse", () => {
  it("drops fractional seconds", () => {
    expect(formatDurationCoarse(0n)).toBe("00:00");
    expect(formatDurationCoarse(999_000_000n)).toBe("00:00");
    expect(formatDurationCoarse(1_000_000_000n)).toBe("00:01");
    expect(formatDurationCoarse(75_000_000_000n)).toBe("01:15");
  });

  it("adds hours prefix past the hour boundary", () => {
    expect(formatDurationCoarse(3_600_000_000_000n)).toBe("01:00:00");
    expect(formatDurationCoarse(3_599_000_000_000n)).toBe("59:59");
  });
});

describe("formatAbsoluteClock", () => {
  it("renders HH:MM:SS only", () => {
    const ms = Date.UTC(2021, 0, 2, 6, 8, 42, 123);
    expect(formatAbsoluteClock(BigInt(ms) * 1_000_000n)).toBe("06:08:42");
  });
});

describe("formatDate", () => {
  it("renders YYYY-MM-DD only", () => {
    const ms = Date.UTC(2018, 6, 27, 6, 4, 0, 0);
    expect(formatDate(BigInt(ms) * 1_000_000n)).toBe("2018-07-27");
  });
});

describe("uPlotAxisValues", () => {
  it("relative mode formats X-axis ticks as elapsed", () => {
    // session starts at 2 s, tick at 12.5 s → 10.5 s elapsed.
    const fn = uPlotAxisValues("relative", 2);
    expect(fn([2, 12, 62])).toEqual(["00:00", "00:10", "01:00"]);
  });

  it("absolute mode formats X-axis ticks as wall clock", () => {
    const start = Date.UTC(2018, 6, 27, 6, 8, 0, 0) / 1000;
    const fn = uPlotAxisValues("absolute", start);
    expect(fn([start, start + 60, start + 120])).toEqual([
      "06:08:00",
      "06:09:00",
      "06:10:00",
    ]);
  });
});
