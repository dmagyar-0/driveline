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

  return (
    <div className={s.markerLayer} data-testid="bookmark-marker-layer">
      {bookmarks.map((b) => {
        const off = b.ns - globalRange.startNs;
        const ratio = Number(off) / Number(span);
        const outOfRange = b.ns < globalRange.startNs || b.ns > globalRange.endNs;
        const pct = clamp01(ratio) * 100;
        const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
          e.stopPropagation();
          useSession.getState().setCursor(b.ns);
        };
        return (
          <div
            key={b.id}
            className={s.marker}
            data-testid={`bookmark-marker-${b.id}`}
            data-out-of-range={outOfRange ? "true" : undefined}
            style={{ left: `${pct}%`, background: b.color }}
            onPointerDown={onPointerDown}
            aria-hidden="true"
            title={b.label}
          />
        );
      })}
    </div>
  );
}
