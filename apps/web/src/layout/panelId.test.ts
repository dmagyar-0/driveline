import { describe, expect, it } from "vitest";
import { panelKindOf, panelNameFor } from "./panelId";

describe("panelKindOf", () => {
  it("recognises plot/video prefixes", () => {
    expect(panelKindOf("plot-abc")).toBe("plot");
    expect(panelKindOf("video-1")).toBe("video");
  });

  it("recognises Phase 6 prefixes", () => {
    expect(panelKindOf("scene-abc")).toBe("scene");
    expect(panelKindOf("map-abc")).toBe("map");
    expect(panelKindOf("table-abc")).toBe("table");
    expect(panelKindOf("enum-abc")).toBe("enum");
  });

  it("returns null for ids that don't carry a known prefix", () => {
    expect(panelKindOf("plot")).toBeNull(); // missing the dash
    expect(panelKindOf("widget-1")).toBeNull();
    expect(panelKindOf("")).toBeNull();
  });
});

describe("panelNameFor", () => {
  const sample = {
    layout: {
      type: "row",
      weight: 100,
      children: [
        {
          type: "tabset",
          weight: 50,
          children: [
            { type: "tab", id: "video-1", name: "Front cam", component: "video" },
            { type: "tab", id: "video-2", name: "Rear cam", component: "video" },
          ],
        },
        {
          type: "tabset",
          weight: 50,
          children: [
            { type: "tab", id: "plot-1", name: "Speed", component: "plot" },
          ],
        },
      ],
    },
  };

  it("returns the tab name for a matching id", () => {
    expect(panelNameFor(sample, "video-1")).toBe("Front cam");
    expect(panelNameFor(sample, "video-2")).toBe("Rear cam");
    expect(panelNameFor(sample, "plot-1")).toBe("Speed");
  });

  it("returns null when the id is not present", () => {
    expect(panelNameFor(sample, "video-9")).toBeNull();
  });

  it("returns null for null / non-object inputs", () => {
    expect(panelNameFor(null, "video-1")).toBeNull();
    expect(panelNameFor(undefined, "video-1")).toBeNull();
    expect(panelNameFor("not-an-object", "video-1")).toBeNull();
    expect(panelNameFor({}, "video-1")).toBeNull();
  });

  it("ignores tabs that lack a string name", () => {
    expect(
      panelNameFor(
        { layout: { type: "row", children: [{ type: "tab", id: "x" }] } },
        "x",
      ),
    ).toBeNull();
  });
});
