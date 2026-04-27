// Phase 3 · Panel-id convention.
//
// Panel ids are minted in `Workspace.tsx` as `${prefix}-${uuid}` with
// `prefix` ∈ {"plot", "video"}. Centralising the prefix and the
// discriminator here lets drawers identify a panel's kind from its id
// alone, without parsing the FlexLayout JSON model on every click.
// `Workspace.tsx` consumes the same constants when minting ids so the
// two stay in lockstep.

export const PLOT_PREFIX = "plot";
export const VIDEO_PREFIX = "video";

export type PanelKind = "plot" | "video";

export function panelKindOf(id: string): PanelKind | null {
  if (id.startsWith(`${PLOT_PREFIX}-`)) return "plot";
  if (id.startsWith(`${VIDEO_PREFIX}-`)) return "video";
  return null;
}
