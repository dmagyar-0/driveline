// Phase 3 · Panel-id convention. Phase 6 extended the discriminator to
// the four new panel kinds (scene / map / table / enum).
//
// Panel ids are minted in `Workspace.tsx` as `${prefix}-${uuid}` with
// `prefix` ∈ {plot, video, scene, map, table, enum}. Centralising the
// prefix and the discriminator here lets drawers identify a panel's
// kind from its id alone, without parsing the FlexLayout JSON model on
// every click. `Workspace.tsx` consumes the same constants when minting
// ids so the two stay in lockstep.

export const PLOT_PREFIX = "plot";
export const VIDEO_PREFIX = "video";
export const SCENE_PREFIX = "scene";
export const MAP_PREFIX = "map";
export const TABLE_PREFIX = "table";
export const VALUE_PREFIX = "value";
export const ENUM_PREFIX = "enum";

export type PanelKind =
  | "plot"
  | "video"
  | "scene"
  | "map"
  | "table"
  | "value"
  | "enum";

export function panelKindOf(id: string | null | undefined): PanelKind | null {
  // Selection state can legitimately be empty, and untyped callers (the
  // `setSelectedPanelId` dev hook is driven from Playwright's JS) can hand
  // over `undefined` where the types say `string`. Any non-string id means
  // "no kind" — never a `startsWith` crash.
  if (typeof id !== "string") return null;
  if (id.startsWith(`${PLOT_PREFIX}-`)) return "plot";
  if (id.startsWith(`${VIDEO_PREFIX}-`)) return "video";
  if (id.startsWith(`${SCENE_PREFIX}-`)) return "scene";
  if (id.startsWith(`${MAP_PREFIX}-`)) return "map";
  if (id.startsWith(`${TABLE_PREFIX}-`)) return "table";
  if (id.startsWith(`${VALUE_PREFIX}-`)) return "value";
  if (id.startsWith(`${ENUM_PREFIX}-`)) return "enum";
  return null;
}

// Phase 7 · single source of truth for the human-readable kind badge
// used by the Panel drawer header and (now) the per-tab chrome in
// `Workspace.tsx`. Exhaustive switch over `PanelKind` so adding a kind
// in `panelId.ts` forces the badge label to be filled in too.
export function kindLabel(kind: PanelKind): string {
  switch (kind) {
    case "plot":
      return "PLOT";
    case "video":
      return "VIDEO";
    case "scene":
      return "SCENE";
    case "map":
      return "MAP";
    case "table":
      return "TABLE";
    case "value":
      return "VALUE";
    case "enum":
      return "ENUM";
  }
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
