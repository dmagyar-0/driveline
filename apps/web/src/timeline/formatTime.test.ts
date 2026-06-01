import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatRelative,
  formatAbsolute,
  formatAxisTick,
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

describe("formatAxisTick", () => {
  // uPlot hands tick positions as epoch seconds; the start is the
  // session origin in epoch seconds. These mirror the Transport readout
  // so the plot axis and the scrubber never disagree.
  const startSec = Date.UTC(2021, 0, 2, 3, 4, 5, 0) / 1000;

  it("relative mode shows the offset from the session start", () => {
    expect(formatAxisTick(startSec, startSec, "relative")).toBe("00:00.000");
    expect(formatAxisTick(startSec + 12.345, startSec, "relative")).toBe(
      "00:12.345",
    );
    expect(formatAxisTick(startSec + 3661, startSec, "relative")).toBe(
      "01:01:01.000",
    );
  });

  it("relative mode clamps ticks before the start to zero", () => {
    expect(formatAxisTick(startSec - 5, startSec, "relative")).toBe(
      "00:00.000",
    );
  });

  it("absolute mode shows wall-clock time, ignoring the start", () => {
    const tickSec = Date.UTC(2021, 0, 2, 3, 4, 5, 6) / 1000;
    expect(formatAxisTick(tickSec, startSec, "absolute")).toBe(
      "2021-01-02 03:04:05.006",
    );
  });
});
