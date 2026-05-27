// @vitest-environment jsdom
//
// T6.3 · PlotPanel integration test.
//
// Mounts the real PlotPanel under jsdom with a stubbed session store and
// a canned Arrow IPC buffer. Asserts:
//   - both bindings round-trip to `__drivelinePlotPanels[panelId]` and
//     `seriesStats` surfaces both channels with the expected min/max;
//   - moving `cursorNs` republishes the sync snapshot so the T6.1-style
//     cursor-overlay effect actually fires.
//
// Unit-level complement to `crossPanelSync.spec.ts`: this test exercises
// only the React + Zustand + Arrow wiring, no worker and no real wasm.
// The finer-grained helpers (`seriesFromArrow`, `cursorOverlay`,
// `mergeSeries`) each have their own dedicated tests — this one covers
// the panel's glue.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// uPlot calls `matchMedia()` at module load. jsdom doesn't ship one, so
// stub it before the PlotPanel import chain pulls uplot in. `vi.hoisted`
// lifts this ahead of the ESM import hoist.
vi.hoisted(() => {
  const g = globalThis as unknown as {
    matchMedia: (q: string) => MediaQueryList;
    ResizeObserver: unknown;
    Path2D: unknown;
  };
  g.matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  // uPlot constructs Path2D objects during its redraw pipeline — jsdom
  // doesn't ship one, so provide a no-op shim (uPlot never inspects the
  // built path under our stubbed 2D context).
  g.Path2D = class {
    addPath(): void {}
    closePath(): void {}
    moveTo(): void {}
    lineTo(): void {}
    bezierCurveTo(): void {}
    quadraticCurveTo(): void {}
    arc(): void {}
    arcTo(): void {}
    ellipse(): void {}
    rect(): void {}
    roundRect(): void {}
  };
});

import { act, cleanup, render } from "@testing-library/react";

// React 19 RTL requires this flag so `act(...)` wrappers don't log
// "environment not configured" noise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { PlotPanel, type PlotSyncSnapshot } from "./PlotPanel";
import { useSession } from "../state/store";
import type { DataCoreApi, Mf4Summary, McapSummary, Mp4SidecarSummary } from "../workerClient";

// The canonical T1.4 scalar IPC: ts = [1.0, 1.01, 1.02] s, value = [1, 2, 3].
const FIXTURE_PATH = resolve(
  __dirname,
  "../../../../test-fixtures/arrow_scalar.ipc",
);
const IPC_BYTES = new Uint8Array(readFileSync(FIXTURE_PATH));

// Build a minimal `DataCoreApi` remote stub that satisfies the store's
// `fetchChannelRange` call on the MCAP path. The scalar IPC fixture is
// 3 rows of (ts_ns, value_f64), so both "channels" in this test share
// identical bytes — simplifies asserting that both render.
function makeWorkerStub(): unknown {
  return {
    ping: vi.fn().mockResolvedValue("ok"),
    openMcap: vi.fn(),
    mcapSummary: vi.fn(),
    closeMcap: vi.fn(),
    openMf4: vi.fn(),
    mf4Summary: vi.fn(),
    closeMf4: vi.fn(),
    openMp4Sidecar: vi.fn(),
    mp4SidecarSummary: vi.fn(),
    closeMp4Sidecar: vi.fn(),
    mcapFetchRange: vi.fn().mockResolvedValue(IPC_BYTES),
    mf4FetchRange: vi.fn().mockResolvedValue(IPC_BYTES),
    fetchRangeStub: vi.fn(),
  } satisfies Partial<DataCoreApi> as unknown as DataCoreApi;
}

// Seed the zustand store with two MCAP sources so both channel bindings
// can resolve.
function seedSession(): void {
  const w = makeWorkerStub() as import("comlink").Remote<DataCoreApi>;
  useSession.getState().setWorker(w);
  useSession.setState({
    sources: [
      {
        id: "src-a",
        kind: "mcap",
        name: "a.mcap",
        handle: 1,
        timeRange: { startNs: 1_000_000_000n, endNs: 1_020_000_000n },
        channels: [
          {
            id: "chan-a",
            nativeId: "chan-a",
            sourceId: "src-a",
            name: "alpha",
            kind: "scalar",
            dtype: "f64",
            unit: null,
            sampleCount: 3,
            timeRange: { startNs: 1_000_000_000n, endNs: 1_020_000_000n },
          },
        ],
      },
      {
        id: "src-b",
        kind: "mcap",
        name: "b.mcap",
        handle: 2,
        timeRange: { startNs: 1_000_000_000n, endNs: 1_020_000_000n },
        channels: [
          {
            id: "chan-b",
            nativeId: "chan-b",
            sourceId: "src-b",
            name: "beta",
            kind: "scalar",
            dtype: "f64",
            unit: null,
            sampleCount: 3,
            timeRange: { startNs: 1_000_000_000n, endNs: 1_020_000_000n },
          },
        ],
      },
    ],
    channels: [],
    globalRange: { startNs: 1_000_000_000n, endNs: 1_020_000_000n },
    cursorNs: 1_000_000_000n,
    playing: false,
    speed: 1,
    layoutJson: null,
    videoBindings: {},
    plotBindings: { "test-panel": ["chan-a", "chan-b"] },
  });
  // Mirror what the openFiles action would do.
  useSession.setState({
    channels: useSession.getState().sources.flatMap((s) => s.channels),
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor: timeout after ${timeoutMs} ms`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("PlotPanel", () => {
  beforeEach(() => {
    // uPlot reads layout metrics from the mounted container; jsdom
    // returns zero for every bounding-box call unless we stub it. A
    // 400×200 rect is enough to exercise the decimation branch.
    const proto = Element.prototype as unknown as {
      getBoundingClientRect: () => DOMRect;
    };
    proto.getBoundingClientRect = (): DOMRect =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 400,
        bottom: 200,
        width: 400,
        height: 200,
        toJSON: () => ({}),
      }) as DOMRect;
    window.devicePixelRatio = 1;
    // Canvas contexts return `null` under jsdom — stub a no-op so
    // the PlotPanel cursor-overlay effect doesn't early-return too
    // loudly.
    // Provide a canvas 2D-context stub that's complete enough for uPlot's
    // redraw pipeline. jsdom doesn't ship a real rasteriser, so every
    // draw call resolves to a no-op; we just need them to exist.
    const noop = (): void => {};
    const fakeCtx = new Proxy(
      {
        canvas: document.createElement("canvas"),
        font: "",
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 0,
        lineCap: "butt",
        lineJoin: "miter",
        textAlign: "start",
        textBaseline: "alphabetic",
        direction: "inherit",
        globalAlpha: 1,
        globalCompositeOperation: "source-over",
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "low",
        measureText: () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }),
        getLineDash: () => [],
      },
      {
        get(target, prop) {
          if (prop in target) {
            return (target as unknown as Record<string, unknown>)[
              prop as string
            ];
          }
          return noop;
        },
        set(target, prop, value) {
          (target as unknown as Record<string, unknown>)[prop as string] = value;
          return true;
        },
      },
    );
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => fakeCtx,
    ) as unknown as HTMLCanvasElement["getContext"];
    seedSession();
  });

  afterEach(() => {
    cleanup();
    if (window.__drivelinePlotPanels) {
      delete window.__drivelinePlotPanels["test-panel"];
    }
  });

  it("publishes both bound series to __drivelinePlotPanels and computes min/max", async () => {
    render(<PlotPanel panelId="test-panel" />);

    await waitFor(() => {
      const snap = window.__drivelinePlotPanels?.["test-panel"];
      return Boolean(snap && snap.seriesStats.length === 2);
    });

    const snap = window.__drivelinePlotPanels!["test-panel"] as PlotSyncSnapshot;
    expect(snap.boundChannelIds).toEqual(["chan-a", "chan-b"]);

    const byId = Object.fromEntries(
      snap.seriesStats.map((s) => [s.channelId, s]),
    );
    // Fixture ys = [1, 2, 3]; both channels share the same IPC.
    expect(byId["chan-a"].min).toBe(1);
    expect(byId["chan-a"].max).toBe(3);
    expect(byId["chan-a"].count).toBe(3);
    expect(byId["chan-b"].min).toBe(1);
    expect(byId["chan-b"].max).toBe(3);
    expect(byId["chan-b"].count).toBe(3);

    // Both samples-at-cursor resolve to the first row (ts=1.0s) since
    // the seeded cursor is at 1.0 s.
    expect(snap.sampleAtCursor).toHaveLength(2);
    expect(snap.sampleAtCursor[0]?.channelId).toBe("chan-a");
    expect(snap.sampleAtCursor[0]?.value).toBe(1);
    expect(snap.sampleAtCursor[1]?.channelId).toBe("chan-b");
    expect(snap.sampleAtCursor[1]?.value).toBe(1);
  });

  it("republishes sampleAtCursor when cursorNs moves", async () => {
    render(<PlotPanel panelId="test-panel" />);
    await waitFor(
      () =>
        Boolean(
          window.__drivelinePlotPanels?.["test-panel"]?.seriesStats.length === 2,
        ),
    );

    // Advance the cursor to 1.01 s — the second fixture row.
    await act(async () => {
      useSession.getState().setCursor(1_010_000_000n);
    });

    await waitFor(() => {
      const s = window.__drivelinePlotPanels?.["test-panel"];
      return (
        !!s && s.sampleAtCursor[0]?.tsNs === 1_010_000_000n
      );
    });

    const snap = window.__drivelinePlotPanels!["test-panel"] as PlotSyncSnapshot;
    expect(snap.cursorNs).toBe(1_010_000_000n);
    expect(snap.sampleAtCursor[0]?.value).toBe(2);
    expect(snap.sampleAtCursor[1]?.value).toBe(2);
  });

  it("renders the in-chart title and timestamp footer (iter5 #4)", async () => {
    const { getByTestId } = render(<PlotPanel panelId="test-panel" />);
    await waitFor(() => {
      const snap = window.__drivelinePlotPanels?.["test-panel"];
      return Boolean(snap && snap.seriesStats.length === 2);
    });
    // Title sits in the upper-left, footer in the bottom-right.
    expect(getByTestId("plot-in-chart-title")).toBeTruthy();
    expect(getByTestId("plot-in-chart-footer")).toBeTruthy();
    // Δ marker reflects the 20 ms seeded range (1.000 s → 1.020 s).
    // formatDurationCompact rounds to whole seconds; 0.02 s → "0s".
    const delta = getByTestId("plot-in-chart-delta").textContent ?? "";
    expect(delta).toMatch(/^Δ\s/);
  });

  it("does not clear persisted bindings before any source loads", () => {
    // Pre-fix this would wipe the bindings on hydrate; with the
    // `sources.length > 0` gate persisted bindings survive until the
    // user actually drops a file (at which point the cull above
    // fires). Mirrors the gate test in EnumPanel/MapPanel/TablePanel.
    useSession.setState({
      sources: [],
      channels: [],
      globalRange: null,
      plotBindings: { "test-panel": ["persisted-a", "persisted-b"] },
    });
    render(<PlotPanel panelId="test-panel" />);
    expect(useSession.getState().plotBindings["test-panel"]).toEqual([
      "persisted-a",
      "persisted-b",
    ]);
  });
});

// Re-export types the test file pulls in for the shape-of-workerClient
// satisfies() — avoids a "declared but not used" under isolatedModules.
type _UsedTypes = McapSummary | Mf4Summary | Mp4SidecarSummary;
void ({} as _UsedTypes);
