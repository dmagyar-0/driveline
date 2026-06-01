// @vitest-environment jsdom
//
// ChannelsDrawer · tree rendering, search, and click-binding.
//
// The tree-building logic itself is unit-tested in `channelTree.test.ts`;
// this file pins the drawer's rendering and interaction contract: nested
// branches, MF4 grouping, search force-expand, and binding on leaf click.

import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ChannelsDrawer } from "./ChannelsDrawer";
import { useSession, type Channel, type SourceMeta } from "../../state/store";

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

function seedStore(channels: Channel[]) {
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

afterEach(async () => {
  cleanup();
  await useSession.getState().clear();
});

describe("ChannelsDrawer tree", () => {
  it("nests MCAP topics into collapsible branches", () => {
    seedStore([
      mcapChannel("/vehicle/speed"),
      mcapChannel("/vehicle/gps/lat"),
      mcapChannel("/vehicle/gps/lon"),
    ]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    // Top-level branch for the source, then the `vehicle` branch.
    const vehicle = screen.getByTestId("channels-branch-demo.mcap::vehicle");
    expect(vehicle.textContent).toContain("vehicle");
    // leafCount pill reflects the three descendants.
    expect(vehicle.textContent).toContain("3");

    // `gps` branch holds the two leaves.
    expect(
      screen.getByTestId("channels-branch-demo.mcap::vehicle/gps"),
    ).toBeTruthy();
    expect(screen.getByTestId("channel-row-mcap::/vehicle/gps/lat")).toBeTruthy();
    expect(screen.getByTestId("channel-row-mcap::/vehicle/gps/lon")).toBeTruthy();
  });

  it("collapses a branch and hides its descendants", () => {
    seedStore([mcapChannel("/vehicle/gps/lat")]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    expect(screen.getByTestId("channel-row-mcap::/vehicle/gps/lat")).toBeTruthy();
    fireEvent.click(screen.getByTestId("channels-branch-demo.mcap::vehicle"));
    expect(
      screen.queryByTestId("channel-row-mcap::/vehicle/gps/lat"),
    ).toBeNull();
  });

  it("groups MF4 channels under their channel-group label", () => {
    seedStore([
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

  it("filters by query and force-expands matching branches", () => {
    seedStore([
      mcapChannel("/vehicle/gps/lat"),
      mcapChannel("/vehicle/speed"),
      mcapChannel("/imu/accel"),
    ]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    fireEvent.change(screen.getByTestId("channels-search"), {
      target: { value: "gps" },
    });

    expect(screen.getByTestId("channels-count-pill").textContent).toBe("1");
    expect(screen.getByTestId("channel-row-mcap::/vehicle/gps/lat")).toBeTruthy();
    expect(
      screen.queryByTestId("channel-row-mcap::/vehicle/speed"),
    ).toBeNull();
    expect(screen.queryByTestId("channel-row-mcap::/imu/accel")).toBeNull();
  });

  it("matches an MF4 group name in search", () => {
    seedStore([
      mf4Channel("vehicle_speed", "Powertrain"),
      mf4Channel("imu_accel", "Inertial"),
    ]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    fireEvent.change(screen.getByTestId("channels-search"), {
      target: { value: "powertrain" },
    });
    expect(screen.getByTestId("channels-count-pill").textContent).toBe("1");
    expect(
      screen.getByTestId("channel-row-mf4::Powertrain/vehicle_speed"),
    ).toBeTruthy();
  });

  it("binds a channel to a freshly minted plot panel on leaf click", () => {
    seedStore([mcapChannel("/vehicle/speed")]);
    render(<ChannelsDrawer ensurePlotPanel={() => "plot-1"} />);

    fireEvent.click(screen.getByTestId("channel-row-mcap::/vehicle/speed"));
    expect(useSession.getState().plotBindings["plot-1"]).toEqual([
      "mcap::/vehicle/speed",
    ]);
  });
});
