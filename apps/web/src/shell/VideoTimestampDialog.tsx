// Sidecar-less mp4 timestamp-binding dialog (Feature 1 — the Alpamayo case).
//
// A dropped `.mp4` with no `.mp4.timestamps` sidecar can't open until the user
// picks a tabular source whose converted time column supplies the per-frame
// timestamps. `openFiles` slices the mp4 header and queues a
// `PendingVideoBinding`; this dialog renders the head of that queue, lets the
// user pick one of the currently-loaded tabular sources, and on Confirm
// synthesizes a sidecar from that source's time column and opens the mp4 via
// the existing `openMp4Sidecar` path (then advances to the next queued binding,
// if any). Cancel drops the head (the video is not loaded).
//
// Store-driven and self-contained (mirrors `TabularImportDialog`): no props,
// reads the one Zustand store via selectors. Mounted once in `Shell`. The
// queue is ordered AFTER tabular imports in `openFiles`, and this dialog only
// shows once the tabular-import queue has drained, so the source dropdown is
// already populated when a user drops an mp4 + csv together.

import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "../state/store";
import s from "./VideoTimestampDialog.module.css";

export function VideoTimestampDialog() {
  // The tabular import dialog takes precedence — defer until its queue drains
  // so the source dropdown below is populated.
  const tabularPending = useSession(
    (st) => st.pendingTabularImports.length > 0,
  );
  const head = useSession((st) => st.pendingVideoBindings[0] ?? null);
  const queueLen = useSession((st) => st.pendingVideoBindings.length);
  const tabularSources = useSession((st) =>
    st.sources.filter((src) => src.kind === "tabular"),
  );
  const confirmVideoBinding = useSession((st) => st.confirmVideoBinding);
  const cancelVideoBinding = useSession((st) => st.cancelVideoBinding);

  if (!head || tabularPending) return null;
  // Remount per binding id so each gets fresh local state (and focus lands on
  // the first control again).
  return (
    <VideoTimestampForm
      key={head.id}
      bindingId={head.id}
      name={head.name}
      queueLen={queueLen}
      tabularSources={tabularSources.map((src) => ({
        id: src.id,
        name: src.name,
      }))}
      onConfirm={confirmVideoBinding}
      onCancel={cancelVideoBinding}
    />
  );
}

interface FormProps {
  bindingId: string;
  name: string;
  queueLen: number;
  tabularSources: ReadonlyArray<{ id: string; name: string }>;
  onConfirm: (id: string, tabularSourceId: string) => Promise<void>;
  onCancel: (id: string) => void;
}

function VideoTimestampForm({
  bindingId,
  name,
  queueLen,
  tabularSources,
  onConfirm,
  onCancel,
}: FormProps) {
  const hasSources = tabularSources.length > 0;
  const [selectedId, setSelectedId] = useState<string>(
    tabularSources[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const sourceId = useId();
  const titleId = useId();
  const noteId = useId();

  // Initial focus + Escape-to-cancel.
  useEffect(() => {
    (firstFieldRef.current ?? cancelRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel(bindingId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindingId, onCancel, busy]);

  const valid = hasSources && selectedId.length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onConfirm(bindingId, selectedId);
    } finally {
      // The store dequeues this binding on success; the component unmounts via
      // the parent's `key`. If the open failed it stays queued — re-enable.
      setBusy(false);
    }
  };

  return (
    <div
      className={s.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="video-timestamp-dialog"
    >
      <form
        className={s.card}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={s.header}>
          <h2 id={titleId} className={s.title}>
            Align video to a signal clock
          </h2>
          <p className={s.filename} data-testid="video-timestamp-filename">
            {name}
            {queueLen > 1 ? (
              <span className={s.queue}> · 1 of {queueLen}</span>
            ) : null}
          </p>
        </header>

        <p className={s.body} id={noteId}>
          This video has no <code>.mp4.timestamps</code> sidecar. Pick a loaded
          tabular source whose time column gives one timestamp per video frame
          (row 0 → frame 0, in decode order). The row count must equal the
          video&rsquo;s frame count.
        </p>

        {hasSources ? (
          <div className={s.field}>
            <label htmlFor={sourceId} className={s.label}>
              Timestamp source
            </label>
            <select
              id={sourceId}
              ref={firstFieldRef}
              className={s.select}
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              aria-describedby={noteId}
              data-testid="video-timestamp-source"
            >
              {tabularSources.map((src) => (
                <option key={src.id} value={src.id}>
                  {src.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p
            className={s.empty}
            role="status"
            data-testid="video-timestamp-empty"
          >
            No tabular source is loaded. Drop a CSV or Parquet file with the
            per-frame timestamps first, or cancel to skip this video.
          </p>
        )}

        <footer className={s.actions}>
          <button
            type="button"
            ref={cancelRef}
            className={s.cancel}
            onClick={() => onCancel(bindingId)}
            disabled={busy}
            data-testid="video-timestamp-cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={s.confirm}
            disabled={!valid || busy}
            data-testid="video-timestamp-confirm"
          >
            {busy ? "Opening…" : "Align video"}
          </button>
        </footer>
      </form>
    </div>
  );
}
