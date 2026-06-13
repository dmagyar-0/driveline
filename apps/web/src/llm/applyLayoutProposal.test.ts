import { describe, expect, it, vi } from "vitest";
import {
  applyLayoutPanels,
  applyLayoutProposal,
  type LayoutAgent,
} from "./applyLayoutProposal";
import type { LayoutProposal, PanelProposal } from "./layoutProposal.types";

/** A fake agent surface that records its calls and returns minted ids. */
function fakeAgent(
  opts: {
    createPanel?: (kind: string) => string | null;
    bindChannels?: () => boolean;
    setMapBinding?: () => boolean;
  } = {},
) {
  let n = 0;
  const calls: { method: string; args: unknown[] }[] = [];
  const agent: LayoutAgent = {
    createPanel: vi.fn((kind) => {
      calls.push({ method: "createPanel", args: [kind] });
      return opts.createPanel ? opts.createPanel(kind) : `${kind}-${++n}`;
    }),
    bindChannels: vi.fn((panelId, ids) => {
      calls.push({ method: "bindChannels", args: [panelId, ids] });
      return opts.bindChannels ? opts.bindChannels() : true;
    }),
    setMapBinding: vi.fn((panelId, lat, lon) => {
      calls.push({ method: "setMapBinding", args: [panelId, lat, lon] });
      return opts.setMapBinding ? opts.setMapBinding() : true;
    }),
  };
  return { agent, calls };
}

const PANELS: PanelProposal[] = [
  { kind: "plot", title: "Vehicle", channelIds: ["a", "b"] },
  { kind: "map", latChannelId: "lat", lonChannelId: "lon" },
  { kind: "enum", channelIds: ["g"] },
];

describe("applyLayoutPanels", () => {
  it("creates a panel and binds channels for each plot/enum panel", () => {
    const { agent } = fakeAgent();
    const result = applyLayoutPanels(PANELS, agent);
    expect(result.applied).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.panelIds).toHaveLength(3);
    expect(agent.createPanel).toHaveBeenCalledTimes(3);
  });

  it("uses setMapBinding for a map panel and bindChannels otherwise", () => {
    const { agent, calls } = fakeAgent();
    applyLayoutPanels(PANELS, agent);
    const map = calls.find((c) => c.method === "setMapBinding");
    expect(map?.args).toEqual([expect.stringMatching(/^map-/), "lat", "lon"]);
    const bind = calls.find((c) => c.method === "bindChannels");
    expect(bind?.args[1]).toEqual(["a", "b"]);
  });

  it("counts a failed createPanel as failed and skips its binding", () => {
    const { agent } = fakeAgent({ createPanel: () => null });
    const result = applyLayoutPanels(PANELS, agent);
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(3);
    expect(agent.bindChannels).not.toHaveBeenCalled();
  });

  it("counts a rejected binding as failed (panel minted, bind false)", () => {
    const { agent } = fakeAgent({ bindChannels: () => false });
    const result = applyLayoutPanels(
      [{ kind: "plot", title: "X", channelIds: ["a"] }],
      agent,
    );
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    // The minted panel id is still reported (it exists in the layout).
    expect(result.panelIds).toHaveLength(1);
  });

  it("reports all panels failed when no agent surface exists", () => {
    const result = applyLayoutPanels(PANELS, undefined);
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(3);
  });

  it("applyLayoutProposal applies every panel in the proposal", () => {
    const { agent } = fakeAgent();
    const proposal: LayoutProposal = { panels: PANELS, rationale: "r" };
    const result = applyLayoutProposal(proposal, agent);
    expect(result.applied).toBe(3);
  });
});
