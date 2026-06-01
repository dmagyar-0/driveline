// Phase 2 · Sources drawer.
//
// Replaces the inline `sources` stub in `Drawer.tsx`. Reads `sources`
// and `globalRange` from the store via discrete single-key selectors so
// the drawer only re-renders when those change. Selection is local
// `useState`; Phase 3 (Channels drawer) lifts it to the `ui` slice when
// the channel list needs to filter by selected source.
//
// The drawer wrapper styling (and the drag-resizable width) lives in
// `Drawer.module.css:.drawer` / `.host`; this module only owns the inner
// content.

import { useRef, useState } from "react";
import { useSession } from "../../state/store";
import type { SourceKind } from "../../state/store";
import { colorFor } from "../../panels/palette";
import { formatAbsolute, formatDuration } from "../../timeline/formatTime";
import drawerStyles from "../Drawer.module.css";
import { DRAWER_REGION_ID } from "../Drawer";
import s from "./SourcesDrawer.module.css";

const HEADING_ID = "drawer-sources-h";

function kindLabel(k: SourceKind): "MCAP" | "MF4" | "MP4+TS" {
  if (k === "mcap") return "MCAP";
  if (k === "mf4") return "MF4";
  return "MP4+TS";
}

export function SourcesDrawer() {
  const sources = useSession((st) => st.sources);
  const globalRange = useSession((st) => st.globalRange);
  const openFiles = useSession((st) => st.openFiles);
  const errors = useSession((st) => st.lastOpenErrors);
  const dismissOpenErrors = useSession((st) => st.dismissOpenErrors);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const toggleSelect = (id: string) =>
    setSelectedId((prev) => (prev === id ? null : id));

  const onRowKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    id: string,
  ) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleSelect(id);
    }
  };

  const onLoadClick = () => fileInputRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files;
    if (picked && picked.length > 0) {
      await openFiles(Array.from(picked));
    }
    // Reset so picking the same file twice in a row still fires `onChange`.
    e.target.value = "";
  };

  return (
    <aside
      id={DRAWER_REGION_ID}
      className={drawerStyles.drawer}
      role="region"
      aria-labelledby={HEADING_ID}
      data-testid="drawer-sources"
    >
      <div className={drawerStyles.heading}>
        <h3 id={HEADING_ID}>Sources</h3>
        <span className={s.pill} data-testid="sources-count-pill">
          {sources.length}
        </span>
      </div>

      <ul className={s.list} data-testid="sources-list">
        {sources.map((src) => {
          const active = selectedId === src.id;
          return (
            <li key={src.id}>
              <button
                type="button"
                className={`${s.row} ${active ? s.rowActive : ""}`}
                aria-pressed={active}
                data-testid={`source-row-${src.id}`}
                onClick={() => toggleSelect(src.id)}
                onKeyDown={(e) => onRowKeyDown(e, src.id)}
              >
                <span
                  className={s.swatch}
                  style={{ background: colorFor(src.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={src.name}>
                  {src.name}
                </span>
                <span className={s.kind}>{kindLabel(src.kind)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className={s.loadRow}
        onClick={onLoadClick}
        data-testid="sources-load-btn"
      >
        + drop / load file…
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={s.hiddenInput}
        onChange={onFileChange}
        aria-hidden="true"
        tabIndex={-1}
      />

      {errors.length > 0 ? (
        <section
          className={s.errorsSection}
          data-testid="sources-errors"
          aria-live="polite"
        >
          <div className={s.errorsHeader}>
            <h3>Drop errors</h3>
            <button
              type="button"
              className={s.dismissBtn}
              onClick={dismissOpenErrors}
              aria-label="Dismiss drop errors"
              data-testid="sources-errors-dismiss"
            >
              ×
            </button>
          </div>
          <ul className={s.errorsList}>
            {errors.map((err, i) => (
              <li key={`${err.name}-${i}`} className={s.errorRow}>
                <span className={s.errorName} title={err.name}>
                  {err.name}
                </span>
                <span className={s.errorReason} title={err.reason}>
                  {err.reason}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <hr className={s.separator} />

      <section className={s.globalSection}>
        <h3>Global range</h3>
        {globalRange ? (
          <dl className={s.rangeBlock}>
            <dt>Start</dt>
            <dd>{formatAbsolute(globalRange.startNs)}</dd>
            <dt>End</dt>
            <dd>{formatAbsolute(globalRange.endNs)}</dd>
            <dt>Duration</dt>
            <dd>{formatDuration(globalRange.endNs - globalRange.startNs)}</dd>
          </dl>
        ) : (
          <p className={s.empty}>No sources loaded</p>
        )}
      </section>
    </aside>
  );
}
