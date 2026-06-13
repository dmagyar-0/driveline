/**
 * Format Agent engine — shared types (Phase 2, docs/12 §4).
 *
 * PURE LOGIC. This module (and everything else under `apps/web/src/llm/`) is a
 * lazily-imported chunk: nothing in the app imports from `llm/` at module top
 * level, so the Anthropic SDK and this engine never land in the first-load
 * bundle (docs/07 size budget). The UI layer dynamic-`import()`s it behind the
 * "Decode with Claude" CTA. See `llm/README.md` for the lazy-chunk contract.
 *
 * The engine takes a `validateLocally` callback (the store's `dryRunRecipe`
 * adapter) rather than importing the store/worker — that keeps this directory
 * free of app-state coupling and trivially unit-testable with a mocked client.
 */

import type { RawRecipeDryRunReport, Recipe } from "../state/recipe";

// --- The sample bundle the engine uploads (built by `sampler.ts`) -----------

/** One contiguous slice of the original file, by absolute byte offset. The
 * model needs the absolute offset to reason about where in the real file a
 * candidate framing lands. */
export interface SampleSlice {
  /** Human-readable provenance, e.g. "head" | "tail" | "stratified". */
  kind: "head" | "tail" | "stratified";
  /** Absolute byte offset into the ORIGINAL file where this slice begins. */
  byteOffset: number;
  /** Length of this slice in bytes. */
  length: number;
  /** Offset of this slice WITHIN the concatenated bundle blob. */
  bundleOffset: number;
}

/** JSON manifest describing the bundle — uploaded alongside the binary blob so
 * the model knows exactly which byte ranges it received. Rendered verbatim in
 * the consent dialog (the later UI subagent) before anything is sent. */
export interface SampleManifest {
  filename: string;
  /** Exact size of the ORIGINAL file in bytes. */
  fileSize: number;
  /** sha256 of the concatenated bundle blob, hex. Provenance + Files dedup. */
  sha256: string;
  slices: SampleSlice[];
  /** Total bytes across all slices (= bundle blob length). */
  totalSampledBytes: number;
}

/** What the sampler produces and the engine uploads once. */
export interface SampleBundle {
  manifest: SampleManifest;
  /** The concatenated slice bytes, in manifest order. */
  blob: Blob;
}

// --- Progress events streamed to the UI during a run (docs/12 §4.5) ---------

/** Running token/cost tally, accumulated from each API turn's `usage`. */
export interface CostTally {
  inputTokens: number;
  outputTokens: number;
  /** Cache reads, when reported. */
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Best-effort USD estimate at the configured model's list price. */
  estimatedUsd: number;
}

/**
 * Discriminated union of everything the dialog renders during a run. The UI
 * subagent owns presentation; the engine just emits these.
 */
export type AgentProgress =
  /** A summarized thinking block from the model. */
  | { type: "thinking"; text: string }
  /** A sandbox / code-execution action the model took. */
  | { type: "sandbox-action"; text: string }
  /** Free-form assistant narration text (non-thinking). */
  | { type: "assistant-text"; text: string }
  /** The model proposed a recipe; we dry-ran it against the full local file. */
  | {
      type: "validation-verdict";
      /** 1-based attempt index within this run. */
      attempt: number;
      report: RawRecipeDryRunReport;
    }
  /** Running cost/usage update. */
  | { type: "cost"; tally: CostTally }
  /** The model surrendered via `report_unsupported`. */
  | {
      type: "unsupported";
      reason: string;
      findings: string;
      suggestedExport?: string;
    }
  /** Terminal: a verified recipe passed the client-enforced acceptance gate. */
  | { type: "done"; recipe: Recipe }
  /** Terminal: the run failed. `error` carries the typed failure. */
  | { type: "error"; error: AgentError };

// --- Engine input / output --------------------------------------------------

export interface AgentRunInput {
  sample: SampleBundle;
  /** Optional free-text user hint ("100 Hz CAN-like records from our DAQ"). */
  hint?: string;
  /** Runs `recipe_dry_run` (WASM) over the FULL local file. Injected by the UI
   * layer so the engine never touches the store/worker directly. */
  validateLocally: (recipeJson: string) => Promise<RawRecipeDryRunReport>;
  onProgress: (msg: AgentProgress) => void;
  signal: AbortSignal;
}

export interface AgentRunResult {
  recipe: Recipe;
  /** A short human summary of the derivation transcript (for provenance/UI). */
  transcriptSummary: string;
}

export interface FormatAgentEngine {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

// --- Typed errors -----------------------------------------------------------

export type AgentErrorKind =
  | "aborted" // user hit the abort button (AbortSignal)
  | "refusal" // stop_reason: "refusal" (docs/12 §6 Refusals)
  | "key-rejected" // 401
  | "rate-limited" // 429
  | "iteration-cap" // hit the 12-iteration ceiling without converging
  | "acceptance-gate" // final recipe failed the client-enforced gate
  | "unsupported" // model called report_unsupported
  | "bad-base-url" // engine refused a non-api.anthropic.com base URL
  | "api"; // any other SDK / transport error

export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  /** When `kind === "acceptance-gate"`, the failing dry-run report. */
  readonly report?: RawRecipeDryRunReport;
  /** When `kind === "unsupported"`, the structured surrender. */
  readonly unsupported?: {
    reason: string;
    findings: string;
    suggestedExport?: string;
  };

  constructor(
    kind: AgentErrorKind,
    message: string,
    opts?: {
      report?: RawRecipeDryRunReport;
      unsupported?: AgentError["unsupported"];
      cause?: unknown;
    },
  ) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = "AgentError";
    this.kind = kind;
    this.report = opts?.report;
    this.unsupported = opts?.unsupported;
  }
}

/** Thrown when the final recipe fails the client-enforced acceptance gate
 * (docs/12 §4.4). Carries the failing report so the UI can explain why. */
export class AcceptanceGateError extends AgentError {
  constructor(message: string, report: RawRecipeDryRunReport | undefined) {
    super("acceptance-gate", message, { report });
    this.name = "AcceptanceGateError";
  }
}
