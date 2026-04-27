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

// Phase 5 · Walk a FlexLayout JSON model looking for a tab with a
// matching `id`, returning the tab's `name`. The Panel drawer needs
// to label "the panel you are configuring"; this lets it do so without
// the FlexLayout `Model` instance (which is not in the store — only
// the JSON snapshot is). Returns `null` if the id isn't found or the
// JSON is shaped unexpectedly. Pure function, no FlexLayout import.
export function panelNameFor(
  layoutJson: unknown,
  panelId: string,
): string | null {
  if (!layoutJson || typeof layoutJson !== "object") return null;
  const root = (layoutJson as { layout?: unknown }).layout;
  return walk(root, panelId);
}

function walk(node: unknown, panelId: string): string | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as {
    type?: unknown;
    id?: unknown;
    name?: unknown;
    children?: unknown;
  };
  if (obj.type === "tab" && obj.id === panelId) {
    return typeof obj.name === "string" ? obj.name : null;
  }
  if (Array.isArray(obj.children)) {
    for (const child of obj.children) {
      const hit = walk(child, panelId);
      if (hit !== null) return hit;
    }
  }
  return null;
}
