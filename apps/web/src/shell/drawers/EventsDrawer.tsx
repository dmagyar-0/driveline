// Phase 8 · Events drawer (bookmarks).
//
// Replaces the inline `events` stub in `Drawer.tsx`. Reads the
// `bookmarks` slice and `globalRange` via discrete single-key
// selectors; rename state is local `useState`. Sort happens at render
// only — storage and slice preserve insertion order so a rename
// targets a stable index.
//
// The conditional rendering trap (frontend skill) is avoided: rename
// is `editingId === b.id ? <Input/> : <Span/>`, never a chained
// boolean. The add-button is `aria-disabled` + `disabled` when
// `globalRange === null` because there is no meaningful cursor to
// bookmark.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../state/store";
import { formatRelative } from "../../timeline/formatTime";
import drawerStyles from "../Drawer.module.css";
import s from "./EventsDrawer.module.css";

const HEADING_ID = "drawer-events-h";

export function EventsDrawer() {
  const bookmarks = useSession((st) => st.bookmarks);
  const globalRange = useSession((st) => st.globalRange);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<string>("");
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);

  const editInputRef = useRef<HTMLInputElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);

  const startNs = globalRange?.startNs ?? null;
  const endNs = globalRange?.endNs ?? null;

  const sorted = useMemo(() => {
    return [...bookmarks].sort((a, b) =>
      a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0,
    );
  }, [bookmarks]);

  useEffect(() => {
    if (editingId !== null) editInputRef.current?.focus();
  }, [editingId]);

  useEffect(() => {
    if (pendingLabel !== null) addInputRef.current?.focus();
  }, [pendingLabel]);

  const startEdit = (id: string, currentLabel: string) => {
    setEditingId(id);
    setEditingDraft(currentLabel);
  };

  const commitEdit = () => {
    if (editingId === null) return;
    useSession.getState().renameBookmark(editingId, editingDraft);
    setEditingId(null);
    setEditingDraft("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingDraft("");
  };

  const onEditKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const onSeek = (ns: bigint) => {
    useSession.getState().setCursor(ns);
  };

  const onRemove = (id: string) => {
    useSession.getState().removeBookmark(id);
    if (editingId === id) cancelEdit();
  };

  const onAddDefault = () => {
    if (globalRange === null) return;
    useSession.getState().addBookmarkAtCursor();
  };

  const onAddCustomStart = () => setPendingLabel("");
  const onAddCustomCancel = () => setPendingLabel(null);
  const onAddCustomCommit = () => {
    if (pendingLabel === null) return;
    if (globalRange === null) {
      setPendingLabel(null);
      return;
    }
    const trimmed = pendingLabel.trim();
    useSession
      .getState()
      .addBookmarkAtCursor(trimmed.length > 0 ? trimmed : undefined);
    setPendingLabel(null);
  };

  const onAddCustomKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onAddCustomCommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onAddCustomCancel();
    }
  };

  const disabled = globalRange === null;

  return (
    <aside
      className={drawerStyles.drawer}
      role="region"
      aria-labelledby={HEADING_ID}
      data-testid="drawer-events"
    >
      <section className={s.section}>
        <div className={drawerStyles.heading}>
          <h3 id={HEADING_ID}>Bookmarks</h3>
          <span className={s.pill} data-testid="bookmarks-count-pill">
            {bookmarks.length}
          </span>
        </div>

        {sorted.length === 0 ? (
          <p className={s.empty} data-testid="bookmarks-empty">
            No bookmarks yet
          </p>
        ) : (
          <ul className={s.list} data-testid="bookmarks-list">
            {sorted.map((b) => {
              const meta = startNs !== null ? formatRelative(b.ns, startNs) : "—";
              const outOfRange =
                startNs !== null &&
                endNs !== null &&
                (b.ns < startNs || b.ns > endNs);
              return (
                <li
                  key={b.id}
                  className={s.rowItem}
                  data-testid={`bookmark-row-${b.id}`}
                  data-out-of-range={outOfRange ? "true" : undefined}
                >
                  <button
                    type="button"
                    className={s.row}
                    onClick={() => onSeek(b.ns)}
                    data-testid={`bookmark-seek-${b.id}`}
                    aria-label={`Seek to ${b.label}`}
                  >
                    <span
                      className={s.swatch}
                      style={{ background: b.color }}
                      aria-hidden="true"
                    />
                    {editingId === b.id ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        className={s.renameInput}
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        onKeyDown={onEditKey}
                        onBlur={commitEdit}
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Bookmark label"
                        data-testid={`bookmark-rename-input-${b.id}`}
                      />
                    ) : (
                      <span
                        className={s.label}
                        title={b.label}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startEdit(b.id, b.label);
                        }}
                      >
                        {b.label}
                      </span>
                    )}
                    <span
                      className={s.meta}
                      data-testid={`bookmark-meta-${b.id}`}
                    >
                      {meta}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={s.removeBtn}
                    aria-label={`Remove bookmark ${b.label}`}
                    title="Remove"
                    onClick={() => onRemove(b.id)}
                    data-testid={`bookmark-remove-${b.id}`}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {pendingLabel === null ? (
          <div className={s.addRow}>
            <button
              type="button"
              className={s.addBtn}
              onClick={onAddDefault}
              disabled={disabled}
              aria-disabled={disabled}
              data-testid="bookmark-add-btn"
              title={
                disabled
                  ? "Load a fixture to bookmark the cursor"
                  : "Add a bookmark at the current cursor"
              }
            >
              + bookmark at cursor
            </button>
            <button
              type="button"
              className={s.addCustomBtn}
              onClick={onAddCustomStart}
              disabled={disabled}
              aria-disabled={disabled}
              aria-label="Add bookmark with custom label"
              data-testid="bookmark-add-custom-btn"
            >
              …
            </button>
          </div>
        ) : (
          <div className={s.savePending} data-testid="bookmark-add-pending">
            <input
              ref={addInputRef}
              type="text"
              className={s.nameInput}
              value={pendingLabel}
              placeholder="bookmark label"
              aria-label="Bookmark label"
              onChange={(e) => setPendingLabel(e.target.value)}
              onKeyDown={onAddCustomKey}
              data-testid="bookmark-add-input"
            />
            <button
              type="button"
              className={s.saveBtn}
              onClick={onAddCustomCommit}
              data-testid="bookmark-add-confirm"
            >
              Add
            </button>
            <button
              type="button"
              className={s.cancelBtn}
              onClick={onAddCustomCancel}
              aria-label="Cancel adding bookmark"
            >
              ×
            </button>
          </div>
        )}
      </section>
    </aside>
  );
}
