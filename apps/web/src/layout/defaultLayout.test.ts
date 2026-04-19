import { describe, expect, it } from "vitest";
import type { IJsonTabNode, IJsonTabSetNode } from "flexlayout-react";
import {
  DEFAULT_PLOT_PANEL_ID,
  DEFAULT_VIDEO_PANEL_ID,
  PANEL_COMPONENT_PLOT,
  PANEL_COMPONENT_VIDEO,
  defaultLayoutModel,
} from "./defaultLayout";

describe("defaultLayoutModel", () => {
  it("is a row with two tabsets", () => {
    expect(defaultLayoutModel.layout.type).toBe("row");
    const children = defaultLayoutModel.layout.children ?? [];
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.type).toBe("tabset");
    }
  });

  it("has exactly one video tab and one plot tab, each with the stable default id", () => {
    const children = (defaultLayoutModel.layout.children ??
      []) as IJsonTabSetNode[];
    const tabs: IJsonTabNode[] = children.flatMap((child) => child.children);
    const byComponent = new Map(tabs.map((t) => [t.component, t]));
    expect(tabs).toHaveLength(2);
    expect(byComponent.get(PANEL_COMPONENT_VIDEO)?.id).toBe(
      DEFAULT_VIDEO_PANEL_ID,
    );
    expect(byComponent.get(PANEL_COMPONENT_PLOT)?.id).toBe(
      DEFAULT_PLOT_PANEL_ID,
    );
  });

  it("splits 50/50 between the two tabsets", () => {
    const children = defaultLayoutModel.layout.children ?? [];
    const weights = children.map((c) => c.weight);
    expect(weights).toEqual([50, 50]);
  });
});
