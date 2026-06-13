// Unknown-format dialog — the Format Agent entry point (docs/12-format-agent.md).
//
// A dropped file Driveline doesn't recognise (and that no Format Registry recipe
// matches) is queued as a `PendingUnknownImport`; this dialog renders the head.
// The user resolves it by supplying an **Ingest Recipe** — JSON describing how
// to decode the format — which is validated against the full local file via
// `dryRunRecipe` (the same `validate_recipe` signal the agent uses), then opened
// as a `recipe` source and saved to the registry for future drops.
//
// Two paths, both ending in `confirmRecipeImport`:
//   1. Manual — paste / import a recipe, validate, open (Phase 1).
//   2. Decode with Claude (BYOK) — the Phase 2 multi-step flow: key → consent
//      (renders the exact sample manifest + a hex/ASCII preview) → run (streams
//      `AgentProgress`, hard Abort) → outcome (success registers the recipe;
//      failures surface findings and fall back to the manual path). The engine
//      and SDK live in the lazily-imported `llm/` chunk; this dialog only loads
//      it when the user clicks the CTA (keeps the SDK out of first load).
//
// Store-driven and self-contained (mirrors `TabularImportDialog`): no props,
// reads the one Zustand store via selectors. Mounted once in `Shell`.

import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "../state/store";
import { parseRecipe, type RawRecipeDryRunReport } from "../state/recipe";
// Type-only imports are erased at build time, so importing them here does NOT
// pull the lazy `llm/` chunk (or the SDK) into the first-load bundle. The
// runtime engine/sampler/keyManager are reached only via `await import("../llm")`
// inside the BYOK flow's handlers below.
import type {
  AgentError,
  AgentProgress,
  CostTally,
  SampleBundle,
} from "../llm/types";
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
      file={head.file}
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
  file: File;
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

type Mode = "manual" | "byok";

function UnknownFormatForm({
  importId,
  name,
  size,
  file,
  queueLen,
  onValidate,
  onConfirm,
  onCancel,
}: FormProps) {
  const [mode, setMode] = useState<Mode>("manual");
  const [recipeText, setRecipeText] = useState("");
  const [verdict, setVerdict] = useState<Verdict>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLTextAreaElement | null>(null);

  const recipeId = useId();
  const titleId = useId();

  // When the BYOK run is mid-flight the dialog must NOT be escapable (you'd
  // orphan an in-flight upload); the flow reports that back via `lockEscape`.
  const [escapeLocked, setEscapeLocked] = useState(false);

  useEffect(() => {
    if (mode === "manual") firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !escapeLocked) onCancel(importId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importId, onCancel, busy, escapeLocked, mode]);

  const loadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setRecipeText(await f.text());
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
            decode it — or let Claude reverse-engineer one from a bounded
            sample. Recipes are saved per format, so this is a one-time step.
          </p>
        </header>

        <div className={s.modeTabs} role="tablist" aria-label="Decode method">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "manual"}
            className={s.modeTab}
            data-active={mode === "manual"}
            onClick={() => setMode("manual")}
            data-testid="unknown-format-tab-manual"
          >
            Import a recipe
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "byok"}
            className={s.modeTab}
            data-active={mode === "byok"}
            onClick={() => setMode("byok")}
            data-testid="unknown-format-tab-byok"
          >
            Decode with Claude
          </button>
        </div>

        {mode === "manual" ? (
          <>
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
          </>
        ) : (
          <ByokFlow
            importId={importId}
            name={name}
            size={size}
            file={file}
            onValidate={onValidate}
            onConfirm={onConfirm}
            onCancel={onCancel}
            onEscapeLockChange={setEscapeLocked}
            onUseManual={() => setMode("manual")}
          />
        )}
      </div>
    </div>
  );
}

// --- The BYOK (bring-your-own-key) flow --------------------------------------

type ByokStep =
  | { kind: "key" }
  | { kind: "consent"; sample: SampleBundle }
  | { kind: "run"; sample: SampleBundle }
  | { kind: "success"; report: RawRecipeDryRunReport; recipeJson: string }
  | { kind: "failed"; error: AgentError };

interface ByokProps {
  importId: string;
  name: string;
  size: number;
  file: File;
  onValidate: FormProps["onValidate"];
  onConfirm: FormProps["onConfirm"];
  onCancel: FormProps["onCancel"];
  onEscapeLockChange: (locked: boolean) => void;
  onUseManual: () => void;
}

function ByokFlow({
  importId,
  name,
  size,
  file,
  onValidate,
  onConfirm,
  onCancel,
  onEscapeLockChange,
  onUseManual,
}: ByokProps) {
  const [step, setStep] = useState<ByokStep>({ kind: "key" });
  const [apiKey, setApiKey] = useState("");
  const [persist, setPersist] = useState(false);
  const [hint, setHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const keyId = useId();
  const hintId = useId();

  // Streamed progress (newest last). Running cost tally is tracked separately
  // so the most recent cost line is always shown even after the array scrolls.
  const [events, setEvents] = useState<AgentProgress[]>([]);
  const [tally, setTally] = useState<CostTally | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Prefill the key field from the key manager (in-memory or persisted) once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { getKey, hasPersistedKey } = await import("../llm");
      if (cancelled) return;
      const existing = getKey();
      if (existing) setApiKey(existing);
      if (hasPersistedKey()) setPersist(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Lock Escape while a run is in flight (there's a hard Abort button instead).
  useEffect(() => {
    onEscapeLockChange(step.kind === "run");
    return () => onEscapeLockChange(false);
  }, [step.kind, onEscapeLockChange]);

  // Abort any in-flight run if the flow unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const goToConsent = async () => {
    setError(null);
    if (apiKey.trim().length === 0) {
      setError("Enter your Anthropic API key to continue.");
      return;
    }
    setBusy(true);
    try {
      const { setKey, buildSampleBundle } = await import("../llm");
      setKey(apiKey.trim(), { persist });
      const sample = await buildSampleBundle(file);
      setStep({ kind: "consent", sample });
    } catch (err) {
      setError(`Could not prepare the sample: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const startRun = async (sample: SampleBundle) => {
    setError(null);
    setEvents([]);
    setTally(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setStep({ kind: "run", sample });

    try {
      const { getFormatAgentEngineFactory, getKey } = await import("../llm");
      const key = getKey() ?? apiKey.trim();
      const engine = getFormatAgentEngineFactory()({ apiKey: key });

      // The engine's `validateLocally` is the store's `dryRunRecipe`, adapted to
      // throw (rather than return null) so a dequeued import surfaces as an
      // error inside the loop instead of a silent gate pass.
      const validateLocally = (recipeJson: string) =>
        onValidate(importId, recipeJson).then((r) => {
          if (!r) throw new Error("import is no longer queued");
          return r;
        });

      const result = await engine.run({
        sample,
        hint: hint.trim() || undefined,
        validateLocally,
        onProgress: (msg) => {
          setEvents((prev) => [...prev, msg]);
          if (msg.type === "cost") setTally(msg.tally);
        },
        signal: controller.signal,
      });

      // Re-run the dry-run once on the final recipe so the success screen can
      // reuse the same ValidationReport the manual path shows.
      const recipeJson = JSON.stringify(result.recipe);
      const report = await validateLocally(recipeJson);
      setStep({ kind: "success", report, recipeJson });
    } catch (err) {
      const agentErr = asAgentError(err);
      setStep({ kind: "failed", error: agentErr });
    } finally {
      abortRef.current = null;
    }
  };

  const abort = () => abortRef.current?.abort();

  const confirmSuccess = async (recipeJson: string) => {
    setBusy(true);
    try {
      await onConfirm(importId, recipeJson);
    } finally {
      setBusy(false);
    }
  };

  // --- Render per step ------------------------------------------------------

  if (step.kind === "key") {
    return (
      <div className={s.byokFlow} data-testid="byok-key-step">
        <label className={s.field} htmlFor={keyId}>
          <span className={s.label}>Anthropic API key</span>
          <input
            id={keyId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={s.keyInput}
            placeholder="sk-ant-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            data-testid="byok-key-input"
          />
        </label>
        <p className={s.byokNote}>
          Your key is sent only to <code>api.anthropic.com</code> — never to a
          Driveline server. We recommend minting a dedicated key with a low
          spend limit for this.
        </p>
        <label className={s.checkboxRow}>
          <input
            type="checkbox"
            checked={persist}
            onChange={(e) => setPersist(e.target.checked)}
            data-testid="byok-remember"
          />
          <span>
            Remember on this device.{" "}
            <strong className={s.warn}>
              Anyone with access to this browser profile can use this key.
            </strong>
          </span>
        </label>

        {error ? (
          <p className={s.errorBox} data-testid="byok-error">
            {error}
          </p>
        ) : null}

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
            onClick={goToConsent}
            disabled={busy || apiKey.trim().length === 0}
            data-testid="byok-key-continue"
          >
            {busy ? "Preparing sample…" : "Continue"}
          </button>
        </div>
      </div>
    );
  }

  if (step.kind === "consent") {
    return (
      <ConsentStep
        sample={step.sample}
        name={name}
        size={size}
        file={file}
        hint={hint}
        hintId={hintId}
        onHintChange={setHint}
        onBack={() => setStep({ kind: "key" })}
        onConsent={() => startRun(step.sample)}
      />
    );
  }

  if (step.kind === "run") {
    return <RunStep events={events} tally={tally} onAbort={abort} />;
  }

  if (step.kind === "success") {
    return (
      <div className={s.byokFlow} data-testid="byok-success">
        <p className={s.reportHead}>
          ✓ Claude derived a verified recipe for {name}.
        </p>
        <ValidationReport report={step.report} />
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
            data-confident="true"
            onClick={() => confirmSuccess(step.recipeJson)}
            disabled={busy}
            data-testid="byok-open"
          >
            {busy ? "Opening…" : "Open source"}
          </button>
        </div>
      </div>
    );
  }

  // step.kind === "failed"
  return (
    <FailureStep
      error={step.error}
      onUseManual={onUseManual}
      onRetry={() => setStep({ kind: "key" })}
      onCancel={() => onCancel(importId)}
    />
  );
}

// --- Consent step: render the EXACT sample manifest + a hex/ASCII preview ----

function ConsentStep({
  sample,
  name,
  size,
  file,
  hint,
  hintId,
  onHintChange,
  onBack,
  onConsent,
}: {
  sample: SampleBundle;
  name: string;
  size: number;
  file: File;
  hint: string;
  hintId: string;
  onHintChange: (v: string) => void;
  onBack: () => void;
  onConsent: () => void;
}) {
  const { manifest } = sample;
  const [preview, setPreview] = useState<string | null>(null);

  // Read the first 256 bytes of the head slice straight from the file (not the
  // bundle blob) for the hex/ASCII preview. Slice-only — never the whole file.
  useEffect(() => {
    let cancelled = false;
    const head =
      manifest.slices.find((sl) => sl.kind === "head") ?? manifest.slices[0];
    if (!head) {
      setPreview("");
      return;
    }
    const previewLen = Math.min(256, head.length);
    void file
      .slice(head.byteOffset, head.byteOffset + previewLen)
      .arrayBuffer()
      .then((buf) => {
        if (!cancelled)
          setPreview(hexDump(new Uint8Array(buf), head.byteOffset));
      });
    return () => {
      cancelled = true;
    };
  }, [file, manifest]);

  return (
    <div className={s.byokFlow} data-testid="byok-consent-step">
      <p className={s.byokNote}>
        Nothing is uploaded until you confirm. Claude will receive only the byte
        ranges below — a bounded sample of <strong>{name}</strong> (
        {formatBytes(size)} total). The full file never leaves your browser.
      </p>

      <div className={s.manifest} data-testid="byok-manifest">
        <p className={s.manifestSummary}>
          Uploading <strong>{formatBytes(manifest.totalSampledBytes)}</strong>{" "}
          of <strong>{formatBytes(manifest.fileSize)}</strong> in{" "}
          {manifest.slices.length} slice
          {manifest.slices.length === 1 ? "" : "s"}.
        </p>
        <table className={s.sliceTable}>
          <thead>
            <tr>
              <th>slice</th>
              <th>byte range</th>
              <th>size</th>
            </tr>
          </thead>
          <tbody>
            {manifest.slices.map((sl, i) => (
              <tr key={`${sl.byteOffset}-${i}`}>
                <td>{sl.kind}</td>
                <td className={s.mono}>
                  {sl.byteOffset.toLocaleString()}–
                  {(sl.byteOffset + sl.length).toLocaleString()}
                </td>
                <td className={s.mono}>{formatBytes(sl.length)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={s.manifestSha}>
          sha256 <span className={s.mono}>{manifest.sha256.slice(0, 16)}…</span>
        </p>
      </div>

      <div className={s.field}>
        <span className={s.label}>Head-slice preview</span>
        <pre className={s.hexPreview} data-testid="byok-hex-preview">
          {preview ?? "reading…"}
        </pre>
      </div>

      <label className={s.field} htmlFor={hintId}>
        <span className={s.label}>Hint (optional)</span>
        <textarea
          id={hintId}
          className={s.hintArea}
          spellCheck={false}
          placeholder="e.g. 100 Hz CAN-like records from our Acme DAQ, little-endian"
          value={hint}
          onChange={(e) => onHintChange(e.target.value)}
          data-testid="byok-hint"
        />
      </label>

      <div className={s.actions}>
        <button type="button" className={s.cancel} onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className={s.confirm}
          data-confident="true"
          onClick={onConsent}
          data-testid="byok-consent-run"
        >
          Upload sample &amp; decode
        </button>
      </div>
    </div>
  );
}

// --- Run step: stream progress + a hard Abort button -------------------------

function RunStep({
  events,
  tally,
  onAbort,
}: {
  events: AgentProgress[];
  tally: CostTally | null;
  onAbort: () => void;
}) {
  const logRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest line in view as the transcript grows.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div className={s.byokFlow} data-testid="byok-run-step">
      <div className={s.runHead}>
        <span className={s.spinnerDot} aria-hidden />
        <span>Claude is reverse-engineering the format…</span>
      </div>

      <div className={s.progressLog} ref={logRef} data-testid="byok-progress">
        {events.length === 0 ? (
          <p className={s.progressMuted}>Uploading sample…</p>
        ) : (
          events.map((ev, i) => <ProgressLine key={i} ev={ev} />)
        )}
      </div>

      {tally ? (
        <p className={s.costLine} data-testid="byok-cost">
          {tally.inputTokens.toLocaleString()} in /{" "}
          {tally.outputTokens.toLocaleString()} out tokens · est. $
          {tally.estimatedUsd.toFixed(2)}
        </p>
      ) : null}

      <div className={s.actions}>
        <button
          type="button"
          className={s.abort}
          onClick={onAbort}
          data-testid="byok-abort"
        >
          Abort
        </button>
      </div>
    </div>
  );
}

// All model-derived text is rendered as plain text nodes (docs/12 §6 — never as
// HTML), so a hostile file's bytes can't inject markup.
function ProgressLine({ ev }: { ev: AgentProgress }) {
  switch (ev.type) {
    case "thinking":
      return (
        <p className={s.progItem} data-kind="thinking">
          <span className={s.progTag}>thinking</span>
          {ev.text}
        </p>
      );
    case "sandbox-action":
      return (
        <p className={s.progItem} data-kind="sandbox">
          <span className={s.progTag}>sandbox</span>
          {ev.text}
        </p>
      );
    case "assistant-text":
      return (
        <p className={s.progItem} data-kind="assistant">
          {ev.text}
        </p>
      );
    case "validation-verdict": {
      const decoded = Number(ev.report.records_decoded);
      const cov = (ev.report.coverage * 100).toFixed(1);
      return (
        <p
          className={s.progItem}
          data-kind="verdict"
          data-testid="byok-verdict"
        >
          <span className={s.progTag}>attempt {ev.attempt}</span>
          {decoded.toLocaleString()} records · {cov}% coverage ·{" "}
          {Number(ev.report.records_rejected)} rejected
        </p>
      );
    }
    case "unsupported":
      return (
        <p className={s.progItem} data-kind="unsupported">
          <span className={s.progTag}>unsupported</span>
          {ev.reason}
        </p>
      );
    case "cost":
    case "done":
    case "error":
      // Cost is surfaced in the dedicated tally line; done/error transition the
      // step, so they need no log line of their own.
      return null;
  }
}

// --- Failure step (docs/12 §9): honest surface + manual fallback -------------

function FailureStep({
  error,
  onUseManual,
  onRetry,
  onCancel,
}: {
  error: AgentError;
  onUseManual: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { headline, detail, findings } = describeError(error);
  // "aborted" is a user action, not a failure — offer a clean retry path.
  const isAbort = error.kind === "aborted";
  return (
    <div className={s.byokFlow} data-testid="byok-failed">
      <p className={s.failHead} data-kind={error.kind}>
        {headline}
      </p>
      <p className={s.byokNote}>{detail}</p>
      {findings ? (
        <pre className={s.findings} data-testid="byok-findings">
          {findings}
        </pre>
      ) : null}

      {!isAbort ? (
        <p className={s.byokNote}>
          You can still import a recipe by hand, or share a colleague&rsquo;s
          recipe JSON.
        </p>
      ) : null}

      <div className={s.actions}>
        <button type="button" className={s.cancel} onClick={onCancel}>
          Cancel
        </button>
        {!isAbort ? (
          <button
            type="button"
            className={s.validate}
            onClick={onUseManual}
            data-testid="byok-use-manual"
          >
            Import a recipe instead
          </button>
        ) : null}
        <button
          type="button"
          className={s.confirm}
          onClick={onRetry}
          data-testid="byok-retry"
        >
          {isAbort ? "Restart" : "Try again"}
        </button>
      </div>
    </div>
  );
}

// --- Shared validation report ------------------------------------------------

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

// --- Helpers -----------------------------------------------------------------

/** Render a byte buffer as an offset-prefixed hex + ASCII dump (16/row). */
function hexDump(bytes: Uint8Array, baseOffset: number): string {
  const lines: string[] = [];
  for (let row = 0; row < bytes.length; row += 16) {
    const slice = bytes.subarray(row, row + 16);
    const off = (baseOffset + row).toString(16).padStart(8, "0");
    let hex = "";
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      if (i < slice.length) {
        hex += slice[i].toString(16).padStart(2, "0") + " ";
        const c = slice[i];
        ascii += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ".";
      } else {
        hex += "   ";
      }
    }
    lines.push(`${off}  ${hex} ${ascii}`);
  }
  return lines.join("\n");
}

/** Narrow an unknown thrown value to an AgentError without importing the class
 * at module top level (it lives in the lazy chunk). The engine always rejects
 * with an AgentError, so duck-type on `kind`; otherwise synthesize an `api`
 * shape so the failure UI always has something to show. */
function asAgentError(err: unknown): AgentError {
  if (
    err &&
    typeof err === "object" &&
    "kind" in err &&
    typeof (err as { kind: unknown }).kind === "string"
  ) {
    return err as AgentError;
  }
  return {
    name: "AgentError",
    kind: "api",
    message: String(err),
  } as AgentError;
}

/** Map a typed AgentError to honest human copy (docs/12 §9). */
function describeError(error: AgentError): {
  headline: string;
  detail: string;
  findings: string | null;
} {
  switch (error.kind) {
    case "aborted":
      return {
        headline: "Run cancelled",
        detail: "You stopped the analysis. The uploaded sample was deleted.",
        findings: null,
      };
    case "key-rejected":
      return {
        headline: "API key rejected",
        detail:
          "Anthropic rejected the key (401). Double-check it and try again.",
        findings: null,
      };
    case "rate-limited":
      return {
        headline: "Rate limited",
        detail:
          "Anthropic rate-limited the request (429). Wait a moment and retry.",
        findings: null,
      };
    case "refusal":
      return {
        headline: "Claude declined to analyse this file",
        detail: error.message,
        findings: null,
      };
    case "unsupported":
      return {
        headline: "Format out of recipe scope",
        detail:
          error.unsupported?.reason ??
          "Claude could not express this format as a declarative recipe.",
        findings: error.unsupported
          ? [
              error.unsupported.findings,
              error.unsupported.suggestedExport
                ? `Suggested export: ${error.unsupported.suggestedExport}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n")
          : null,
      };
    case "acceptance-gate":
      return {
        headline: "Recipe didn't pass verification",
        detail:
          "Claude proposed a recipe, but it failed the local acceptance gate against your full file — it wasn't registered.",
        findings: error.report
          ? `coverage ${(error.report.coverage * 100).toFixed(1)}% · ${Number(
              error.report.records_rejected,
            )} records rejected`
          : null,
      };
    case "iteration-cap":
      return {
        headline: "Didn't converge",
        detail:
          "Claude ran out of attempts without a verified recipe. Nothing was registered.",
        findings: error.report
          ? `best attempt: coverage ${(error.report.coverage * 100).toFixed(
              1,
            )}%`
          : null,
      };
    case "bad-base-url":
      return {
        headline: "Refused a non-Anthropic endpoint",
        detail: error.message,
        findings: null,
      };
    case "api":
    default:
      return {
        headline: "The analysis failed",
        detail: error.message,
        findings: null,
      };
  }
}
