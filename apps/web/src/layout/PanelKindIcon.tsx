// Panel-kind visual identity: one hand-rolled stroke icon, a pretty
// display name, and a one-line blurb per `PanelKind`. Single source of
// truth for every surface that lists or labels panel kinds (the Panel
// drawer's identity card and empty-state legend, the persistent
// "+ Add panel" menu, the Layout drawer's add list).
//
// Icons are inline SVG on `currentColor` so the surrounding CSS picks
// the tint. They deliberately contain no <text>/<title> nodes: several
// tests assert `textContent` on ancestors of these icons, and a glyph
// must never leak characters into that contract.

import type { PanelKind } from "./panelId";

/** Canonical ordering for kind galleries and add-panel menus. */
export const PANEL_KINDS: readonly PanelKind[] = [
  "video",
  "plot",
  "scene",
  "map",
  "table",
  "value",
  "enum",
];

/** Human display name (menus, legends) — `kindLabel` stays the
 *  SCREAMING badge variant. Exhaustive so a new kind can't ship
 *  without a name. */
export function panelKindName(kind: PanelKind): string {
  switch (kind) {
    case "plot":
      return "Plot";
    case "video":
      return "Video";
    case "scene":
      return "3D scene";
    case "map":
      return "Map";
    case "table":
      return "Table";
    case "value":
      return "Value";
    case "enum":
      return "Enum";
  }
}

/** One-line "what does this panel do" blurb. Shown wherever a user
 *  picks or configures a kind, so keep each under ~60 chars. */
export function panelKindBlurb(kind: PanelKind): string {
  switch (kind) {
    case "plot":
      return "Signal channels drawn as lines over the shared timeline.";
    case "video":
      return "Frame-accurate video playback, synced to the cursor.";
    case "scene":
      return "Orbitable 3D point cloud that steps with the cursor.";
    case "map":
      return "Lat/lon track on a map with a marker at the cursor.";
    case "table":
      return "Raw samples in a time-ordered table around the cursor.";
    case "value":
      return "Large numeric readout of each channel at the cursor.";
    case "enum":
      return "Discrete states as labelled strips along the timeline.";
  }
}

interface IconProps {
  kind: PanelKind;
  /** Rendered width/height in px (viewBox is 24). */
  size?: number;
}

/** Decorative kind glyph. Always `aria-hidden` — pair it with visible
 *  text; it never stands alone as the only label. */
export function PanelKindIcon({ kind, size = 20 }: IconProps) {
  const svgProps = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };

  switch (kind) {
    case "plot":
      // Axes + a two-hump waveform.
      return (
        <svg {...svgProps}>
          <path d="M4.5 4.5v15h15" />
          <path d="M7.5 14.5c1.3-5 2.6-5 3.9 0s2.6 5 3.9 0 2.2-4 3.2-4.5" />
        </svg>
      );
    case "video":
      // Film frame with a solid play triangle.
      return (
        <svg {...svgProps}>
          <rect x="3.75" y="5.25" width="16.5" height="13.5" rx="2" />
          <path
            d="M10.25 9.25l5 2.75-5 2.75z"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      );
    case "scene":
      // Wireframe cube with a few cloud points on the front faces.
      return (
        <svg {...svgProps}>
          <path d="M12 3.75 18.75 7.5v9L12 20.25 5.25 16.5v-9L12 3.75z" />
          <path d="M5.25 7.5 12 11.25l6.75-3.75M12 11.25v9" />
          <circle cx="8.9" cy="14.2" r="1" fill="currentColor" stroke="none" />
          <circle cx="15.1" cy="13.4" r="1" fill="currentColor" stroke="none" />
          <circle cx="9.6" cy="17.2" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "map":
      // Location pin.
      return (
        <svg {...svgProps}>
          <path d="M12 20.5c-3.4-3.2-6-6.3-6-9.4a6 6 0 0 1 12 0c0 3.1-2.6 6.2-6 9.4z" />
          <circle cx="12" cy="11" r="2.1" />
        </svg>
      );
    case "table":
      // 3×2 grid.
      return (
        <svg {...svgProps}>
          <rect x="3.75" y="5" width="16.5" height="14" rx="1.5" />
          <path d="M3.75 9.25h16.5M3.75 14.1h16.5M9.75 9.25V19M15 9.25V19" />
        </svg>
      );
    case "value":
      // Gauge: arc, needle, hub.
      return (
        <svg {...svgProps}>
          <path d="M4.75 16.5a7.25 7.25 0 0 1 14.5 0" />
          <path d="M12 16.5l3.2-4.6" />
          <circle cx="12" cy="16.5" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      );
    case "enum":
      // State strip: one filled segment between dividers.
      return (
        <svg {...svgProps}>
          <rect x="3.75" y="9" width="16.5" height="6" rx="1.5" />
          <rect
            x="9.25"
            y="9"
            width="5"
            height="6"
            fill="currentColor"
            stroke="none"
          />
          <path d="M9.25 9v6M14.25 9v6" />
        </svg>
      );
  }
}
