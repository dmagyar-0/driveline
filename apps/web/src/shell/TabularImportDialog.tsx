// CSV / Parquet import-config dialog.
//
// A dropped `.csv`/`.parquet` can't open until the user declares its time
// basis (which column is time, its unit, absolute-vs-relative, the epoch
// offset). `openFiles` inspects the file and queues a `PendingTabularImport`;
// this dialog renders the head of that queue, lets the user adjust the
// suggested basis, previews the resulting UTC start time so the interpretation
// is verifiable, and on Confirm opens + registers the source (then advances to
// the next queued import, if any). Cancel drops the head.
//
// Store-driven and self-contained (mirrors `OpenErrorToast`): no props, reads
// the one Zustand store via selectors. Mounted once in `Shell`.

import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "../state/store";
import {
  TIME_UNITS,
  timeUnitLabel,
  isDraftValid,
  previewStartLabel,
  type BasisDraft,
  type TimeBasisMode,
  type TimeUnit,
} from "../state/tabularImport";
import s from "./TabularImportDialog.module.css";

export function TabularImportDialog() {
  // The head of the FIFO queue is the import currently being configured.
  const head = useSession((st) => st.pendingTabularImports[0] ?? null);
  const queueLen = useSession((st) => st.pendingTabularImports.length);
  const confirmTabularImport = useSession((st) => st.confirmTabularImport);
  const cancelTabularImport = useSession((st) => st.cancelTabularImport);

  if (!head) return null;
  // Remount the inner form per import id so each gets fresh draft state seeded
  // from its own suggested basis (and focus lands on the first control again).
  return (
    <TabularImportForm
      key={head.id}
      importId={head.id}
      name={head.name}
      format={head.format}
      columns={head.schema.columns}
      suggested={head.suggested}
      queueLen={queueLen}
      onConfirm={confirmTabularImport}
      onCancel={cancelTabularImport}
    />
  );
}

interface FormProps {
  importId: string;
  name: string;
  format: "csv" | "parquet";
  columns: ReadonlyArray<{ name: string; dtype: string; is_numeric: boolean }>;
  suggested: BasisDraft;
  queueLen: number;
  onConfirm: (id: string, basis: BasisDraft) => Promise<void>;
  onCancel: (id: string) => void;
}

function TabularImportForm({
  importId,
  name,
  format,
  columns,
  suggested,
  queueLen,
  onConfirm,
  onCancel,
}: FormProps) {
  const [draft, setDraft] = useState<BasisDraft>(suggested);
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);

  const columnId = useId();
  const unitId = useId();
  const offsetId = useId();
  const previewId = useId();
  const titleId = useId();

  // Initial focus + Escape-to-cancel. Cancel is stable for the import id.
  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel(importId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importId, onCancel, busy]);

  const valid = isDraftValid(draft);
  const isRelative = draft.mode === "Relative";
  const offsetLabel = isRelative
    ? "Clip start epoch (ns)"
    : "Epoch offset (ns)";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onConfirm(importId, draft);
    } finally {
      // The store dequeues this import on success; the component unmounts via
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
      data-testid="tabular-import-dialog"
    >
      <form
        className={s.card}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={s.header}>
          <h2 id={titleId} className={s.title}>
            Import {format.toUpperCase()}
          </h2>
          <p className={s.filename} data-testid="tabular-import-filename">
            {name}
            {queueLen > 1 ? (
              <span className={s.queue}> · 1 of {queueLen}</span>
            ) : null}
          </p>
        </header>

        <section className={s.columns} aria-label="Detected columns">
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Column</th>
                <th scope="col">Type</th>
                <th scope="col">Numeric</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c) => (
                <tr key={c.name}>
                  <td className={s.colName}>{c.name}</td>
                  <td className={s.colType}>{c.dtype}</td>
                  <td className={s.colNumeric}>
                    {c.is_numeric ? "yes" : "no"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <div className={s.field}>
          <label htmlFor={columnId} className={s.label}>
            Time column
          </label>
          <select
            id={columnId}
            ref={firstFieldRef}
            className={s.select}
            value={draft.timeColumn}
            onChange={(e) =>
              setDraft((d) => ({ ...d, timeColumn: e.target.value }))
            }
            data-testid="tabular-import-time-column"
          >
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className={s.field}>
          <label htmlFor={unitId} className={s.label}>
            Time unit
          </label>
          <select
            id={unitId}
            className={s.select}
            value={draft.unit}
            onChange={(e) =>
              setDraft((d) => ({ ...d, unit: e.target.value as TimeUnit }))
            }
            data-testid="tabular-import-unit"
          >
            {TIME_UNITS.map((u) => (
              <option key={u} value={u}>
                {timeUnitLabel(u)}
              </option>
            ))}
          </select>
        </div>

        <fieldset className={s.field}>
          <legend className={s.label}>Mode</legend>
          <div className={s.modeRow} role="radiogroup" aria-label="Time mode">
            {(["Absolute", "Relative"] as TimeBasisMode[]).map((m) => (
              <label key={m} className={s.radio}>
                <input
                  type="radio"
                  name={`mode-${importId}`}
                  value={m}
                  checked={draft.mode === m}
                  onChange={() => setDraft((d) => ({ ...d, mode: m }))}
                  data-testid={`tabular-import-mode-${m.toLowerCase()}`}
                />
                <span>{m}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className={s.field}>
          <label htmlFor={offsetId} className={s.label}>
            {offsetLabel}
          </label>
          <input
            id={offsetId}
            type="text"
            inputMode="numeric"
            className={s.input}
            value={draft.epochOffsetNs}
            onChange={(e) =>
              setDraft((d) => ({ ...d, epochOffsetNs: e.target.value }))
            }
            aria-describedby={previewId}
            spellCheck={false}
            data-testid="tabular-import-epoch-offset"
          />
        </div>

        <p
          id={previewId}
          className={s.preview}
          data-testid="tabular-import-preview"
        >
          <span className={s.previewLabel}>Start time</span>
          <span className={s.previewValue}>{previewStartLabel(draft)}</span>
        </p>

        <footer className={s.actions}>
          <button
            type="button"
            className={s.cancel}
            onClick={() => onCancel(importId)}
            disabled={busy}
            data-testid="tabular-import-cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={s.confirm}
            disabled={!valid || busy}
            data-testid="tabular-import-confirm"
          >
            {busy ? "Opening…" : "Import"}
          </button>
        </footer>
      </form>
    </div>
  );
}
