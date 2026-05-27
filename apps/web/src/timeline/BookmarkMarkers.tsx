// Bookmark markers overlay for the transport scrubber.
//
// Owns its own store selectors so Transport stays unaware —
// re-renders here on `bookmarks` mutations do not dirty the
// scrubber's pointerdown closures.
//
// `pointerdown` on a marker calls `setCursor(b.ns)` and stops
// propagation so the click does not also seed a scrub gesture
// against the parent track.
//
// Keyboard access to bookmarks lives in the Events drawer; not
// duplicated here so the timeline tab order stays tight.

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
