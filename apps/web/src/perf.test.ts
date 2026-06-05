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
  VIDEO_FIRST_FRAME,
  VIDEO_SEEK_END,
  VIDEO_SEEK_START,
  VIDEO_SEEK_TO_BLIT,
} from "./perf";

beforeEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
});

afterEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
});

describe("named video seams", () => {
  // The worker, panel, and e2e/perfBudgets all reference these canonical
  // strings; pin them so a rename here can't silently desync the seek-to-blit
  // budget assertion from the mark the panel actually emits.
  it("expose the canonical mark/measure names", () => {
    expect(VIDEO_FIRST_FRAME).toBe("video:first-frame");
    expect(VIDEO_SEEK_START).toBe("video:seek:start");
    expect(VIDEO_SEEK_END).toBe("video:seek:end");
    expect(VIDEO_SEEK_TO_BLIT).toBe("video:seek-to-blit");
  });

  it("VIDEO_SEEK_TO_BLIT measure spans the seek start/end marks", () => {
    // Mirrors the panel: mark start on seek dispatch, end on first post-seek
    // blit, then measure between them. The measure must land on the
    // performance timeline so `__drivelinePerf` / e2e can read it.
    mark(VIDEO_SEEK_START);
    mark(VIDEO_SEEK_END);
    measure(VIDEO_SEEK_TO_BLIT, VIDEO_SEEK_START, VIDEO_SEEK_END);
    const measures = performance.getEntriesByName(VIDEO_SEEK_TO_BLIT);
    expect(measures.length).toBeGreaterThanOrEqual(1);
    expect(measures[0].entryType).toBe("measure");
  });
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

  it("attaches `__drivelinePerf` with snapshot/clear/now when `window` exists", () => {
    // The early-return guard is keyed on `typeof window`; stubbing a
    // bare object on `globalThis` is enough to drive the install path
    // without pulling in jsdom. The shim only assigns one property —
    // no DOM features are touched — so this stays environment-agnostic.
    const fakeWindow: Record<string, unknown> = {};
    (globalThis as unknown as { window: unknown }).window = fakeWindow;
    try {
      installPerfHooks();
      const hook = fakeWindow.__drivelinePerf as
        | { snapshot: () => unknown; clear: () => void; now: () => number }
        | undefined;
      expect(hook).toBeDefined();
      expect(typeof hook!.snapshot).toBe("function");
      expect(typeof hook!.clear).toBe("function");
      expect(typeof hook!.now).toBe("function");

      // `now` must return a finite number from `performance.now()`.
      const t = hook!.now();
      expect(Number.isFinite(t)).toBe(true);

      // `clear` must remove existing marks/measures so Playwright can
      // reset between scenarios.
      mark("install-clear-test");
      expect(performance.getEntriesByName("install-clear-test")).toHaveLength(1);
      hook!.clear();
      expect(performance.getEntriesByName("install-clear-test")).toHaveLength(0);
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });
});
