// Shared primitives for the Panel drawer bodies (split out of the former
// 1.6k-line `PanelDrawer.tsx`). Pure helpers + constants only; the React
// components live in their own files under this folder.

import type { Channel } from "../../../state/store";

export interface BodyProps {
  panelId: string;
}

/** Frozen empty-binding sentinel so a panel with no bindings always reads
 *  the SAME array reference (selector identity stability). */
export const EMPTY: readonly string[] = Object.freeze([]);

/** Resolve bound channels in binding order, dropping any id that no longer
 *  resolves (a source closed). Shared by every multi-channel body. */
export function resolveBound(
  ids: readonly string[],
  byId: Map<string, Channel>,
): Channel[] {
  return ids
    .map((id) => byId.get(id))
    .filter((c): c is Channel => c !== undefined);
}

// Compact value formatting for the plot stats block. Mirrors PlotPanel's
// `formatValue` so the drawer and the chips agree on how a number reads.
export function formatStat(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return v.toExponential(3);
  return v.toFixed(3);
}
