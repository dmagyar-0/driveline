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

import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "../../state/store";
import type { SourceKind } from "../../state/store";
import { parseEpochOffsetNs } from "../../state/tabularImport";
import { UrlLoad } from "../UrlLoad";
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
  const removeSource = useSession((st) => st.removeSource);
  const errors = useSession((st) => st.lastOpenErrors);
  const dismissOpenErrors = useSession((st) => st.dismissOpenErrors);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const toggleSelect = (id: string) =>
    setSelectedId((prev) => (prev === id ? null : id));

  const onCloseClick = (id: string) => {
    // Drop any local selection pointing at the row we're about to remove
    // so the drawer doesn't keep a highlight on a gone source.
    setSelectedId((prev) => (prev === id ? null : prev));
    void removeSource(id);
  };

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
            <li key={src.id} className={s.rowWrap}>
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
              <button
                type="button"
                className={s.closeBtn}
                onClick={() => onCloseClick(src.id)}
                aria-label={`Close ${src.name}`}
                title={`Close ${src.name}`}
                data-testid={`source-close-${src.id}`}
              >
                ×
              </button>
              {/* Per-source time offset (Feature 2). Signal sources only —
                  video alignment lives in the sidecar timestamps. Shown when
                  the row is selected to keep the list dense. */}
              {active && src.kind !== "mp4+sidecar" ? (
                <SourceOffsetEditor
                  sourceId={src.id}
                  offsetNs={src.timeOffsetNs ?? 0n}
                />
              ) : null}
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

      <UrlLoad variant="drawer" />

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

interface OffsetEditorProps {
  sourceId: string;
  offsetNs: bigint;
}

/**
 * Inline editor for a signal source's time offset (Feature 2). Edits the
 * offset as a decimal STRING so a full-precision ns value round-trips without
 * a lossy `Number`, and commits to the store on blur / Enter (an unparseable
 * value is rejected by `setSourceOffset`, so it's a no-op rather than a crash).
 * The draft re-seeds from the store whenever the committed offset changes so an
 * external update (dev hook, reset) stays reflected.
 */
function SourceOffsetEditor({ sourceId, offsetNs }: OffsetEditorProps) {
  const setSourceOffset = useSession((st) => st.setSourceOffset);
  const [draft, setDraft] = useState<string>(offsetNs.toString());
  const inputId = useId();

  // Reseed when the committed offset changes (external set, source swap).
  useEffect(() => {
    setDraft(offsetNs.toString());
  }, [offsetNs]);

  const commit = () => {
    const parsed = parseEpochOffsetNs(draft);
    if (parsed === null) {
      // Invalid input: snap the field back to the committed value.
      setDraft(offsetNs.toString());
      return;
    }
    setSourceOffset(sourceId, draft);
    // Normalise the field to the canonical committed form (e.g. "+5" → "5").
    setDraft(parsed.toString());
  };

  const invalid = parseEpochOffsetNs(draft) === null;

  return (
    <div className={s.offsetRow}>
      <label htmlFor={inputId} className={s.offsetLabel}>
        Offset (ns)
      </label>
      <input
        id={inputId}
        type="text"
        inputMode="numeric"
        spellCheck={false}
        className={s.offsetInput}
        value={draft}
        aria-invalid={invalid}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        data-testid={`source-offset-${sourceId}`}
      />
    </div>
  );
}
