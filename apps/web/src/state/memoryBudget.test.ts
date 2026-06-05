// Coverage for the heap-budget helpers used by `Mp4SampleCache`. Both
// functions are pure but read `performance.memory` (Chromium-only). The
// tests stub the field via `vi.spyOn(performance, "memory", "get")` so we
// can drive every branch — present/absent and pressure on/off — without
// depending on the host engine.

import { afterEach, describe, expect, it } from "vitest";
import {
  getInitialBudgetBytes,
  memoryPressure,
  Mp4BudgetCoordinator,
} from "./memoryBudget";

interface FakeMemory {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
}

function stubMemory(value: FakeMemory | undefined): void {
  Object.defineProperty(performance, "memory", {
    configurable: true,
    get() {
      return value;
    },
  });
}

afterEach(() => {
  // Drop the property so the next test re-stubs cleanly. JSDOM and node
  // both leave `performance.memory` undefined by default.
  delete (performance as unknown as { memory?: unknown }).memory;
});

describe("getInitialBudgetBytes", () => {
  it("returns the 512 MB fallback when performance.memory is missing", () => {
    // node + Firefox + Safari path. Without `performance.memory` we must
    // still hand the cache a meaningful bound so it doesn't grow forever.
    stubMemory(undefined);
    expect(getInitialBudgetBytes()).toBe(512 * 1024 * 1024);
  });

  it("returns half of jsHeapSizeLimit when memory info is available", () => {
    // 2 GiB ceiling → 1 GiB budget. The 0.5 ratio leaves headroom for the
    // React tree, video frames, and Arrow batches outside the cache.
    stubMemory({
      jsHeapSizeLimit: 2 * 1024 * 1024 * 1024,
      totalJSHeapSize: 0,
      usedJSHeapSize: 0,
    });
    expect(getInitialBudgetBytes()).toBe(1 * 1024 * 1024 * 1024);
  });

  it("clamps to a 64 MB floor when half the heap limit is below it", () => {
    // Tiny ceilings (test rigs, embedded browsers) shouldn't collapse the
    // budget to a few MB — the cache needs at least one GOP's worth of
    // samples resident or it churns on every refill.
    stubMemory({
      jsHeapSizeLimit: 32 * 1024 * 1024, // 0.5 × = 16 MB, below the floor
      totalJSHeapSize: 0,
      usedJSHeapSize: 0,
    });
    expect(getInitialBudgetBytes()).toBe(64 * 1024 * 1024);
  });

  it("treats a non-numeric jsHeapSizeLimit as 'no info' and returns the fallback", () => {
    // Spec field is a `number`; some test browsers expose an object stub.
    // The guard in `memoryInfo()` rejects that shape so the cache still
    // gets the 512 MB default rather than NaN budgeting.
    stubMemory({
      jsHeapSizeLimit: "lots" as unknown as number,
      totalJSHeapSize: 0,
      usedJSHeapSize: 0,
    });
    expect(getInitialBudgetBytes()).toBe(512 * 1024 * 1024);
  });
});

describe("memoryPressure", () => {
  it("returns 'low' when performance.memory is missing", () => {
    stubMemory(undefined);
    expect(memoryPressure()).toBe("low");
  });

  it("returns 'low' when used / limit is at or below 0.8", () => {
    // Boundary: 80% exactly is still 'low' — the predicate is strict `>`.
    // A regression that flips it to `>=` would evict aggressively whenever
    // the tab is steady-state at 80%, which is normal for long sessions.
    stubMemory({
      jsHeapSizeLimit: 1_000_000,
      totalJSHeapSize: 800_000,
      usedJSHeapSize: 800_000,
    });
    expect(memoryPressure()).toBe("low");
  });

  it("returns 'high' once used / limit exceeds 0.8", () => {
    stubMemory({
      jsHeapSizeLimit: 1_000_000,
      totalJSHeapSize: 850_000,
      usedJSHeapSize: 800_001,
    });
    expect(memoryPressure()).toBe("high");
  });

  it("returns 'low' when jsHeapSizeLimit is 0 (avoid divide-by-zero)", () => {
    // Defensive: a buggy host that reports a 0 ceiling shouldn't be
    // interpreted as infinite pressure (which would evict everything on
    // every fetch).
    stubMemory({
      jsHeapSizeLimit: 0,
      totalJSHeapSize: 0,
      usedJSHeapSize: 0,
    });
    expect(memoryPressure()).toBe("low");
  });
});

describe("Mp4BudgetCoordinator", () => {
  it("sums reported bytes across registered caches", () => {
    const coord = new Mp4BudgetCoordinator(1000);
    const a = {};
    const b = {};
    coord.register(a);
    coord.register(b);
    coord.report(a, 100);
    coord.report(b, 250);
    expect(coord.total()).toBe(350);
  });

  it("tracks the latest report per cache (not cumulative)", () => {
    const coord = new Mp4BudgetCoordinator(1000);
    const a = {};
    coord.register(a);
    coord.report(a, 100);
    coord.report(a, 40); // shrank — total reflects the new value, not 140
    expect(coord.total()).toBe(40);
  });

  it("flags overBudget once the aggregate crosses the ceiling", () => {
    const coord = new Mp4BudgetCoordinator(300);
    const a = {};
    const b = {};
    coord.register(a);
    coord.register(b);
    coord.report(a, 200);
    expect(coord.overBudget()).toBe(false);
    coord.report(b, 150); // 350 > 300
    expect(coord.overBudget()).toBe(true);
  });

  it("reclaims a cache's bytes from the aggregate on unregister", () => {
    const coord = new Mp4BudgetCoordinator(1000);
    const a = {};
    const b = {};
    coord.register(a);
    coord.register(b);
    coord.report(a, 100);
    coord.report(b, 250);
    coord.unregister(a);
    expect(coord.total()).toBe(250);
    // Unregistering an unknown cache is a no-op.
    coord.unregister({});
    expect(coord.total()).toBe(250);
  });

  it("derives a non-pressure ceiling so it works on browsers without performance.memory", () => {
    // No performance.memory → memoryPressure() is inert ("low"). The
    // ceiling must still bound the aggregate purely on the byte count,
    // never relying on the pressure signal alone.
    stubMemory(undefined);
    const coord = new Mp4BudgetCoordinator();
    expect(coord.ceilingBytes()).toBe(512 * 1024 * 1024);
    coord.register({});
    expect(coord.overBudget()).toBe(false);
  });

  it("honours setCeilingBytes for tests", () => {
    const coord = new Mp4BudgetCoordinator(1000);
    coord.setCeilingBytes(50);
    const a = {};
    coord.register(a);
    coord.report(a, 60);
    expect(coord.overBudget()).toBe(true);
  });
});
