// @vitest-environment node

// Coverage for the `perf.ts` shim. The `installPerfHooks` test below
// asserts `typeof window === "undefined"`, so the env directive above
// pins the file to `node` even if the workspace default ever flips.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installPerfHooks,
  mark,
  measure,
  snapshot,
  timed,
} from "./perf";

beforeEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
});

afterEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
});

describe("mark", () => {
  it("records a `mark` entry under the supplied name", () => {
    mark("driveline:test:a");
    const entries = performance.getEntriesByName("driveline:test:a");
    expect(entries.some((e) => e.entryType === "mark")).toBe(true);
  });
});

describe("measure", () => {
  it("records a `measure` entry between two existing marks", () => {
    mark("perf-test:start");
    mark("perf-test:end");
    measure("perf-test", "perf-test:start", "perf-test:end");
    const measures = performance.getEntriesByName("perf-test");
    expect(measures.length).toBeGreaterThanOrEqual(1);
    expect(measures[0].entryType).toBe("measure");
  });

  it("swallows the DOMException when the start mark is missing", () => {
    expect(() => measure("missing-start", "no-such-mark")).not.toThrow();
    expect(performance.getEntriesByName("missing-start")).toHaveLength(0);
  });
});

describe("timed", () => {
  it("emits `<prefix>:start` / `<prefix>:end` marks and a `<prefix>` measure", async () => {
    const result = await timed("op-ok", async () => 42);
    expect(result).toBe(42);
    expect(performance.getEntriesByName("op-ok:start")).toHaveLength(1);
    expect(performance.getEntriesByName("op-ok:end")).toHaveLength(1);
    expect(performance.getEntriesByName("op-ok")).toHaveLength(1);
  });

  it("re-throws the wrapped op's rejection but still emits the end mark + measure", async () => {
    await expect(
      timed("op-throw", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // `finally` must run on rejection so the e2e perf assertion can
    // pair `:start` with `:end`.
    expect(performance.getEntriesByName("op-throw:start")).toHaveLength(1);
    expect(performance.getEntriesByName("op-throw:end")).toHaveLength(1);
    expect(performance.getEntriesByName("op-throw")).toHaveLength(1);
  });
});

describe("snapshot", () => {
  it("returns the current entries plus a memory placeholder", () => {
    mark("snap-test");
    const snap = snapshot();
    const our = snap.entries.find((e) => e.name === "snap-test");
    expect(our).toBeDefined();
    expect(our!.entryType).toBe("mark");
    expect(typeof our!.startTime).toBe("number");
    expect(typeof our!.duration).toBe("number");
    // `performance.memory` is Chromium-only; the shim coerces the missing
    // shape to `null` so consumers don't have to branch.
    const isNumOrNull = (v: unknown) => v === null || typeof v === "number";
    expect(isNumOrNull(snap.memory.usedJSHeapSize)).toBe(true);
    expect(isNumOrNull(snap.memory.totalJSHeapSize)).toBe(true);
  });
});

describe("installPerfHooks", () => {
  it("is a silent no-op when `window` is undefined", () => {
    expect(typeof window).toBe("undefined");
    expect(() => installPerfHooks()).not.toThrow();
  });
});
