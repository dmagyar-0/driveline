// Phase 7+ · Per-panel-kind identity icon.
//
// Replaces the previous text badge (`PLOT` / `VIDEO` / …) with a small
// SVG glyph that gives the panel an at-a-glance identity. The icon
// doubles as the drag affordance (`cursor: grab` lives on the wrapping
// header row in `PanelHeader.module.css`).
//
// `accentVar` returns the CSS variable name carrying the panel-kind
// accent colour — consumed by `PanelHeader.module.css` to paint the
// thin 2-px header underline. Centralising the colour mapping here
// keeps the chrome → series colour space separation honest: these
// are *chrome* tokens (one per panel kind), not plot palette tokens.

import type { PanelKind } from "./panelId";

export const PANEL_KIND_LABEL: Record<PanelKind, string> = {
  plot: "Plot",
  video: "Video",
  scene: "Scene",
  map: "Map",
  table: "Table",
  enum: "Enum",
};

/**
 * CSS custom property carrying the kind's accent colour. Declared in
 * `PanelHeader.module.css`. Kept as a function (not a record of raw
 * hex strings) so tokens stay in CSS where the dark-mode palette
 * decisions live.
 */
export function panelKindAccentVar(kind: PanelKind): string {
  return `var(--panel-kind-${kind}-accent)`;
}

interface IconProps {
  kind: PanelKind;
  size?: number;
}

/**
 * Renders the kind's SVG glyph. Icons live inline so they share the
 * tab strip's `currentColor` and don't pull in an icon font. Stroke
 * width and viewbox are normalised to 16×16 for consistent visual
 * weight against the other tab chrome icons.
 */
export function PanelTypeIcon({
  kind,
  size = 14,
}: IconProps): React.ReactElement {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "video":
      return (
        <svg {...common}>
          <rect x="1.5" y="4" width="9" height="8" rx="1" />
          <path d="M10.5 7l4-2v6l-4-2z" />
        </svg>
      );
    case "plot":
      return (
        <svg {...common}>
          <path d="M2 13V3" />
          <path d="M2 13h12" />
          <path d="M3.5 10l3-4 3 2 3-5" />
        </svg>
      );
    case "map":
      return (
        <svg {...common}>
          <path d="M2 3.5l4-1 4 2 4-1v9l-4 1-4-2-4 1z" />
          <path d="M6 2.5v9" />
          <path d="M10 4.5v9" />
        </svg>
      );
    case "scene":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="2" />
          <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2" />
        </svg>
      );
    case "table":
      return (
        <svg {...common}>
          <rect x="1.5" y="3" width="13" height="10" rx="1" />
          <path d="M1.5 6.5h13" />
          <path d="M1.5 9.5h13" />
          <path d="M6 3v10" />
        </svg>
      );
    case "enum":
      return (
        <svg {...common}>
          <path d="M3 4h2M3 8h2M3 12h2" />
          <path d="M7 4h6M7 8h6M7 12h6" />
        </svg>
      );
  }
}
