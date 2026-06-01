// @vitest-environment jsdom
//
// ChannelsDrawer · tree rendering, grouping, search, and windowing.
//
// The drawer flattens its collapse-aware tree into a windowed list: only the
// slice intersecting the scroll viewport is mounted. jsdom reports 0 for
// every layout measurement (`clientHeight`, `scrollTop`), so we stub the
// scroll container's geometry to a fixed viewport before asserting. The
// tree-building logic itself is unit-tested in `channelTree.test.ts`; this
// file pins the drawer's rendering, interaction, and windowing contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ChannelsDrawer } from "./ChannelsDrawer";
import {
  useSession,
  qualifiedChannelId,
  type Channel,
  type SourceMeta,
} from "../../state/store";

const VIEWPORT_H = 300;

// Mutable stand-in for the scroll container's scrollTop (jsdom always
// reports 0). The test drives it before firing a `scroll` event.
let scrollTopValue = 0;

function makeChannel(sourceId: string, i: number): Channel {
  const nativeId = `0/${i}`;
  return {
    id: qualifiedChannelId(sourceId, nativeId),
    nativeId,
    sourceId,
    name: `signal_${i}`,
    kind: "scalar",
    dtype: "f64",
    unit: null,
    sampleCount: 10,
    timeRange: { startNs: 0n, endNs: 10n },
  };
}

function makeSource(id: string, count: number): SourceMeta {
  const channels = Array.from({ length: count }, (_, i) => makeChannel(id, i));
  return {
    id,
    kind: "mcap",
    name: id,
    handle: 1,
    timeRange: { startNs: 0n, endNs: 10n },
    channels,
  };
}

function loadSession(sources: SourceMeta[]) {
  useSession.setState({
    sources,
    channels: sources.flatMap((s) => s.channels),
    globalRange: { startNs: 0n, endNs: 10n },
  });
}

// --- Helpers for the tree-shape tests (named topics + MF4 groups). ---
const range = { startNs: 0n, endNs: 1_000n };

function mcapChannel(name: string): Channel {
  return {
    id: `mcap::${name}`,
    nativeId: name,
    sourceId: "demo.mcap",
    name,
    kind: "scalar",
    dtype: "f64",
    unit: null,
    sampleCount: 3,
    timeRange: range,
  };
}

function mf4Channel(name: string, group: string): Channel {
  return {
    id: `mf4::${group}/${name}`,
    nativeId: name,
    sourceId: "demo.mf4",
    name,
    group,
    kind: "scalar",
    dtype: "f64",
    unit: null,
    sampleCount: 3,
    timeRange: range,
  };
}

function seedTree(channels: Channel[]) {
  const bySource = new Map<string, Channel[]>();
  for (const c of channels) {
    const list = bySource.get(c.sourceId) ?? [];
    list.push(c);
    bySource.set(c.sourceId, list);
  }
  const sources: SourceMeta[] = [...bySource.entries()].map(([id, chans]) => ({
    id,
    kind: id.endsWith(".mf4") ? "mf4" : "mcap",
    name: id,
    handle: 1,
    timeRange: range,
    channels: chans,
  }));
  useSession.setState({ sources, channels, globalRange: range });
}

// ResizeObserver is not implemented in jsdom.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // requestAnimationFrame so the scroll handler's rAF coalescing resolves.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  scrollTopValue = 0;
  // Pin the scroll container height; jsdom otherwise reports 0.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.dataset?.testid === "channels-groups" ? VIEWPORT_H : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return this.dataset?.testid === "channels-groups" ? scrollTopValue : 0;
    },
    set() {
      /* the component resets scrollTop to 0 on filter; ignore writes */
    },
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  // @ts-expect-error — drop the stubbed accessors between tests.
  delete HTMLElement.prototype.clientHeight;
  // @ts-expect-error — drop the stubbed accessors between tests.
  delete HTMLElement.prototype.scrollTop;
  await useSession.getState().clear();
});

describe("ChannelsDrawer windowing", () => {
  const noop = () => null;

  it("shows the empty state when no channels are loaded", () => {
    render(<ChannelsDrawer ensurePlotPanel={noop} />);
    expect(screen.getByText("No channels loaded")).toBeTruthy();
  });

  it("windows a large channel set instead of mounting every row", () => {
    loadSession([makeSource("big.mcap", 5000)]);
    render(<ChannelsDrawer ensurePlotPanel={noop} />);

    // Pill reflects the full count even though most rows are unmounted.
    expect(screen.getByTestId("channels-count-pill").textContent).toBe("5000");

    const rows = screen.getAllByTestId(/^channel-row-/);
    // A 300px viewport at 30px/row is ~10 rows; with overscan well under 100,
    // and crucially nowhere near 5000.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
  });

  it("filters by name and updates the count pill", async () => {
    loadSession([makeSource("big.mcap", 200)]);
    render(<ChannelsDrawer ensurePlotPanel={noop} />);

    const search = screen.getByTestId("channels-search");
    await act(async () => {
      fireEvent.change(search, { target: { value: "signal_42" } });
    });

    // Only "signal_42" matches (substring; signal_420.. don't exist at 200).
    expect(screen.getByTestId("channels-count-pill").textContent).toBe("1");
    expect(screen.getAllByTestId(/^channel-row-/).length).toBe(1);
  });

  it("renders a different window of rows after scrolling down", () => {
    loadSession([makeSource("big.mcap", 2000)]);
    render(<ChannelsDrawer ensurePlotPanel={noop} />);

    // Capture the mounted window at the top of the list.
    const before = screen
      .getAllByTestId(/^channel-row-/)
      .map((el) => el.getAttribute("data-testid")!);
    expect(before.length).toBeGreaterThan(0);

    // Scroll well past the first viewport (34px header + ~1000×30px).
    scrollTopValue = 30_000;
    const scroller = screen.getByTestId("channels-groups");
    act(() => {
      fireEvent.scroll(scroller);
    });

    const after = new Set(
      screen.getAllByTestId(/^channel-row-/).map((el) => el.getAttribute("data-testid")!),
    );
    // The window moved: the original first row unmounted…
    expect(after.has(before[0])).toBe(false);
    // …and at least one freshly windowed-in row is now present.
    expect([...after].some((id) => !before.includes(id))).toBe(true);
  });

  it("collapsing a source hides its rows but keeps the header", () => {
    loadSession([makeSource("a.mcap", 50)]);
    render(<ChannelsDrawer ensurePlotPanel={noop} />);

    expect(screen.getAllByTestId(/^channel-row-/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("channels-group-a.mcap"));

    expect(screen.queryAllByTestId(/^channel-row-/).length).toBe(0);
    expect(screen.getByTestId("channels-group-a.mcap")).toBeTruthy();
  });
});

describe("ChannelsDrawer tree", () => {
  it("nests MCAP topics into collapsible branches", () => {
    seedTree([
      mcapChannel("/vehicle/speed"),
      mcapChannel("/vehicle/gps/lat"),
      mcapChannel("/vehicle/gps/lon"),
    ]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    // The `vehicle` branch carries all three descendants.
    const vehicle = screen.getByTestId("channels-branch-demo.mcap::vehicle");
    expect(vehicle.textContent).toContain("vehicle");
    expect(vehicle.textContent).toContain("3");

    // `gps` branch holds the two leaves.
    expect(
      screen.getByTestId("channels-branch-demo.mcap::vehicle/gps"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("channel-row-mcap::/vehicle/gps/lat"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("channel-row-mcap::/vehicle/gps/lon"),
    ).toBeTruthy();
  });

  it("collapses a branch and hides its descendants", () => {
    seedTree([mcapChannel("/vehicle/gps/lat")]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    expect(
      screen.getByTestId("channel-row-mcap::/vehicle/gps/lat"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("channels-branch-demo.mcap::vehicle"));
    expect(
      screen.queryByTestId("channel-row-mcap::/vehicle/gps/lat"),
    ).toBeNull();
  });

  it("groups MF4 channels under their channel-group label", () => {
    seedTree([
      mf4Channel("vehicle_speed", "speed @100Hz"),
      mf4Channel("imu_accel", "imu @1kHz"),
    ]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    const speedGroup = screen.getByTestId(
      "channels-branch-demo.mf4::speed @100Hz",
    );
    expect(within(speedGroup).getByText("speed @100Hz")).toBeTruthy();
    expect(
      screen.getByTestId("channel-row-mf4::speed @100Hz/vehicle_speed"),
    ).toBeTruthy();
  });

  it("filters by query and force-expands matching branches", async () => {
    seedTree([
      mcapChannel("/vehicle/gps/lat"),
      mcapChannel("/vehicle/speed"),
      mcapChannel("/imu/accel"),
    ]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("channels-search"), {
        target: { value: "gps" },
      });
    });

    expect(screen.getByTestId("channels-count-pill").textContent).toBe("1");
    expect(
      screen.getByTestId("channel-row-mcap::/vehicle/gps/lat"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("channel-row-mcap::/vehicle/speed"),
    ).toBeNull();
    expect(screen.queryByTestId("channel-row-mcap::/imu/accel")).toBeNull();
  });

  it("matches an MF4 group name in search", async () => {
    seedTree([
      mf4Channel("vehicle_speed", "Powertrain"),
      mf4Channel("imu_accel", "Inertial"),
    ]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("channels-search"), {
        target: { value: "powertrain" },
      });
    });
    expect(screen.getByTestId("channels-count-pill").textContent).toBe("1");
    expect(
      screen.getByTestId("channel-row-mf4::Powertrain/vehicle_speed"),
    ).toBeTruthy();
  });

  it("binds a channel to a freshly minted plot panel on leaf click", () => {
    seedTree([mcapChannel("/vehicle/speed")]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    fireEvent.click(screen.getByTestId("channel-row-mcap::/vehicle/speed"));
    expect(useSession.getState().plotBindings["plot-1"]).toEqual([
      "mcap::/vehicle/speed",
    ]);
  });
});
