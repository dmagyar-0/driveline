// Unknown-format dialog — the Format Agent entry point (docs/12-format-agent.md).
//
// A dropped file Driveline doesn't recognise (and that no Format Registry recipe
// matches) is queued as a `PendingUnknownImport`; this dialog renders the head.
// The user resolves it by supplying an **Ingest Recipe** — JSON describing how
// to decode the format — which is validated against the full local file via
// `dryRunRecipe` (the same `validate_recipe` signal the agent uses), then opened
// as a `recipe` source and saved to the registry for future drops.
//
// Phase 1 wires the manual / import-recipe path end to end. The "Decode with
// Claude" panel is the documented Phase 2 hook (BYOK agent loop); it's surfaced
// here so the flow reads completely, gated until that engine lands.
//
// Store-driven and self-contained (mirrors `TabularImportDialog`): no props,
// reads the one Zustand store via selectors. Mounted once in `Shell`.

import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "../state/store";
import { parseRecipe, type RawRecipeDryRunReport } from "../state/recipe";
import s from "./UnknownFormatDialog.module.css";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UnknownFormatDialog() {
  const head = useSession((st) => st.pendingUnknownImports[0] ?? null);
  const queueLen = useSession((st) => st.pendingUnknownImports.length);
  const dryRunRecipe = useSession((st) => st.dryRunRecipe);
  const confirmRecipeImport = useSession((st) => st.confirmRecipeImport);
  const cancelUnknownImport = useSession((st) => st.cancelUnknownImport);

  if (!head) return null;
  return (
    <UnknownFormatForm
      key={head.id}
      importId={head.id}
      name={head.name}
      size={head.size}
      queueLen={queueLen}
      onValidate={dryRunRecipe}
      onConfirm={confirmRecipeImport}
      onCancel={cancelUnknownImport}
    />
  );
}

interface FormProps {
  importId: string;
  name: string;
  size: number;
  queueLen: number;
  onValidate: (
    id: string,
    recipeJson: string,
  ) => Promise<RawRecipeDryRunReport | null>;
  onConfirm: (id: string, recipeJson: string) => Promise<void>;
  onCancel: (id: string) => void;
}

type Verdict =
  | { kind: "idle" }
  | { kind: "error"; message: string }
  | { kind: "report"; report: RawRecipeDryRunReport };

function UnknownFormatForm({
  importId,
  name,
  size,
  queueLen,
  onValidate,
  onConfirm,
  onCancel,
}: FormProps) {
  const [recipeText, setRecipeText] = useState("");
  const [verdict, setVerdict] = useState<Verdict>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLTextAreaElement | null>(null);

  const recipeId = useId();
  const titleId = useId();

  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel(importId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importId, onCancel, busy]);

  const loadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRecipeText(await file.text());
    setVerdict({ kind: "idle" });
  };

  const validate = async () => {
    const parsed = parseRecipe(recipeText);
    if ("error" in parsed) {
      setVerdict({ kind: "error", message: parsed.error });
      return;
    }
    setBusy(true);
    try {
      const report = await onValidate(importId, JSON.stringify(parsed.recipe));
      if (!report) {
        setVerdict({ kind: "error", message: "import is no longer queued" });
        return;
      }
      setVerdict({ kind: "report", report });
    } catch (err) {
      setVerdict({ kind: "error", message: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    const parsed = parseRecipe(recipeText);
    if ("error" in parsed) {
      setVerdict({ kind: "error", message: parsed.error });
      return;
    }
    setBusy(true);
    try {
      await onConfirm(importId, JSON.stringify(parsed.recipe));
    } finally {
      setBusy(false);
    }
  };

  const report = verdict.kind === "report" ? verdict.report : null;
  // A recipe is openable once a validation has run; the open path re-validates
  // in Rust regardless, so this only gates the happy-path button styling.
  const canOpen =
    report !== null &&
    Number(report.records_decoded) > 0 &&
    report.coverage > 0.5;

  return (
    <div
      className={s.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="unknown-format-dialog"
    >
      <div className={s.card} onClick={(e) => e.stopPropagation()}>
        <header className={s.header}>
          <h2 id={titleId} className={s.title}>
            Unrecognised format
          </h2>
          <p className={s.filename} data-testid="unknown-format-filename">
            {name} · {formatBytes(size)}
            {queueLen > 1 ? (
              <span className={s.queue}> · 1 of {queueLen}</span>
            ) : null}
          </p>
          <p className={s.blurb}>
            Driveline doesn&rsquo;t recognise this file. Provide an{" "}
            <strong>Ingest Recipe</strong> — a small JSON description of how to
            decode it — and Driveline reads it locally through the same pipeline
            as every other source. Recipes are saved per format, so this is a
            one-time step.
          </p>
        </header>

        <label className={s.field} htmlFor={recipeId}>
          <span className={s.label}>Ingest Recipe (JSON)</span>
          <textarea
            id={recipeId}
            ref={firstFieldRef}
            className={s.textarea}
            spellCheck={false}
            placeholder='{ "recipeVersion": 1, "container": { "type": "fixed_record", ... }, ... }'
            value={recipeText}
            onChange={(e) => {
              setRecipeText(e.target.value);
              if (verdict.kind !== "idle") setVerdict({ kind: "idle" });
            }}
            data-testid="unknown-format-recipe-input"
          />
        </label>

        <div className={s.importRow}>
          <label className={s.fileButton}>
            Import recipe file…
            <input
              type="file"
              accept=".json,application/json"
              onChange={loadFile}
              className={s.hiddenFile}
            />
          </label>
          <button
            type="button"
            className={s.validate}
            onClick={validate}
            disabled={busy || recipeText.trim().length === 0}
            data-testid="unknown-format-validate"
          >
            {busy && verdict.kind !== "report" ? "Validating…" : "Validate"}
          </button>
        </div>

        {verdict.kind === "error" ? (
          <p className={s.errorBox} data-testid="unknown-format-error">
            {verdict.message}
          </p>
        ) : null}

        {report ? <ValidationReport report={report} /> : null}

        <details className={s.byok}>
          <summary className={s.byokSummary}>
            Don&rsquo;t have a recipe? Decode with Claude (bring your own key)
          </summary>
          <p className={s.byokBody}>
            A managed agent can reverse-engineer this format from a bounded,
            consented sample of the file and hand back a recipe — using your own
            Anthropic API key, with the full file never leaving your browser.
            This engine ships in Phase 2 (see{" "}
            <code>docs/12-format-agent.md</code>). Until then, paste or import a
            recipe above.
          </p>
        </details>

        <div className={s.actions}>
          <button
            type="button"
            className={s.cancel}
            onClick={() => onCancel(importId)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={s.confirm}
            onClick={open}
            disabled={busy || recipeText.trim().length === 0}
            data-confident={canOpen ? "true" : "false"}
            data-testid="unknown-format-open"
          >
            Open source
          </button>
        </div>
      </div>
    </div>
  );
}

function ValidationReport({ report }: { report: RawRecipeDryRunReport }) {
  const decoded = Number(report.records_decoded);
  const rejected = Number(report.records_rejected);
  const coveragePct = (report.coverage * 100).toFixed(1);
  const violations = report.time_stats
    ? Number(report.time_stats.monotonic_violations)
    : 0;
  const ok = decoded > 0 && rejected === 0 && violations === 0;

  return (
    <div
      className={s.report}
      data-ok={ok ? "true" : "false"}
      data-testid="unknown-format-report"
    >
      <p className={s.reportHead}>
        {ok ? "✓ Recipe decodes cleanly" : "⚠ Recipe needs work"}
        <span className={s.reportStat}>
          {decoded.toLocaleString()} records · {coveragePct}% coverage ·{" "}
          {rejected} rejected · {violations} ordering issues
        </span>
      </p>
      <table className={s.channelTable}>
        <thead>
          <tr>
            <th>channel</th>
            <th>min</th>
            <th>max</th>
            <th>const</th>
          </tr>
        </thead>
        <tbody>
          {report.per_channel.map((c) => (
            <tr key={c.native_id}>
              <td className={s.chanName}>{c.native_id}</td>
              <td>{formatNum(c.min)}</td>
              <td>{formatNum(c.max)}</td>
              <td>{c.constant ? "yes" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000 || (n !== 0 && Math.abs(n) < 0.001)) {
    return n.toPrecision(5);
  }
  return n.toFixed(3).replace(/\.?0+$/, "");
}
