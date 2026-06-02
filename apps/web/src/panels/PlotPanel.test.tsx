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

import { act, cleanup, fireEvent, render } from "@testing-library/react";

// React 19 RTL requires this flag so `act(...)` wrappers don't log
// "environment not configured" noise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { PlotPanel, type PlotSyncSnapshot } from "./PlotPanel";
import { useSession } from "../state/store";
import type { DataCoreApi, Mf4Summary, McapSummary, Mp4SidecarSummary } from "../workerClient";

import { tableFromArrays, tableToIPC } from "apache-arrow";

// The canonical T1.4 scalar IPC: ts = [1.0, 1.01, 1.02] s, value = [1, 2, 3].
const FIXTURE_PATH = resolve(
  __dirname,
  "../../../../test-fixtures/arrow_scalar.ipc",
);
const IPC_BYTES = new Uint8Array(readFileSync(FIXTURE_PATH));

// A scalar IPC whose values are all NaN — what `seriesFromArrow` produces
// for a channel that "has no values" (parsed_scalar_as_f64 returns NaN for
// non-scalar samples). Same three timestamps as the canonical fixture so
// the union x-axis lines up. `seriesFromArrow` only reads the raw backing
// buffers, so the column logical types don't matter here.
function nanScalarIpc(): Uint8Array {
  const table = tableFromArrays({
    ts: BigInt64Array.from([1_000_000_000n, 1_010_000_000n, 1_020_000_000n]),
    value: Float64Array.from([NaN, NaN, NaN]),
  });
  return tableToIPC(table);
}

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

  it("renders the value-at-cursor in each channel chip", async () => {
    const { findByTestId } = render(<PlotPanel panelId="test-panel" />);
    await waitFor(
      () =>
        Boolean(
          window.__drivelinePlotPanels?.["test-panel"]?.seriesStats.length === 2,
        ),
    );

    // Cursor seeded at 1.0 s → first fixture row, value 1.
    const chipA = await findByTestId("chip-value-chan-a");
    const chipB = await findByTestId("chip-value-chan-b");
    expect(chipA.textContent).toBe("1.000");
    expect(chipB.textContent).toBe("1.000");

    // Move the cursor to the second row (value 2) and the chips follow.
    await act(async () => {
      useSession.getState().setCursor(1_010_000_000n);
    });
    await waitFor(() => chipA.textContent === "2.000");
    expect(chipA.textContent).toBe("2.000");
    expect(chipB.textContent).toBe("2.000");
  });

  it("pins the x-axis to the global timeline, not the signal's data extent", async () => {
    // The fixture only covers ts 1.0–1.02 s, but the global timeline is
    // 1.0–11.0 s (e.g. a short signal offset inside a long video). Pre-fix
    // uPlot auto-fit the x-axis to the 20 ms data extent, so a 20 ms
    // signal stretched across the whole panel and the empty 10 s had no
    // blank region. The x-scale must instead span the full global range.
    useSession.setState({
      globalRange: { startNs: 1_000_000_000n, endNs: 11_000_000_000n },
    });
    render(<PlotPanel panelId="test-panel" />);

    await waitFor(() => {
      const snap = window.__drivelinePlotPanels?.["test-panel"];
      return Boolean(snap && snap.xScaleSec);
    });

    const snap = window.__drivelinePlotPanels!["test-panel"] as PlotSyncSnapshot;
    expect(snap.xScaleSec).not.toBeNull();
    // Domain spans the global range (1.0–11.0 s), not the data (1.0–1.02 s).
    expect(snap.xScaleSec!.min).toBeCloseTo(1.0, 6);
    expect(snap.xScaleSec!.max).toBeCloseTo(11.0, 6);
  });

  it("still renders a good series when another bound channel has only NaN values", async () => {
    // Regression for the blank-plot bug: a channel that "has no values"
    // decodes to all-NaN. uPlot's shared y-scale auto-range lets NaN
    // through its null test, so one NaN series poisoned the scale to
    // [NaN, NaN] and blanked *every* series — not just the empty one.
    // `mergeSeries` now maps non-finite values to gaps. The mergeSeries
    // unit tests assert the gap mapping directly; here we assert the panel
    // stays operable — the good channel's chip keeps reading finite values
    // and both series still publish — when a NaN channel is bound.
    //
    // (uPlot only resolves its y auto-range inside the redraw/rAF pipeline,
    // which jsdom's stubbed canvas doesn't drive, so `yScale` stays null
    // here; the real-browser check lives in e2e.)
    const nanBytes = nanScalarIpc();
    const w = {
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
      // chan-b lives in the source with handle 2 — feed it the NaN IPC;
      // chan-a (handle 1) keeps the canonical [1, 2, 3] fixture.
      mcapFetchRange: vi.fn((handle: number) =>
        Promise.resolve(handle === 2 ? nanBytes : IPC_BYTES),
      ),
      mf4FetchRange: vi.fn().mockResolvedValue(IPC_BYTES),
      fetchRangeStub: vi.fn(),
    } as unknown as import("comlink").Remote<DataCoreApi>;
    useSession.getState().setWorker(w);

    const { findByTestId } = render(<PlotPanel panelId="test-panel" />);

    await waitFor(() =>
      Boolean(
        window.__drivelinePlotPanels?.["test-panel"]?.seriesStats.length === 2,
      ),
    );

    const snap = window.__drivelinePlotPanels!["test-panel"] as PlotSyncSnapshot;
    // Both series publish; the good channel's stats stay finite, the NaN
    // channel's min/max collapse to NaN (it genuinely has no values).
    const byId = Object.fromEntries(
      snap.seriesStats.map((s) => [s.channelId, s]),
    );
    expect(byId["chan-a"].min).toBe(1);
    expect(byId["chan-a"].max).toBe(3);
    expect(Number.isNaN(byId["chan-b"].min)).toBe(true);

    // The good channel's value-at-cursor readout is unaffected by the
    // NaN neighbour (cursor seeded at 1.0 s → first row, value 1).
    const chipA = await findByTestId("chip-value-chan-a");
    expect(chipA.textContent).toBe("1.000");
  });

  it("offers the Stack toggle only with ≥2 axes and flips the panel setting", async () => {
    const { queryByTestId, findByTestId } = render(
      <PlotPanel panelId="test-panel" />,
    );
    await waitFor(() =>
      Boolean(
        window.__drivelinePlotPanels?.["test-panel"]?.seriesStats.length === 2,
      ),
    );

    // Both channels default to axis 0 → a single axis in use → no toggle.
    expect(queryByTestId("plot-stack-axes")).toBeNull();

    // Move chan-b onto a second axis → the toggle appears, off by default.
    await act(async () => {
      useSession.getState().setPlotChannelAxis("test-panel", "chan-b", 1);
    });
    const btn = await findByTestId("plot-stack-axes");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(
      useSession.getState().plotPanelSettings["test-panel"]?.stackAxes ?? false,
    ).toBe(false);

    // Clicking the button stacks the axes (drives the store action).
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(
      useSession.getState().plotPanelSettings["test-panel"]?.stackAxes,
    ).toBe(true);
    expect(
      (await findByTestId("plot-stack-axes")).getAttribute("aria-pressed"),
    ).toBe("true");

    // Toggling off clears the flag (stored as a deletion → minimal payload).
    await act(async () => {
      fireEvent.click(await findByTestId("plot-stack-axes"));
    });
    expect(
      useSession.getState().plotPanelSettings["test-panel"]?.stackAxes ?? false,
    ).toBe(false);
  });

  it("remaps axis 0 into the top band when stacking is enabled", async () => {
    render(<PlotPanel panelId="test-panel" />);
    await waitFor(() =>
      Boolean(
        window.__drivelinePlotPanels?.["test-panel"]?.seriesStats.length === 2,
      ),
    );

    // chan-a stays on axis 0 (scale "y", read by the sync snapshot); chan-b
    // moves to axis 1 so two axes carry data, then stacking is enabled.
    await act(async () => {
      useSession.getState().setPlotChannelAxis("test-panel", "chan-b", 1);
      useSession.getState().setPlotStackAxes("test-panel", true);
    });

    // The banded `range` callback resolves scale "y" synchronously inside
    // setData (like the x-scale), so yScale is readable without a redraw.
    await waitFor(() =>
      Boolean(window.__drivelinePlotPanels?.["test-panel"]?.yScale),
    );
    const snap = window.__drivelinePlotPanels![
      "test-panel"
    ] as PlotSyncSnapshot;
    const yScale = snap.yScale!;
    expect(Number.isFinite(yScale.min)).toBe(true);
    expect(Number.isFinite(yScale.max)).toBe(true);

    // axis 0 data is [1, 3]; stacked into the TOP half it occupies the upper
    // band — the scale extends well below the data and the data max sits near
    // the top of the plot (uPlot maps min→bottom, max→top).
    const frac = (v: number) => (v - yScale.min) / (yScale.max - yScale.min);
    expect(yScale.min).toBeLessThan(1);
    expect(frac(3)).toBeGreaterThan(0.85);
    expect(frac(1)).toBeGreaterThan(0.5);
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
