// @vitest-environment jsdom
//
// ChannelsDrawer · grouping, filtering and windowing.
//
// The drawer windows its rows: only the slice intersecting the scroll
// viewport is mounted. jsdom reports 0 for every layout measurement
// (`clientHeight`, `scrollTop`), so we stub the scroll container's
// `clientHeight` to a fixed viewport before asserting that (a) far fewer
// than N rows are in the DOM for a large channel set, and (b) the count
// pill and filter still reflect the full/ filtered totals.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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

describe("ChannelsDrawer", () => {
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

    // Top of the list: the first channel is mounted, a deep one is not.
    const firstId = qualifiedChannelId("big.mcap", "0/0");
    const deepId = qualifiedChannelId("big.mcap", "0/1000");
    expect(screen.queryByTestId(`channel-row-${firstId}`)).toBeTruthy();
    expect(screen.queryByTestId(`channel-row-${deepId}`)).toBeNull();

    // Scroll well past row 1000 (34px header + 1000×30px ≈ 30k px).
    scrollTopValue = 30_000;
    const scroller = screen.getByTestId("channels-groups");
    act(() => {
      fireEvent.scroll(scroller);
    });

    // Now the deep row is windowed in and the first row is gone.
    expect(screen.queryByTestId(`channel-row-${deepId}`)).toBeTruthy();
    expect(screen.queryByTestId(`channel-row-${firstId}`)).toBeNull();
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
