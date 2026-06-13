/**
 * Layout-proposal applier (docs/12-format-agent.md §7).
 *
 * Places the checked panels of a `LayoutProposal` through the EXISTING
 * `__drivelineAgent` v2 write ops (`createPanel` → `bindChannels` /
 * `setMapBinding`) — the same path external agents and Playwright use. There is
 * NO parallel panel-creation code here; this module only orchestrates the ops
 * and reports what it placed.
 *
 * SDK-free and cheap, so the Apply UI imports it eagerly (no lazy chunk needed).
 * It takes the agent surface by parameter so it is trivially unit-testable, and
 * defaults to `window.__drivelineAgent` in the app.
 */

import type { AgentApi } from "../agent/agentApi";
import type { LayoutProposal, PanelProposal } from "./layoutProposal.types";

/** A minimal view of the agent surface the applier needs (the write ops). */
export type LayoutAgent = Pick<
  AgentApi,
  "createPanel" | "bindChannels" | "setMapBinding"
>;

export interface ApplyResult {
  /** Number of panels successfully created + bound. */
  applied: number;
  /** Panels that could not be placed (create or bind returned null/false). */
  failed: number;
  /** The minted panel ids, in application order. */
  panelIds: string[];
}

/**
 * Apply the given panels (an already-filtered subset of a proposal's panels)
 * through the agent write ops. Returns counts + the minted panel ids. Each panel
 * is independent: a failure to mint or bind one does not abort the rest, so a
 * partial proposal still places what it can. The `__drivelineAgent` ops validate
 * channel existence + caps themselves, so this layer trusts their boolean
 * verdicts and does no second-guessing.
 */
export function applyLayoutPanels(
  panels: PanelProposal[],
  agent: LayoutAgent | undefined = typeof window !== "undefined"
    ? window.__drivelineAgent
    : undefined,
): ApplyResult {
  const result: ApplyResult = { applied: 0, failed: 0, panelIds: [] };
  if (!agent) {
    // No agent surface (workspace not mounted / not opted in) — nothing placed.
    return { applied: 0, failed: panels.length, panelIds: [] };
  }

  for (const panel of panels) {
    const panelId = agent.createPanel(panel.kind);
    if (panelId === null) {
      result.failed += 1;
      continue;
    }
    const bound =
      panel.kind === "map"
        ? agent.setMapBinding(panelId, panel.latChannelId, panel.lonChannelId)
        : agent.bindChannels(panelId, panel.channelIds);
    if (bound) {
      result.applied += 1;
      result.panelIds.push(panelId);
    } else {
      // The panel minted but the binding was rejected (unknown id / over cap).
      // It stays in the layout empty; count it as a failure so the UI is honest.
      result.failed += 1;
      result.panelIds.push(panelId);
    }
  }
  return result;
}

/** Apply a whole proposal (all its panels). Convenience over `applyLayoutPanels`. */
export function applyLayoutProposal(
  proposal: LayoutProposal,
  agent?: LayoutAgent,
): ApplyResult {
  return applyLayoutPanels(proposal.panels, agent);
}
