// Coverage for the `perf.ts` shim added in this audit range. The module
// is brand-new and consumed by `state/store.ts`, `timeline/playback.ts`,
// and the video / plot panels — every seam imports `mark` / `measure` /
// `timed`, so a regression here would reshape the e2e perf-budget
// payload silently.
//
// Vitest's default environment is `node`; Node 18+ ships
// `performance.mark` / `measure` / `getEntries` natively, so no jsdom
// or polyfill is required.

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
    // No marks set; `performance.measure` would normally throw
    // "Failed to execute 'measure' ... mark name not found". The shim
    // wraps the call in try/catch so a missing perf seam never breaks
    // user code. Calling raw would throw — the shim must not.
    expect(() => measure("missing-start", "no-such-mark")).not.toThrow();
    // And no spurious measure entry was recorded.
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
    // The `finally` block must have emitted the end mark + measure even
    // on rejection — otherwise a failing fetch path would leave a
    // dangling `:start` mark and the e2e perf assertion couldn't pair
    // it up.
    expect(performance.getEntriesByName("op-throw:start")).toHaveLength(1);
    expect(performance.getEntriesByName("op-throw:end")).toHaveLength(1);
    expect(performance.getEntriesByName("op-throw")).toHaveLength(1);
  });
});

describe("snapshot", () => {
  it("returns the current entries plus a memory placeholder", () => {
    mark("snap-test");
    const snap = snapshot();
    // Entries is a structural copy with the four documented fields.
    const our = snap.entries.find((e) => e.name === "snap-test");
    expect(our).toBeDefined();
    expect(our!.entryType).toBe("mark");
    expect(typeof our!.startTime).toBe("number");
    expect(typeof our!.duration).toBe("number");
    // `performance.memory` is Chromium-only; the shim coerces the missing
    // shape to `null` so consumers don't have to branch. Under Node we
    // expect `null`; under Chromium-flavoured runtimes it'd be a number.
    expect(snap.memory).toHaveProperty("usedJSHeapSize");
    expect(snap.memory).toHaveProperty("totalJSHeapSize");
    expect(
      snap.memory.usedJSHeapSize === null ||
        typeof snap.memory.usedJSHeapSize === "number",
    ).toBe(true);
    expect(
      snap.memory.totalJSHeapSize === null ||
        typeof snap.memory.totalJSHeapSize === "number",
    ).toBe(true);
  });
});

describe("installPerfHooks", () => {
  it("is a silent no-op when `window` is undefined", () => {
    // vitest `environment: "node"` already guarantees this; the explicit
    // assertion pins the early-return guard.
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
