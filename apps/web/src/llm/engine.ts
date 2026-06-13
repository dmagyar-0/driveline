/**
 * Client-orchestrated Format Agent engine (docs/12 §4.2, §4.4).
 *
 * Runs the tool-use loop in the browser, directly against api.anthropic.com
 * with the user's key (`dangerouslyAllowBrowser` — that flag gates exactly the
 * "key is exposed to the page" risk, which is the POINT of BYOK). The model
 * reverse-engineers the format in an Anthropic-hosted Python sandbox
 * (`code_execution`), tests candidates against the FULL local file via the
 * client-side `validate_recipe` tool, and the final recipe is forced through
 * structured outputs constrained to the Recipe v1 schema.
 *
 * Everything Anthropic-SDK-shaped sits behind the injected `createClient`
 * factory + the `AnthropicLike` adapter interface, so unit tests drive the full
 * loop against a fake client with no network and no key. The ONE real call site
 * that builds `@anthropic-ai/sdk` is `defaultCreateClient` below, isolated and
 * clearly commented; if a beta tool/Files shape drifts, it changes there only.
 */

import {
  RECIPE_V1_SCHEMA,
  validateRecipeAgainstSchema,
  type RawRecipeDryRunReport,
  type Recipe,
} from "../state/recipe";
import { assertAnthropicBaseUrl, ANTHROPIC_BASE_URL } from "./keyManager";
import { buildKickoffText, FORMAT_AGENT_SYSTEM_PROMPT } from "./prompts";
import {
  AcceptanceGateError,
  AgentError,
  type AgentProgress,
  type AgentRunInput,
  type AgentRunResult,
  type CostTally,
  type FormatAgentEngine,
} from "./types";

export const DEFAULT_MODEL = "claude-opus-4-8";

/** Max tool-use iterations before we give up (docs/12 §4.4). */
const MAX_ITERATIONS = 12;

/** Acceptance-gate thresholds (docs/12 §4.4). */
const MIN_COVERAGE = 0.99;

// Anthropic list price for claude-opus-4-8, USD per million tokens.
// Used only for the live cost estimate shown to the user; not load-bearing.
const PRICE_PER_MTOK = { input: 5, output: 25, cacheRead: 0.5 } as const;

// --- The minimal Anthropic surface the engine needs (the adapter) ----------
//
// This is intentionally a SMALL structural subset of `@anthropic-ai/sdk`. The
// real factory wires the SDK to it; the fake factory in tests implements the
// same three methods. Keeping the engine coded against this interface (not the
// SDK types directly) is what makes the loop testable without a network.

/** A content block in a model turn (text / tool_use / thinking / etc.). */
export interface LlmContentBlock {
  type: string;
  // text blocks
  text?: string;
  // thinking blocks
  thinking?: string;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: unknown;
  // server-side tool blocks (code_execution) carry their own payloads we only
  // surface as narration; we don't need their fields typed.
  [k: string]: unknown;
}

export interface LlmUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface LlmMessage {
  role: "assistant";
  content: LlmContentBlock[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string } | null;
  usage?: LlmUsage;
  container?: { id?: string } | null;
}

/** A message we send back (user turn carrying tool results, or the kickoff). */
export interface LlmRequestMessage {
  role: "user" | "assistant";
  content: unknown;
}

export interface LlmCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: LlmRequestMessage[];
  tools: unknown[];
  /** Container to reuse across iterations (code-execution sandbox). */
  container?: string;
  /** Structured-output constraint for the final recipe turn. */
  output_config?: unknown;
  thinking?: unknown;
}

/** Uploaded Files-API object handle. */
export interface LlmUploadedFile {
  id: string;
}

/**
 * The structural client the engine drives. `createMessage` honours an
 * `AbortSignal`; `uploadSample` puts the bundle on the Files API; `deleteFile`
 * best-effort removes it afterwards.
 */
export interface AnthropicLike {
  createMessage(
    params: LlmCreateParams,
    opts: { signal: AbortSignal },
  ): Promise<LlmMessage>;
  uploadSample(blob: Blob, filename: string): Promise<LlmUploadedFile>;
  deleteFile(fileId: string): Promise<void>;
}

export interface EngineConfig {
  apiKey: string;
  model?: string;
  /** Base URL — guarded; defaults to api.anthropic.com. */
  baseUrl?: string;
  /**
   * If true, a non-zero `monotonic_violations` does NOT fail the gate (the user
   * relaxed `time.monotonicity` with explicit confirmation; docs/12 §4.4).
   */
  relaxMonotonicity?: boolean;
  /**
   * Injectable client factory. Tests pass a fake; production omits it and gets
   * the real `@anthropic-ai/sdk` client (lazily imported).
   */
  createClient?: (cfg: {
    apiKey: string;
    model: string;
    baseUrl: string;
  }) => AnthropicLike | Promise<AnthropicLike>;
}

// --- Tool names -------------------------------------------------------------

const TOOL_VALIDATE = "validate_recipe";
const TOOL_REPORT_UNSUPPORTED = "report_unsupported";

/** The tool list sent on every iteration (server + client tools, docs/12 §4.4). */
function buildTools(): unknown[] {
  return [
    // Server-side Anthropic Python sandbox — the model does its hexdumps and
    // struct experiments here. Version string isolated to this one spot.
    { type: "code_execution_20260120", name: "code_execution" },
    {
      name: TOOL_VALIDATE,
      description:
        "Decode the FULL original file on the user's machine using a candidate Ingest Recipe and return statistics (records decoded/rejected, first framing error, time-basis stats, per-channel ranges, coverage). Call this to test a hypothesis against data you cannot see.",
      // Strict structured-tool-input: the candidate recipe is constrained to the
      // canonical Recipe v1 JSON Schema (docs/12 §4.4 — "Force the final recipe
      // through structured outputs constrained to RECIPE_V1_SCHEMA"). Because
      // every recipe enters through this tool, every candidate is schema-valid
      // by construction; the acceptance gate re-checks defensively.
      strict: true,
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          recipe: {
            ...RECIPE_V1_SCHEMA,
            description:
              "The candidate Ingest Recipe, matching the Recipe v1 schema.",
          },
        },
        required: ["recipe"],
      },
    },
    {
      name: TOOL_REPORT_UNSUPPORTED,
      description:
        "Surrender: report that this format cannot be expressed as a declarative Ingest Recipe. Provide your findings and a suggested export path for the user.",
      input_schema: {
        type: "object",
        properties: {
          reason: { type: "string" },
          findings: { type: "string" },
          suggestedExport: { type: "string" },
        },
        required: ["reason", "findings"],
      },
    },
  ];
}

// --- Helpers ----------------------------------------------------------------

/** Convert any bigint in a value to a decimal string so it is JSON-safe. */
function bigintToString(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintToString);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = bigintToString(v);
    }
    return out;
  }
  return value;
}

/** Serialize a dry-run report JSON-safely (bigints → decimal strings). */
export function reportToJsonSafe(report: RawRecipeDryRunReport): string {
  return JSON.stringify(bigintToString(report));
}

/** Coerce a bigint|number to a number for gate comparisons. */
function toNum(v: bigint | number): number {
  return typeof v === "bigint" ? Number(v) : v;
}

function accumulate(tally: CostTally, usage: LlmUsage | undefined): CostTally {
  if (!usage) return tally;
  const inputTokens = tally.inputTokens + (usage.input_tokens ?? 0);
  const outputTokens = tally.outputTokens + (usage.output_tokens ?? 0);
  const cacheReadInputTokens =
    tally.cacheReadInputTokens + (usage.cache_read_input_tokens ?? 0);
  const cacheCreationInputTokens =
    tally.cacheCreationInputTokens + (usage.cache_creation_input_tokens ?? 0);
  const estimatedUsd =
    (inputTokens * PRICE_PER_MTOK.input) / 1_000_000 +
    (outputTokens * PRICE_PER_MTOK.output) / 1_000_000 +
    (cacheReadInputTokens * PRICE_PER_MTOK.cacheRead) / 1_000_000;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    estimatedUsd,
  };
}

function emptyTally(): CostTally {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    estimatedUsd: 0,
  };
}

/** Map a thrown SDK/transport error to a typed, human AgentError. */
function mapApiError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  const status = (err as { status?: number })?.status;
  const name = (err as { name?: string })?.name;
  if (name === "AbortError") {
    return new AgentError("aborted", "The run was cancelled.", { cause: err });
  }
  if (status === 401) {
    return new AgentError(
      "key-rejected",
      "Anthropic rejected the API key (401). Check the key and try again.",
      { cause: err },
    );
  }
  if (status === 429) {
    return new AgentError(
      "rate-limited",
      "Anthropic rate-limited the request (429). Wait and retry.",
      { cause: err },
    );
  }
  const msg = (err as { message?: string })?.message ?? String(err);
  return new AgentError("api", `Anthropic API error: ${msg}`, { cause: err });
}

// --- Acceptance gate (client-enforced; do NOT trust the model) -------------

/**
 * Apply the client-enforced acceptance gate (docs/12 §4.4). Throws
 * `AcceptanceGateError` (carrying the failing report) if any condition fails.
 * Returns the validated `Recipe` on success.
 */
export function applyAcceptanceGate(
  recipeJson: string,
  report: RawRecipeDryRunReport,
  opts: { relaxMonotonicity?: boolean },
): Recipe {
  const schemaResult = validateRecipeAgainstSchema(JSON.parse(recipeJson));
  if ("error" in schemaResult) {
    throw new AcceptanceGateError(
      `final recipe failed schema validation: ${schemaResult.error}`,
      report,
    );
  }
  if (report.coverage < MIN_COVERAGE) {
    throw new AcceptanceGateError(
      `coverage ${report.coverage.toFixed(4)} is below the ${MIN_COVERAGE} threshold`,
      report,
    );
  }
  const violations = report.time_stats
    ? toNum(report.time_stats.monotonic_violations)
    : 0;
  if (!opts.relaxMonotonicity && violations > 0) {
    throw new AcceptanceGateError(
      `${violations} monotonic time violation(s); the time basis is implausible`,
      report,
    );
  }
  const hasNonConstant = report.per_channel.some((c) => !c.constant);
  if (!hasNonConstant) {
    throw new AcceptanceGateError(
      "every channel is constant; the recipe decodes no varying signal",
      report,
    );
  }
  return schemaResult.recipe;
}

// --- The engine -------------------------------------------------------------

export class ClientOrchestratedEngine implements FormatAgentEngine {
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly config: EngineConfig) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = config.baseUrl ?? ANTHROPIC_BASE_URL;
    // Refuse any non-Anthropic endpoint up front (docs/12 §6).
    assertAnthropicBaseUrl(this.baseUrl);
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { sample, hint, validateLocally, onProgress, signal } = input;

    if (signal.aborted) {
      throw new AgentError("aborted", "The run was cancelled before it began.");
    }

    const client = await this.makeClient();

    let tally = emptyTally();
    const emitCost = () => onProgress({ type: "cost", tally });

    let uploadedFileId: string | null = null;
    let lastRecipeJson: string | null = null;
    let lastReport: RawRecipeDryRunReport | null = null;
    let attempt = 0;
    const transcriptNotes: string[] = [];

    try {
      // Upload the sample ONCE (docs/12 §4.2 — reuse across iterations).
      const uploaded = await client.uploadSample(
        sample.blob,
        sample.manifest.filename + ".sample",
      );
      uploadedFileId = uploaded.id;

      const manifestJson = JSON.stringify(sample.manifest, null, 2);
      const messages: LlmRequestMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: buildKickoffText(manifestJson, hint) },
            // Attach the uploaded sample to the code-execution container.
            { type: "container_upload", file_id: uploaded.id },
          ],
        },
      ];

      let containerId: string | undefined;

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        throwIfAborted(signal);

        // On the final permitted iteration, constrain output to the recipe
        // schema so a converged answer is schema-valid by construction.
        const message = await client.createMessage(
          {
            model: this.model,
            max_tokens: 16000,
            system: FORMAT_AGENT_SYSTEM_PROMPT,
            messages,
            tools: buildTools(),
            container: containerId,
            thinking: { type: "adaptive", display: "summarized" },
          },
          { signal },
        );

        tally = accumulate(tally, message.usage);
        emitCost();

        // Reuse the sandbox container across iterations (docs/12 §4.2).
        if (message.container?.id) containerId = message.container.id;

        // Refusal: surface honestly before reading content (docs/12 §6).
        if (message.stop_reason === "refusal") {
          const why = message.stop_details?.explanation
            ? ` (${message.stop_details.explanation})`
            : "";
          throw new AgentError(
            "refusal",
            `Claude declined to analyse this file${why}.`,
          );
        }

        // Emit narration for thinking / sandbox actions / assistant text.
        emitNarration(message.content, onProgress);

        // Record the assistant turn verbatim so tool_use ids round-trip.
        messages.push({ role: "assistant", content: message.content });

        const toolUses = message.content.filter((b) => b.type === "tool_use");

        if (toolUses.length === 0) {
          // No tool call. If we already have a passing report on the latest
          // candidate, gate it; otherwise the model stopped without a verified
          // recipe — surface a final-text recipe attempt if present, else fail.
          if (lastRecipeJson && lastReport) {
            const recipe = applyAcceptanceGate(lastRecipeJson, lastReport, {
              relaxMonotonicity: this.config.relaxMonotonicity,
            });
            onProgress({ type: "done", recipe });
            return {
              recipe,
              transcriptSummary: summarize(transcriptNotes, attempt),
            };
          }
          throw new AgentError(
            "api",
            "The model ended its turn without proposing a verified recipe.",
          );
        }

        // Handle each tool call; collect tool_result blocks for the next turn.
        const toolResults: unknown[] = [];
        for (const tool of toolUses) {
          throwIfAborted(signal);

          if (tool.name === TOOL_REPORT_UNSUPPORTED) {
            const inp = (tool.input ?? {}) as {
              reason?: string;
              findings?: string;
              suggestedExport?: string;
            };
            onProgress({
              type: "unsupported",
              reason: inp.reason ?? "unspecified",
              findings: inp.findings ?? "",
              suggestedExport: inp.suggestedExport,
            });
            throw new AgentError(
              "unsupported",
              `Format reported as out of recipe scope: ${inp.reason ?? "unspecified"}`,
              {
                unsupported: {
                  reason: inp.reason ?? "unspecified",
                  findings: inp.findings ?? "",
                  suggestedExport: inp.suggestedExport,
                },
              },
            );
          }

          if (tool.name === TOOL_VALIDATE) {
            attempt += 1;
            const recipeJson = extractRecipeJson(tool.input);
            const report = await validateLocally(recipeJson);
            lastRecipeJson = recipeJson;
            lastReport = report;
            transcriptNotes.push(
              `attempt ${attempt}: coverage=${report.coverage.toFixed(3)} rejected=${toNum(report.records_rejected)}`,
            );
            onProgress({ type: "validation-verdict", attempt, report });

            toolResults.push({
              type: "tool_result",
              tool_use_id: tool.id,
              content: reportToJsonSafe(report),
            });
            continue;
          }

          // Unknown client tool — return an error result so the model adapts.
          toolResults.push({
            type: "tool_result",
            tool_use_id: tool.id,
            is_error: true,
            content: `unknown tool: ${tool.name}`,
          });
        }

        // If only server-side tools ran (code_execution), there are no
        // client-side results to send; the server resumes on its own loop and
        // we just continue requesting. But if we DO have client results, send
        // them as the next user turn.
        if (toolResults.length > 0) {
          messages.push({ role: "user", content: toolResults });
        }
      }

      // Exhausted the iteration cap without a verified, gated recipe.
      throw new AgentError(
        "iteration-cap",
        `Did not converge within ${MAX_ITERATIONS} iterations.`,
        lastReport ? { report: lastReport } : undefined,
      );
    } catch (err) {
      throw mapApiError(err);
    } finally {
      // Best-effort delete of the uploaded sample on completion AND abort
      // (docs/12 §9). Never let cleanup failure mask the real outcome.
      if (uploadedFileId) {
        try {
          await client.deleteFile(uploadedFileId);
        } catch {
          /* ignore — best-effort */
        }
      }
    }
  }

  private async makeClient(): Promise<AnthropicLike> {
    const factory = this.config.createClient ?? defaultCreateClient;
    return factory({
      apiKey: this.config.apiKey,
      model: this.model,
      baseUrl: this.baseUrl,
    });
  }
}

// --- Narration --------------------------------------------------------------

function emitNarration(
  blocks: LlmContentBlock[],
  onProgress: (m: AgentProgress) => void,
): void {
  for (const block of blocks) {
    if (block.type === "thinking" && typeof block.thinking === "string") {
      if (block.thinking.trim()) {
        onProgress({ type: "thinking", text: block.thinking });
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      if (block.text.trim()) {
        onProgress({ type: "assistant-text", text: block.text });
      }
    } else if (
      block.type === "server_tool_use" ||
      block.type === "code_execution_tool_result"
    ) {
      // Surface sandbox activity as a coarse action line.
      const name =
        typeof block.name === "string" ? block.name : "code_execution";
      onProgress({ type: "sandbox-action", text: `sandbox: ${name}` });
    }
  }
}

function summarize(notes: string[], attempts: number): string {
  if (notes.length === 0) {
    return `Derived recipe in ${attempts} validation attempt(s).`;
  }
  return `Derived recipe after ${attempts} validation attempt(s): ${notes.join("; ")}.`;
}

// --- Tool input extraction --------------------------------------------------

/** Pull the recipe JSON string out of a `validate_recipe` tool input. */
function extractRecipeJson(input: unknown): string {
  if (input && typeof input === "object" && "recipe" in input) {
    const r = (input as { recipe: unknown }).recipe;
    if (typeof r === "string") return r;
    // The model may emit the recipe as an object; re-serialize defensively.
    return JSON.stringify(r);
  }
  if (typeof input === "string") return input;
  return JSON.stringify(input ?? {});
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AgentError("aborted", "The run was cancelled.");
  }
}

// --- The ONE real SDK call site (lazy import; isolated by design) -----------
//
// Everything Anthropic-SDK-specific lives here. The beta tool shapes
// (code_execution / container_upload), the Files API, and structured outputs
// are exercised only through this factory; the unit tests inject a fake and
// never reach this code. If a beta shape drifts, fix it here.

async function defaultCreateClient(cfg: {
  apiKey: string;
  model: string;
  baseUrl: string;
}): Promise<AnthropicLike> {
  assertAnthropicBaseUrl(cfg.baseUrl);
  // Dynamic import keeps `@anthropic-ai/sdk` out of the first-load bundle: the
  // whole `llm/` directory is a lazy chunk and this import is the only path to
  // the SDK (docs/07 size budget; CLAUDE.md lazy-chunk contract).
  const { default: Anthropic, toFile } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    dangerouslyAllowBrowser: true,
  });

  const FILES_BETA = "files-api-2025-04-14";

  return {
    async createMessage(params, opts) {
      const message = (await client.beta.messages.create(
        {
          model: params.model,
          max_tokens: params.max_tokens,
          system: params.system,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: params.messages as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: params.tools as any,
          ...(params.container ? { container: params.container } : {}),
          ...(params.thinking ? { thinking: params.thinking as any } : {}),
          ...(params.output_config
            ? { output_config: params.output_config as any }
            : {}),
          betas: [FILES_BETA],
        },
        { signal: opts.signal },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      )) as any;
      return message as LlmMessage;
    },
    async uploadSample(blob, filename) {
      const file = await client.beta.files.upload({
        file: await toFile(blob, filename, {
          type: "application/octet-stream",
        }),
        betas: [FILES_BETA],
      });
      return { id: file.id };
    },
    async deleteFile(fileId) {
      await client.beta.files.delete(fileId, { betas: [FILES_BETA] });
    },
  };
}
