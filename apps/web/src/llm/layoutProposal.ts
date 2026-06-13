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

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { ANTHROPIC_BASE_URL, assertAnthropicBaseUrl } from "./keyManager";
import { AgentError } from "./types";
import { MAX_PLOT_SERIES } from "../panels/palette";
import layoutProposalSchema from "./layoutProposal.v1.schema.json";
import type {
  LayoutProposal,
  PanelProposal,
  ProposalChannel,
  ProposalChannelStat,
} from "./layoutProposal.types";

export const DEFAULT_LAYOUT_MODEL = "claude-opus-4-8";

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

export interface LayoutContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
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

/**
 * Sanitize a model-authored proposal against the real channel list + per-panel
 * caps (docs/12 §6). Drops unknown channel ids, de-duplicates, clamps plot
 * panels to `MAX_PLOT_SERIES`, drops panels left empty / incomplete, and drops a
 * map panel whose lat or lon id is unknown. Pure and total.
 */
export function sanitizeProposal(
  proposal: LayoutProposal,
  channels: ProposalChannel[],
): LayoutProposal {
  const known = new Set(channels.map((c) => c.id));
  const cleanList = (ids: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
      if (known.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  };

  const panels: PanelProposal[] = [];
  for (const panel of proposal.panels) {
    switch (panel.kind) {
      case "map": {
        if (
          known.has(panel.latChannelId) &&
          known.has(panel.lonChannelId) &&
          panel.latChannelId !== panel.lonChannelId
        ) {
          panels.push(panel);
        }
        break;
      }
      case "plot": {
        const ids = cleanList(panel.channelIds).slice(0, MAX_PLOT_SERIES);
        if (ids.length === 0) break;
        const groups = panel.yAxisGroups
          ?.map((g) => cleanList(g).filter((id) => ids.includes(id)))
          .filter((g) => g.length > 0);
        panels.push({
          kind: "plot",
          title: panel.title,
          channelIds: ids,
          ...(groups && groups.length > 0 ? { yAxisGroups: groups } : {}),
        });
        break;
      }
      case "enum":
      case "table":
      case "value": {
        const ids = cleanList(panel.channelIds);
        if (ids.length === 0) break;
        panels.push({ kind: panel.kind, channelIds: ids });
        break;
      }
    }
  }

  return { panels, rationale: proposal.rationale };
}

// --- Error mapping (mirrors engine.ts) --------------------------------------

function mapApiError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  const status = (err as { status?: number })?.status;
  const name = (err as { name?: string })?.name;
  if (name === "AbortError") {
    return new AgentError("aborted", "The proposal request was cancelled.", {
      cause: err,
    });
  }
  if (status === 401) {
    return new AgentError(
      "key-rejected",
      "Anthropic rejected the API key (401).",
      { cause: err },
    );
  }
  if (status === 429) {
    return new AgentError(
      "rate-limited",
      "Anthropic rate-limited the request (429).",
      { cause: err },
    );
  }
  const msg = (err as { message?: string })?.message ?? String(err);
  return new AgentError("api", `Anthropic API error: ${msg}`, { cause: err });
}

// --- The ONE real SDK call site (lazy import; isolated by design) -----------

async function defaultCreateClient(cfg: {
  apiKey: string;
  model: string;
  baseUrl: string;
}): Promise<MessagesClient> {
  assertAnthropicBaseUrl(cfg.baseUrl);
  // Dynamic import keeps `@anthropic-ai/sdk` out of the first-load bundle: the
  // whole `llm/` directory is a lazy chunk and this is the only path to the SDK
  // for the layout call (docs/07 size budget; CLAUDE.md lazy-chunk contract).
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    dangerouslyAllowBrowser: true,
  });
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
          output_config: params.output_config as any,
        },
        { signal: opts.signal },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      )) as any;
      return message as LayoutMessage;
    },
  };
}
