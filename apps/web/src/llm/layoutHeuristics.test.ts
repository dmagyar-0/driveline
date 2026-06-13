import { describe, expect, it } from "vitest";
import { proposeLayoutHeuristic, MAX_PLOT_SERIES } from "./layoutHeuristics";
import type {
  ProposalChannel,
  ProposalChannelStat,
} from "./layoutProposal.types";

function ch(
  id: string,
  name: string,
  kind = "scalar",
  extra: Partial<ProposalChannel> = {},
): ProposalChannel {
  return {
    id,
    name,
    kind,
    dtype: "f64",
    unit: null,
    sampleCount: 100,
    ...extra,
  };
}

describe("proposeLayoutHeuristic", () => {
  it("returns an empty proposal for no channels", () => {
    const p = proposeLayoutHeuristic([]);
    expect(p.panels).toEqual([]);
    expect(p.rationale).toMatch(/no channels/i);
  });

  it("pairs lat/lon into a map panel and removes them from plots", () => {
    const channels = [
      ch("a", "gps/latitude"),
      ch("b", "gps/longitude"),
      ch("c", "vehicle/speed"),
    ];
    const p = proposeLayoutHeuristic(channels);
    const map = p.panels.find((x) => x.kind === "map");
    expect(map).toEqual({ kind: "map", latChannelId: "a", lonChannelId: "b" });
    // The lat/lon channels are not also plotted.
    const plotIds = p.panels
      .filter((x) => x.kind === "plot")
      .flatMap((x) => (x.kind === "plot" ? x.channelIds : []));
    expect(plotIds).toEqual(["c"]);
  });

  it("matches lon spelt 'lng'", () => {
    const channels = [ch("a", "pos/lat"), ch("b", "pos/lng")];
    const p = proposeLayoutHeuristic(channels);
    expect(p.panels[0]).toEqual({
      kind: "map",
      latChannelId: "a",
      lonChannelId: "b",
    });
  });

  it("rejects a lat/lon pair whose stats are out of degree range", () => {
    const channels = [ch("a", "gps/latitude"), ch("b", "gps/longitude")];
    const stats: Record<string, ProposalChannelStat> = {
      // "latitude" but range is clearly not degrees (a counter, say).
      a: { min: 0, max: 5000, constant: false },
      b: { min: 0, max: 5000, constant: false },
    };
    const p = proposeLayoutHeuristic(channels, stats);
    expect(p.panels.some((x) => x.kind === "map")).toBe(false);
    // Falls through to a plot.
    expect(p.panels.some((x) => x.kind === "plot")).toBe(true);
  });

  it("accepts a lat/lon pair with plausible degree-range stats", () => {
    const channels = [ch("a", "gps/lat"), ch("b", "gps/lon")];
    const stats: Record<string, ProposalChannelStat> = {
      a: { min: 37.1, max: 37.9, constant: false },
      b: { min: -122.5, max: -122.0, constant: false },
    };
    const p = proposeLayoutHeuristic(channels, stats);
    expect(p.panels[0].kind).toBe("map");
  });

  it("routes enum-kind channels to an enum lane", () => {
    const channels = [
      ch("g", "transmission/gear", "enum"),
      ch("m", "drive/mode", "enum"),
      ch("s", "vehicle/speed"),
    ];
    const p = proposeLayoutHeuristic(channels);
    const enumPanel = p.panels.find((x) => x.kind === "enum");
    expect(enumPanel).toEqual({ kind: "enum", channelIds: ["g", "m"] });
  });

  it("groups scalars by top-level name segment", () => {
    const channels = [
      ch("a", "vehicle/speed"),
      ch("b", "vehicle/brake"),
      ch("c", "engine/rpm"),
    ];
    const p = proposeLayoutHeuristic(channels);
    const plots = p.panels.filter((x) => x.kind === "plot");
    expect(plots).toHaveLength(2);
    const vehicle = plots.find(
      (x) => x.kind === "plot" && x.title === "Vehicle",
    );
    expect(vehicle && vehicle.kind === "plot" && vehicle.channelIds).toEqual([
      "a",
      "b",
    ]);
    const engine = plots.find((x) => x.kind === "plot" && x.title === "Engine");
    expect(engine && engine.kind === "plot" && engine.channelIds).toEqual([
      "c",
    ]);
  });

  it("caps and splits a group larger than MAX_PLOT_SERIES", () => {
    const n = MAX_PLOT_SERIES + 3;
    const channels = Array.from({ length: n }, (_, i) =>
      ch(`c${i}`, `bus/sig${i}`),
    );
    const p = proposeLayoutHeuristic(channels);
    const plots = p.panels.filter((x) => x.kind === "plot");
    expect(plots).toHaveLength(2);
    for (const plot of plots) {
      if (plot.kind === "plot") {
        expect(plot.channelIds.length).toBeLessThanOrEqual(MAX_PLOT_SERIES);
      }
    }
    // Every channel appears exactly once across the split plots.
    const all = plots.flatMap((x) => (x.kind === "plot" ? x.channelIds : []));
    expect(new Set(all).size).toBe(n);
    // The split panels get numbered titles.
    expect(plots[0].kind === "plot" && plots[0].title).toBe("Bus (1)");
    expect(plots[1].kind === "plot" && plots[1].title).toBe("Bus (2)");
  });

  it("combines map + enum + plot rules together", () => {
    const channels = [
      ch("lat", "gps/latitude"),
      ch("lon", "gps/longitude"),
      ch("gear", "transmission/gear", "enum"),
      ch("spd", "vehicle/speed"),
      ch("brk", "vehicle/brake"),
    ];
    const p = proposeLayoutHeuristic(channels);
    const kinds = p.panels.map((x) => x.kind).sort();
    expect(kinds).toEqual(["enum", "map", "plot"]);
    expect(p.rationale).toMatch(/GPS track/);
  });

  it("does not read 'lateral' as a latitude (substring false positive)", () => {
    const channels = [
      ch("a", "imu/accel_lateral"),
      ch("b", "gps/longitude"),
      ch("c", "vehicle/speed"),
    ];
    const p = proposeLayoutHeuristic(channels);
    expect(p.panels.some((x) => x.kind === "map")).toBe(false);
    // accel_lateral falls through to a plot, not a map's lat.
    const plotIds = p.panels
      .filter((x) => x.kind === "plot")
      .flatMap((x) => (x.kind === "plot" ? x.channelIds : []));
    expect(plotIds).toContain("a");
  });

  it("ignores video / bytes / point_cloud channels in the plot pool", () => {
    const channels = [
      ch("v", "cam/front", "video"),
      ch("p", "lidar/points", "point_cloud"),
      ch("s", "vehicle/speed"),
    ];
    const p = proposeLayoutHeuristic(channels);
    const plotIds = p.panels
      .filter((x) => x.kind === "plot")
      .flatMap((x) => (x.kind === "plot" ? x.channelIds : []));
    expect(plotIds).toEqual(["s"]);
  });
});
