/**
 * LLM layout-proposal call (docs/12-format-agent.md §7 — the visualisation
 * bootstrap's "Refine with Claude" step).
 *
 * This is NOT an agent loop. It is ONE `claude-opus-4-8` Messages call with the
 * output constrained to the `LayoutProposal` JSON Schema. Input is the channel
 * manifest (names/kinds/dtypes/units/sampleCounts) + per-channel min/max/constant
 * + the user's hint — NO raw data. The heuristic floor (`layoutHeuristics.ts`)
 * runs first with no key; this call only improves grouping/naming.
 *
 * Everything Anthropic-SDK-shaped sits behind the injected `createClient`
 * factory + the `MessagesClient` adapter, so unit tests drive it against a fake
 * client with no network and no key. The ONE real call site that builds
 * `@anthropic-ai/sdk` is `defaultCreateClient` below; this whole module lives in
 * the lazy `llm/` chunk, so the SDK never lands in the first-load bundle.
 *
 * SAFETY (docs/12 §6): the returned proposal is model-authored, hence untrusted.
 * `sanitizeProposal` post-validates it against the REAL channel list and the
 * per-panel caps, dropping/clamping anything invalid before it can reach the
 * applier. A refusal / API error surfaces as a typed `AgentError`.
 */

import type Anthropic from "@anthropic-ai/sdk";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { ANTHROPIC_BASE_URL, assertAnthropicBaseUrl } from "./keyManager";
import { DEFAULT_MODEL } from "./modelConfig";
import {
  buildAnthropicClient,
  mapApiError as mapAnthropicError,
} from "./anthropicClient";
import { AgentError } from "./types";
import { MAX_PLOT_SERIES } from "../panels/palette";
import layoutProposalSchema from "./layoutProposal.v1.schema.json";
import { sanitizeProposal } from "./layoutSanitize";
import type {
  LayoutProposal,
  ProposalChannel,
  ProposalChannelStat,
} from "./layoutProposal.types";

// Re-exported from its new home (`layoutSanitize.ts`) so the public surface of
// this module is unchanged for existing importers (WAL-05 refactor).
export { sanitizeProposal };

/** The default model for the layout-proposal call — shared with the engine via
 *  `modelConfig.ts` so the two cannot drift (finding #11). */
export const DEFAULT_LAYOUT_MODEL = DEFAULT_MODEL;

/** The committed Layout Proposal v1 JSON Schema (byte-identical to the docs
 * copy; held in lock-step by the contract test). Exported so callers can feed
 * it to other validators or inspect the structured-output constraint. */
export const LAYOUT_PROPOSAL_V1_SCHEMA = layoutProposalSchema;

let compiledValidator: ValidateFunction | null = null;
function validator(): ValidateFunction {
  if (!compiledValidator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    compiledValidator = ajv.compile(layoutProposalSchema);
  }
  return compiledValidator;
}

/** Validate an unknown value against the Layout Proposal schema. Returns the
 * typed proposal or a human error string (NOT yet checked against the real
 * channel list — that is `sanitizeProposal`). */
export function validateProposalAgainstSchema(
  value: unknown,
): { proposal: LayoutProposal } | { error: string } {
  const validate = validator();
  if (validate(value)) {
    return { proposal: value as LayoutProposal };
  }
  const first = validate.errors?.[0];
  const where = first?.instancePath || "(root)";
  return {
    error: `layout proposal failed schema validation at ${where}: ${
      first?.message ?? "unknown error"
    }`,
  };
}

// --- The minimal Anthropic surface this call needs (the adapter) ------------
//
// This call only reads `text` blocks off the response, so the block type is a
// tight subset (finding #4 — no `[k: string]: unknown` index signature; the
// shared, richer block type lives in `anthropicClient.ts`).

export interface LayoutContentBlock {
  type: string;
  text?: string;
}

export interface LayoutMessage {
  role: "assistant";
  content: LayoutContentBlock[];
  stop_reason?: string | null;
  stop_details?: { explanation?: string } | null;
}

export interface LayoutCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
  /** Structured-output constraint (the LayoutProposal schema). */
  output_config: unknown;
}

/** The structural client the call drives. A single `createMessage`. */
export interface MessagesClient {
  createMessage(
    params: LayoutCreateParams,
    opts: { signal: AbortSignal },
  ): Promise<LayoutMessage>;
}

export type CreateMessagesClient = (cfg: {
  apiKey: string;
  model: string;
  baseUrl: string;
}) => MessagesClient | Promise<MessagesClient>;

export interface RequestLayoutProposalInput {
  channels: ProposalChannel[];
  /** Per-channel stats keyed by channel id (min/max/constant). */
  stats?: Record<string, ProposalChannelStat>;
  hint?: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Injectable client factory; tests pass a fake, production omits it. */
  createClient?: CreateMessagesClient;
  signal: AbortSignal;
}

const SYSTEM_PROMPT = `You are a data-visualisation assistant for Driveline, a multimodal log viewer.
Given a manifest of channels (names, kinds, dtypes, units, sample counts) plus per-channel min/max/constant statistics and an optional user hint, propose a clear panel layout.

Guidelines:
- A latitude/longitude pair (names containing "lat" and "lon"/"lng", values in plausible degree ranges) belongs on ONE map panel.
- Discrete-state ("enum"-kind) channels belong together on an enum lane.
- Group related scalar channels onto plot panels by their meaning (e.g. shared name prefix or unit). Each plot holds at most ${MAX_PLOT_SERIES} series; split larger groups across panels and give each a short human title.
- Prefer fewer, well-organised panels over one panel per channel.
- You may ONLY reference channel ids that appear in the manifest. Never invent ids.
- Respond ONLY with a LayoutProposal matching the provided JSON schema, including a short plain-text rationale.`;

/** Build the user-message manifest text from the channel list + stats + hint. */
export function buildProposalPrompt(
  channels: ProposalChannel[],
  stats?: Record<string, ProposalChannelStat>,
  hint?: string,
): string {
  const lines = channels.map((c) => {
    const st = stats?.[c.id];
    const range = st
      ? `, min=${st.min}, max=${st.max}, constant=${st.constant}`
      : "";
    return `- id="${c.id}" name="${c.name}" kind=${c.kind} dtype=${
      c.dtype ?? "?"
    } unit=${c.unit ?? "?"} samples=${c.sampleCount}${range}`;
  });
  const hintLine = hint?.trim() ? `\n\nUser hint: ${hint.trim()}` : "";
  return `Channels (${channels.length}):\n${lines.join("\n")}${hintLine}`;
}

/**
 * Request a layout proposal from Claude. Resolves a `LayoutProposal` already
 * SANITIZED against the real channel list + per-panel caps. Rejects with a typed
 * `AgentError` on refusal / abort / API error / unparseable output.
 */
export async function requestLayoutProposal(
  input: RequestLayoutProposalInput,
): Promise<LayoutProposal> {
  const { channels, stats, hint, apiKey, signal } = input;
  const model = input.model ?? DEFAULT_LAYOUT_MODEL;
  const baseUrl = input.baseUrl ?? ANTHROPIC_BASE_URL;
  assertAnthropicBaseUrl(baseUrl);

  if (signal.aborted) {
    throw new AgentError("aborted", "The proposal request was cancelled.");
  }

  const factory = input.createClient ?? defaultCreateClient;
  const client = await factory({ apiKey, model, baseUrl });

  let message: LayoutMessage;
  try {
    message = await client.createMessage(
      {
        model,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: buildProposalPrompt(channels, stats, hint) },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: layoutProposalSchema,
          },
        },
      },
      { signal },
    );
  } catch (err) {
    throw mapApiError(err);
  }

  if (message.stop_reason === "refusal") {
    const why = message.stop_details?.explanation
      ? ` (${message.stop_details.explanation})`
      : "";
    throw new AgentError(
      "refusal",
      `Claude declined to propose a layout${why}.`,
    );
  }

  const text = message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
  if (!text) {
    throw new AgentError("api", "The model returned no layout proposal.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentError(
      "api",
      "The model's layout proposal was not valid JSON.",
    );
  }

  const schemaResult = validateProposalAgainstSchema(parsed);
  if ("error" in schemaResult) {
    throw new AgentError("api", schemaResult.error);
  }

  // Post-validate against the REAL channels + caps (docs/12 §6) — the schema
  // only checks shape, not that ids exist or that caps hold.
  return sanitizeProposal(schemaResult.proposal, channels);
}

// --- Error mapping (shared with engine.ts via anthropicClient.mapApiError) ---

// Wording preserved verbatim from when this lived here; only the abort / 401 /
// 429 copy differs from the engine's, so it is injected.
function mapApiError(err: unknown): AgentError {
  return mapAnthropicError(err, {
    aborted: "The proposal request was cancelled.",
    keyRejected: "Anthropic rejected the API key (401).",
    rateLimited: "Anthropic rate-limited the request (429).",
  });
}

// --- The ONE real SDK call site (lazy import; isolated by design) -----------
//
// The SDK client is built by the shared `buildAnthropicClient`; the layout call
// only needs a single structured-output `messages.create`.

async function defaultCreateClient(cfg: {
  apiKey: string;
  model: string;
  baseUrl: string;
}): Promise<MessagesClient> {
  const { client } = await buildAnthropicClient(cfg);
  return {
    async createMessage(params, opts) {
      const body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
        model: params.model,
        max_tokens: params.max_tokens,
        system: params.system,
        messages:
          params.messages as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming["messages"],
        output_config: params.output_config as Anthropic.Beta.BetaOutputConfig,
      };
      const message = await client.beta.messages.create(body, {
        signal: opts.signal,
      });
      return message as unknown as LayoutMessage;
    },
  };
}
