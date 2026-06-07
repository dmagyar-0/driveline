// Phase 8 · Bookmark markers overlay for the transport scrubber.
//
// Rendered as a child of `Transport.tsx`'s `.trackStrip`. Owns its own
// store selectors so Transport stays unaware — re-renders here when
// `bookmarks` mutates do not dirty the scrubber's pointerdown closures.
//
// Marker primitive: a 2px-wide div positioned with `left: <pct>%` plus
// `transform: translateX(-50%)` only (frontend-skill perf rule — never
// animate `left`/`width`/colour). The wrapping layer is
// `pointer-events: none` so the rest of the track keeps its drag
// gesture; individual markers re-enable `pointer-events: auto`.
//
// `pointerdown` on a marker calls `setCursor(b.ns)` and stops
// propagation so the click does not also seed a scrub gesture against
// the parent track.
//
// Markers are visual-only — keyboard access to bookmarks is provided
// by the Events drawer (one tab stop per bookmark there). We don't
// add a parallel keyboard path here because it would (a) duplicate
// the drawer surface and (b) crowd the timeline tab order.

import { useSession } from "../state/store";
import s from "./BookmarkMarkers.module.css";

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function BookmarkMarkers() {
  const bookmarks = useSession((st) => st.bookmarks);
  const globalRange = useSession((st) => st.globalRange);

  if (!globalRange) return null;
  if (bookmarks.length === 0) return null;

  const span = globalRange.endNs - globalRange.startNs;
  if (span === 0n) return null;

  const startNs = globalRange.startNs;
  const endNs = globalRange.endNs;
  const pctOf = (ns: bigint): number =>
    clamp01(Number(ns - startNs) / Number(span)) * 100;

  return (
    <div className={s.markerLayer} data-testid="bookmark-marker-layer">
      {bookmarks.map((b) => {
        const pct = pctOf(b.ns);
        const outOfRange = b.ns < startNs || b.ns > endNs;
        const ranged = b.beforeNs > 0n || b.afterNs > 0n;
        const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
          e.stopPropagation();
          useSession.getState().setCursor(b.ns);
        };
        // A band element for ranged events, drawn behind the center
        // line. Width is the clamped %-span of [ns-before, ns+after];
        // it shares the marker layer's `pointer-events: none` base and
        // re-enables clicks (seek to the anchor) on the band itself.
        const bandStartPct = ranged ? pctOf(b.ns - b.beforeNs) : pct;
        const bandEndPct = ranged ? pctOf(b.ns + b.afterNs) : pct;
        const bandWidthPct = Math.max(0, bandEndPct - bandStartPct);
        return (
          <div key={b.id} className={s.markerGroup}>
            {ranged ? (
              <div
                className={s.band}
                data-testid={`bookmark-band-${b.id}`}
                data-out-of-range={outOfRange ? "true" : undefined}
                style={{
                  left: `${bandStartPct}%`,
                  width: `${bandWidthPct}%`,
                  background: b.color,
                }}
                onPointerDown={onPointerDown}
                aria-hidden="true"
                title={b.label}
              />
            ) : null}
            <div
              className={s.marker}
              data-testid={`bookmark-marker-${b.id}`}
              data-out-of-range={outOfRange ? "true" : undefined}
              style={{ left: `${pct}%`, background: b.color }}
              onPointerDown={onPointerDown}
              aria-hidden="true"
              title={b.label}
            />
          </div>
        );
      })}
    </div>
  );
}
