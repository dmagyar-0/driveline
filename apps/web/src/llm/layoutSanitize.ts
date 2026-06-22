/**
 * Post-validation business logic for a model-authored `LayoutProposal`
 * (docs/12-format-agent.md §6). This is PURE, SDK-free, transport-free: it takes
 * a schema-valid proposal plus the REAL channel manifest and returns a proposal
 * safe to hand to the applier.
 *
 * SAFETY: the proposal is untrusted model output. Schema validation only checks
 * SHAPE — it does not prove that referenced channel ids exist or that per-panel
 * caps hold. `sanitizeProposal` enforces both. Do not alter the clamping logic
 * without updating docs/12 §6 + the tests; this is security-relevant.
 */

import { MAX_PLOT_SERIES } from "../panels/palette";
import type {
  LayoutProposal,
  PanelProposal,
  ProposalChannel,
} from "./layoutProposal.types";

/**
 * Sanitize a model-authored proposal against the real channel list + per-panel
 * caps (docs/12 §6). Drops unknown channel ids, de-duplicates, clamps plot
 * panels to `MAX_PLOT_SERIES`, drops panels left empty / incomplete, and drops a
 * map panel whose lat or lon id is unknown. Pure and total.
 */
export function sanitizeProposal(
  proposal: LayoutProposal,
  channels: ProposalChannel[],
): LayoutProposal {
  const known = new Set(channels.map((c) => c.id));
  const cleanList = (ids: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
      if (known.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  };

  const panels: PanelProposal[] = [];
  for (const panel of proposal.panels) {
    switch (panel.kind) {
      case "map": {
        if (
          known.has(panel.latChannelId) &&
          known.has(panel.lonChannelId) &&
          panel.latChannelId !== panel.lonChannelId
        ) {
          panels.push(panel);
        }
        break;
      }
      case "plot": {
        const ids = cleanList(panel.channelIds).slice(0, MAX_PLOT_SERIES);
        if (ids.length === 0) break;
        const groups = panel.yAxisGroups
          ?.map((g) => cleanList(g).filter((id) => ids.includes(id)))
          .filter((g) => g.length > 0);
        panels.push({
          kind: "plot",
          title: panel.title,
          channelIds: ids,
          ...(groups && groups.length > 0 ? { yAxisGroups: groups } : {}),
        });
        break;
      }
      case "enum":
      case "table":
      case "value": {
        const ids = cleanList(panel.channelIds);
        if (ids.length === 0) break;
        panels.push({ kind: panel.kind, channelIds: ids });
        break;
      }
    }
  }

  return { panels, rationale: proposal.rationale };
}
