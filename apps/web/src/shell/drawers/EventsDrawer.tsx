// Phase 8 · Event Tagging drawer (formerly "Bookmarks").
//
// Reads the `bookmarks` slice, `globalRange`, and `eventTagConfig` via
// discrete single-key selectors; rename / add / expand / range-draft
// state is local `useState`. Sort happens at render only — storage and
// slice preserve insertion order so a rename targets a stable index.
//
// Each event row stays a single-click "seek" button (the first <button>
// in the row, preserved for the existing tests) with a hover-revealed ×
// remove and an expand caret. Expanding a row reveals the range editor
// (optional before/after durations that turn the point into a
// [ns-before, ns+after] band) and one control per configured tag
// attribute (a <select> for `select`, an <input> for `text`).
//
// The conditional-rendering trap (frontend skill) is avoided: rename is
// `editingId === b.id ? <Input/> : <Span/>`, never a chained boolean.
// The add-button is `aria-disabled` + `disabled` when `globalRange ===
// null` because there is no meaningful cursor to anchor an event to.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../state/store";
import {
  parseBookmarksImport,
  serializeBookmarks,
} from "../../state/persist/bookmarks";
import { formatRelative } from "../../timeline/formatTime";
import drawerStyles from "../Drawer.module.css";
import { DRAWER_REGION_ID } from "../Drawer";
import { EventTagConfigEditor } from "./EventTagConfigEditor";
import s from "./EventsDrawer.module.css";

const HEADING_ID = "drawer-events-h";

function secondsString(ns: bigint): string {
  return String(Number(ns) / 1e9);
}

function nsFromSeconds(text: string): bigint | null {
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  return BigInt(Math.round(n * 1e9));
}

interface RangeDraft {
  // Only the field the user is editing is present; an absent field falls
  // back to the bookmark's committed value on blur (editing `after`
  // must not reset `before`, and vice-versa).
  before?: string;
  after?: string;
}

export function EventsDrawer() {
  const bookmarks = useSession((st) => st.bookmarks);
  const globalRange = useSession((st) => st.globalRange);
  const attributes = useSession((st) => st.eventTagConfig.attributes);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<string>("");
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rangeDrafts, setRangeDrafts] = useState<Record<string, RangeDraft>>(
    {},
  );
  const [importError, setImportError] = useState<string | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);

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
    if (expandedId === id) setExpandedId(null);
  };

  const toggleExpand = (id: string) =>
    setExpandedId((cur) => (cur === id ? null : id));

  const setRangeDraft = (id: string, patch: Partial<RangeDraft>) =>
    setRangeDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  const commitRange = (id: string) => {
    const b = bookmarks.find((x) => x.id === id);
    if (!b) return;
    const draft = rangeDrafts[id];
    // An untouched field (`undefined`) keeps the committed value; an
    // empty string clears to a point (`0n`); anything else parses.
    const resolve = (text: string | undefined, fallback: bigint): bigint => {
      if (text === undefined) return fallback;
      if (text.trim() === "") return 0n;
      return nsFromSeconds(text) ?? fallback;
    };
    useSession
      .getState()
      .setBookmarkRange(
        id,
        resolve(draft?.before, b.beforeNs),
        resolve(draft?.after, b.afterNs),
      );
    setRangeDrafts((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });
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

  // Import / export of the whole event list as JSON — same download /
  // hidden-file-input pattern as the tag-config editor below. Import
  // merges by id (collisions update in place) so re-importing a reviewed
  // file is idempotent rather than duplicating.
  const onExportEvents = () => {
    const text = serializeBookmarks(useSession.getState().bookmarks);
    if (
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      return;
    }
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "driveline-events.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const onImportEventsFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file) return;
    const text = await file.text();
    const parsed = parseBookmarksImport(text);
    if (!parsed) {
      setImportError("Could not parse that file as an event list.");
      return;
    }
    setImportError(null);
    useSession.getState().importBookmarks(parsed, "merge");
  };

  const disabled = globalRange === null;

  return (
    <aside
      id={DRAWER_REGION_ID}
      className={drawerStyles.drawer}
      role="region"
      aria-labelledby={HEADING_ID}
      data-testid="drawer-events"
    >
      <section className={s.section}>
        <div className={drawerStyles.heading}>
          <h3 id={HEADING_ID}>Event Tagging</h3>
          <span className={s.pill} data-testid="bookmarks-count-pill">
            {bookmarks.length}
          </span>
        </div>

        {sorted.length === 0 ? (
          <p className={s.empty} data-testid="bookmarks-empty">
            No events yet
          </p>
        ) : (
          <ul className={s.list} data-testid="bookmarks-list">
            {sorted.map((b) => {
              const meta =
                startNs !== null ? formatRelative(b.ns, startNs) : "—";
              const outOfRange =
                startNs !== null &&
                endNs !== null &&
                (b.ns < startNs || b.ns > endNs);
              const isEditing = editingId === b.id;
              const isExpanded = expandedId === b.id;
              const ranged = b.beforeNs > 0n || b.afterNs > 0n;
              const tagValues = attributes
                .map((a) => ({ a, v: b.tags[a.id] }))
                .filter((t) => t.v !== undefined && t.v !== "");
              return (
                <li
                  key={b.id}
                  className={s.rowItem}
                  data-testid={`bookmark-row-${b.id}`}
                  data-out-of-range={outOfRange ? "true" : undefined}
                  data-ranged={ranged ? "true" : undefined}
                >
                  {isEditing ? (
                    <div className={s.row} data-editing="true">
                      <span
                        className={s.swatch}
                        style={{ background: b.color }}
                        aria-hidden="true"
                      />
                      <input
                        ref={editInputRef}
                        type="text"
                        className={s.renameInput}
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        onKeyDown={onEditKey}
                        onBlur={commitEdit}
                        aria-label="Event label"
                        data-testid={`bookmark-rename-input-${b.id}`}
                      />
                      <span
                        className={s.meta}
                        data-testid={`bookmark-meta-${b.id}`}
                      >
                        {meta}
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={s.row}
                      onClick={() => onSeek(b.ns)}
                      data-testid={`bookmark-seek-${b.id}`}
                      aria-label={
                        outOfRange
                          ? `Out of range — Seek to ${b.label}`
                          : `Seek to ${b.label}`
                      }
                      title={
                        outOfRange
                          ? "Outside the current session's range"
                          : b.label
                      }
                    >
                      <span
                        className={s.swatch}
                        style={{ background: b.color }}
                        aria-hidden="true"
                      />
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
                      <span
                        className={s.meta}
                        data-testid={`bookmark-meta-${b.id}`}
                      >
                        {b.origin === "agent" ? (
                          <span
                            className={s.originBadge}
                            title={
                              b.confidence !== null
                                ? `Created by an agent · confidence ${Math.round(b.confidence * 100)}%`
                                : "Created by an agent"
                            }
                            data-testid={`bookmark-origin-${b.id}`}
                          >
                            agent
                            {b.confidence !== null
                              ? ` ${Math.round(b.confidence * 100)}%`
                              : ""}
                          </span>
                        ) : null}
                        {ranged ? (
                          <span className={s.rangeDot} aria-hidden="true" />
                        ) : null}
                        {meta}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className={s.expandBtn}
                    aria-label={
                      isExpanded
                        ? `Collapse details for ${b.label}`
                        : `Edit tags and range for ${b.label}`
                    }
                    aria-expanded={isExpanded}
                    title="Tags & range"
                    onClick={() => toggleExpand(b.id)}
                    data-testid={`bookmark-expand-${b.id}`}
                  >
                    <span
                      className={s.expandCaret}
                      data-open={isExpanded ? "true" : undefined}
                      aria-hidden="true"
                    >
                      ▸
                    </span>
                  </button>
                  <button
                    type="button"
                    className={s.removeBtn}
                    aria-label={`Remove event ${b.label}`}
                    title="Remove"
                    onClick={() => onRemove(b.id)}
                    data-testid={`bookmark-remove-${b.id}`}
                  >
                    ×
                  </button>

                  {!isExpanded && tagValues.length > 0 ? (
                    <div
                      className={s.chips}
                      data-testid={`bookmark-chips-${b.id}`}
                    >
                      {tagValues.map((t) => (
                        <span
                          key={t.a.id}
                          className={s.chip}
                          title={`${t.a.name}: ${t.v}`}
                        >
                          {t.v}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {isExpanded ? (
                    <div
                      className={s.details}
                      data-testid={`bookmark-details-${b.id}`}
                    >
                      <div className={s.rangeRow}>
                        <label className={s.field}>
                          <span className={s.fieldLabel}>before (s)</span>
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            className={s.numInput}
                            value={
                              rangeDrafts[b.id]?.before ??
                              secondsString(b.beforeNs)
                            }
                            onChange={(e) =>
                              setRangeDraft(b.id, { before: e.target.value })
                            }
                            onBlur={() => commitRange(b.id)}
                            data-testid={`bookmark-before-${b.id}`}
                          />
                        </label>
                        <label className={s.field}>
                          <span className={s.fieldLabel}>after (s)</span>
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            className={s.numInput}
                            value={
                              rangeDrafts[b.id]?.after ??
                              secondsString(b.afterNs)
                            }
                            onChange={(e) =>
                              setRangeDraft(b.id, { after: e.target.value })
                            }
                            onBlur={() => commitRange(b.id)}
                            data-testid={`bookmark-after-${b.id}`}
                          />
                        </label>
                      </div>

                      {attributes.length === 0 ? (
                        <p className={s.noAttrs}>
                          No tag attributes configured — add some below.
                        </p>
                      ) : (
                        <div className={s.tagGrid}>
                          {attributes.map((a) => (
                            <label key={a.id} className={s.field}>
                              <span className={s.fieldLabel}>{a.name}</span>
                              {a.type === "select" ? (
                                <select
                                  className={s.tagSelect}
                                  value={b.tags[a.id] ?? ""}
                                  onChange={(e) =>
                                    useSession
                                      .getState()
                                      .setBookmarkTag(
                                        b.id,
                                        a.id,
                                        e.target.value,
                                      )
                                  }
                                  data-testid={`bookmark-tag-${b.id}-${a.id}`}
                                >
                                  <option value="">—</option>
                                  {a.options.map((opt) => (
                                    <option key={opt} value={opt}>
                                      {opt}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  className={s.tagText}
                                  value={b.tags[a.id] ?? ""}
                                  onChange={(e) =>
                                    useSession
                                      .getState()
                                      .setBookmarkTag(
                                        b.id,
                                        a.id,
                                        e.target.value,
                                      )
                                  }
                                  data-testid={`bookmark-tag-${b.id}-${a.id}`}
                                />
                              )}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
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
                  ? "Load a fixture to tag the cursor"
                  : "Add an event at the current cursor"
              }
            >
              + event at cursor
            </button>
            <button
              type="button"
              className={s.addCustomBtn}
              onClick={onAddCustomStart}
              disabled={disabled}
              aria-disabled={disabled}
              aria-label="Add event with custom label"
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
              placeholder="event label"
              aria-label="Event label"
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
              aria-label="Cancel adding event"
            >
              ×
            </button>
          </div>
        )}

        <div className={s.ioRow}>
          <button
            type="button"
            className={s.ioBtn}
            onClick={onExportEvents}
            disabled={bookmarks.length === 0}
            data-testid="events-export"
          >
            Export
          </button>
          <button
            type="button"
            className={s.ioBtn}
            onClick={() => importFileRef.current?.click()}
            data-testid="events-import"
          >
            Import
          </button>
          <input
            ref={importFileRef}
            type="file"
            accept="application/json,.json"
            className={s.hiddenFile}
            onChange={onImportEventsFile}
            data-testid="events-import-input"
          />
        </div>
        {importError ? (
          <p
            className={s.ioError}
            role="alert"
            data-testid="events-import-error"
          >
            {importError}
          </p>
        ) : null}

        <EventTagConfigEditor />
      </section>
    </aside>
  );
}
