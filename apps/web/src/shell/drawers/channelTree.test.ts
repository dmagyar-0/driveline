import { describe, it, expect } from "vitest";
import type { Channel } from "../../state/store";
import {
  buildChannelTree,
  channelPath,
  channelMatchesQuery,
  type ChannelTreeNode,
} from "./channelTree";

function ch(partial: Partial<Channel> & { name: string }): Channel {
  return {
    id: partial.id ?? `id:${partial.name}`,
    nativeId: partial.nativeId ?? partial.name,
    sourceId: partial.sourceId ?? "src",
    name: partial.name,
    group: partial.group,
    kind: partial.kind ?? "scalar",
    dtype: partial.dtype ?? "f64",
    unit: partial.unit ?? null,
    sampleCount: partial.sampleCount ?? 1,
    timeRange: partial.timeRange ?? { startNs: 0n, endNs: 1n },
  };
}

const labels = (nodes: ChannelTreeNode[]): string[] =>
  nodes.map((n) => n.label);

describe("channelPath", () => {
  it("splits MCAP topics on slash and drops the leading empty segment", () => {
    expect(channelPath(ch({ name: "/vehicle/gps/lat" }))).toEqual([
      "vehicle",
      "gps",
      "lat",
    ]);
  });

  it("prepends the MF4 group label ahead of the channel name", () => {
    expect(
      channelPath(ch({ name: "vehicle_speed", group: "Powertrain" })),
    ).toEqual(["Powertrain", "vehicle_speed"]);
  });

  it("falls back to the native id when the name has no usable segment", () => {
    expect(channelPath(ch({ name: "/", nativeId: "0/3" }))).toEqual(["0/3"]);
  });
});

describe("buildChannelTree", () => {
  it("nests MCAP topics into multiple levels", () => {
    const tree = buildChannelTree([
      ch({ name: "/vehicle/speed" }),
      ch({ name: "/vehicle/gps/lat" }),
      ch({ name: "/vehicle/gps/lon" }),
      ch({ name: "/imu/accel" }),
    ]);

    // Top level: two branches, alphabetical.
    expect(labels(tree)).toEqual(["imu", "vehicle"]);

    const vehicle = tree.find((n) => n.label === "vehicle")!;
    expect(vehicle.channel).toBeNull();
    expect(vehicle.leafCount).toBe(3);
    // Branch ("gps") sorts before leaf ("speed").
    expect(labels(vehicle.children)).toEqual(["gps", "speed"]);

    const gps = vehicle.children.find((n) => n.label === "gps")!;
    expect(labels(gps.children)).toEqual(["lat", "lon"]);
    expect(gps.children.every((n) => n.channel !== null)).toBe(true);
    expect(gps.children[0].key).toBe("vehicle/gps/lat");
  });

  it("groups MF4 channels under their channel-group label", () => {
    const tree = buildChannelTree([
      ch({ name: "vehicle_speed", group: "speed @100Hz" }),
      ch({ name: "imu_accel", group: "imu @1kHz" }),
    ]);
    expect(labels(tree)).toEqual(["imu @1kHz", "speed @100Hz"]);
    const speed = tree.find((n) => n.label === "speed @100Hz")!;
    expect(labels(speed.children)).toEqual(["vehicle_speed"]);
    expect(speed.children[0].channel?.name).toBe("vehicle_speed");
  });

  it("handles a topic that is also a prefix of deeper topics", () => {
    const tree = buildChannelTree([
      ch({ name: "/a", id: "leaf-a" }),
      ch({ name: "/a/b", id: "leaf-ab" }),
    ]);
    const a = tree.find((n) => n.label === "a")!;
    // `a` is both a bound channel and a branch holding `b`.
    expect(a.channel?.id).toBe("leaf-a");
    expect(labels(a.children)).toEqual(["b"]);
    expect(a.leafCount).toBe(2);
  });
});

describe("channelMatchesQuery", () => {
  const speed = ch({ name: "/vehicle/speed" });
  const grouped = ch({ name: "rpm", group: "Powertrain" });

  it("matches everything for an empty query", () => {
    expect(channelMatchesQuery(speed, "  ")).toBe(true);
  });

  it("matches on a path segment / message name", () => {
    expect(channelMatchesQuery(speed, "vehicle")).toBe(true);
    expect(channelMatchesQuery(speed, "SPEED")).toBe(true);
  });

  it("matches on an MF4 group name", () => {
    expect(channelMatchesQuery(grouped, "powertrain")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(channelMatchesQuery(speed, "imu")).toBe(false);
  });
});
