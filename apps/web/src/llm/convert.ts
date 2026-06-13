/**
 * Sandbox-conversion escape hatch (docs/12 §10, Phase 4 / v1.5).
 *
 * For formats outside the recipe DSL (the `report_unsupported` outcome), the
 * user can still view *this one file*: the agent converts the uploaded SAMPLE
 * (default) — or, behind an explicit extra consent + under the Files cap, the
 * full file — to MCAP inside the Anthropic code-execution sandbox; the browser
 * downloads the produced file via the Files API and ingests it through the
 * EXISTING `McapReader`. The result is a one-shot "converted copy"; it is never
 * registered in the format registry.
 *
 * Like the engine, the ONE real SDK call site is isolated behind the injected
 * `createClient` adapter so the whole conversion + ingestion wiring is testable
 * against a fake that returns canned MCAP bytes (no network, no key). The
 * `setSampleConverterFactory` seam mirrors `engineFactory.ts` so the e2e can
 * install a deterministic fake.
 */

import type { SampleBundle } from "./types";

/** Input to a conversion run. */
export interface ConvertInput {
  /** The bounded sample bundle the user consented to (sampler output). */
  sample: SampleBundle;
  /**
   * Convert the FULL file instead of just the sample. Requires the explicit
   * extra consent checkbox in the dialog and stays under the Files cap. The
   * caller passes the original `File`; the converter uploads it whole.
   */
  fullFile?: File;
  /** Optional user hint, forwarded to the model. */
  hint?: string;
  signal: AbortSignal;
}

/** Output: the produced MCAP bytes ready to ingest through `openFiles`. */
export interface ConvertResult {
  /** MCAP file bytes (downloaded from the Files API). */
  mcapBytes: Uint8Array;
}

/** The escape-hatch converter the dialog drives. */
export interface SampleConverter {
  convertToMcap(input: ConvertInput): Promise<ConvertResult>;
}

export interface ConverterConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export type SampleConverterFactory = (
  config: ConverterConfig,
) => SampleConverter;

// The real converter is intentionally NOT exercised by unit tests (it needs a
// live key); the UI/ingestion path is tested against a fake. The default
// factory is isolated here, consistent with `defaultCreateClient` in engine.ts.
const defaultFactory: SampleConverterFactory = (config) => ({
  async convertToMcap() {
    // The live SDK conversion call (Files upload → code_execution that emits
    // /mnt/outputs/converted.mcap → Files download) is deferred to a verified
    // implementation; with BYOK there is no way to run it in CI without a key,
    // so it is isolated in this one place (docs/12 §10, §11). Until wired, the
    // UI surfaces this as an honest "not available without a key" error.
    void config;
    throw new Error(
      "Sandbox conversion is not available in this build. Install a converter via setSampleConverterFactory (tests) or run with a verified live engine.",
    );
  },
});

let activeFactory: SampleConverterFactory = defaultFactory;

/** Replace the converter factory (tests/e2e inject a fake returning canned MCAP). */
export function setSampleConverterFactory(
  factory: SampleConverterFactory,
): void {
  activeFactory = factory;
}

/** Restore the default (real-SDK) converter factory. */
export function resetSampleConverterFactory(): void {
  activeFactory = defaultFactory;
}

/** The factory the dialog uses to build a converter for a run. */
export function getSampleConverterFactory(): SampleConverterFactory {
  return activeFactory;
}
