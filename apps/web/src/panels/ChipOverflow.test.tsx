// @vitest-environment jsdom
//
// Unit tests for the chip overflow popover (iter4 alignment item #5).
//
// The component is pure-presentational — the parent computes which
// channels overflowed and feeds them in. We assert the pill renders
// the correct count, the popover only appears when `open` is true,
// and Escape / outside-click dismissal fires the close handler.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChipOverflow } from "./ChipOverflow";
import type { Channel } from "../state/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function mkChannel(over: Partial<Channel>): Channel {
  return {
    id: over.id ?? "id",
    nativeId: over.nativeId ?? "n",
    sourceId: over.sourceId ?? "src",
    name: over.name ?? "/vehicle/speed",
    kind: over.kind ?? "scalar",
    dtype: over.dtype ?? "f64",
    unit: over.unit ?? null,
    sampleCount: over.sampleCount ?? 0,
    timeRange: over.timeRange ?? { startNs: 0n, endNs: 0n },
  };
}

afterEach(() => cleanup());

describe("<ChipOverflow />", () => {
  it("renders nothing when there are no hidden channels", () => {
    const { queryByTestId } = render(
      <ChipOverflow
        hiddenChannels={[]}
        badges={new Map()}
        open={false}
        onToggle={() => {}}
        onClose={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(queryByTestId("plot-chips-overflow")).toBeNull();
  });

  it("shows the pill with the correct count", () => {
    const { getByTestId } = render(
      <ChipOverflow
        hiddenChannels={[
          mkChannel({ id: "a" }),
          mkChannel({ id: "b" }),
          mkChannel({ id: "c" }),
        ]}
        badges={new Map()}
        open={false}
        onToggle={() => {}}
        onClose={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(getByTestId("plot-chips-overflow").textContent).toBe("+3 more");
  });

  it("renders the popover only when open", () => {
    const channels = [mkChannel({ id: "a" }), mkChannel({ id: "b" })];
    const closed = render(
      <ChipOverflow
        hiddenChannels={channels}
        badges={new Map()}
        open={false}
        onToggle={() => {}}
        onClose={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(closed.queryByTestId("plot-chips-overflow-popover")).toBeNull();
    closed.unmount();

    const opened = render(
      <ChipOverflow
        hiddenChannels={channels}
        badges={new Map()}
        open
        onToggle={() => {}}
        onClose={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(opened.getByTestId("plot-chips-overflow-popover")).toBeTruthy();
    expect(opened.getByTestId("chip-a")).toBeTruthy();
    expect(opened.getByTestId("chip-b")).toBeTruthy();
  });

  it("invokes onToggle when the pill is clicked", () => {
    const onToggle = vi.fn();
    const { getByTestId } = render(
      <ChipOverflow
        hiddenChannels={[mkChannel({ id: "a" })]}
        badges={new Map()}
        open={false}
        onToggle={onToggle}
        onClose={() => {}}
        onRemove={() => {}}
      />,
    );
    fireEvent.click(getByTestId("plot-chips-overflow"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed while open", () => {
    const onClose = vi.fn();
    render(
      <ChipOverflow
        hiddenChannels={[mkChannel({ id: "a" })]}
        badges={new Map()}
        open
        onToggle={() => {}}
        onClose={onClose}
        onRemove={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when a click lands outside the popover", () => {
    const onClose = vi.fn();
    render(
      <ChipOverflow
        hiddenChannels={[mkChannel({ id: "a" })]}
        badges={new Map()}
        open
        onToggle={() => {}}
        onClose={onClose}
        onRemove={() => {}}
      />,
    );
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
