/**
 * Shared Anthropic SDK adapter for the LLM layer.
 *
 * The Format Agent engine (`engine.ts`) and the layout-proposal call
 * (`layoutProposal.ts`) both drive `@anthropic-ai/sdk` through a small
 * structural adapter so the loop/call is testable against a fake with no
 * network and no key. They used to each hand-roll near-identical content-block /
 * message types, their own lazy `defaultCreateClient`, and a byte-similar
 * `mapApiError`. This module is the ONE shared home for all of that (finding
 * #2): the Anthropic content-block/message types, one `mapApiError`, and a
 * `buildAnthropicClient` builder that owns the single lazy `import(...)` of the
 * SDK.
 *
 * This adapter is **Anthropic-only by deliberate policy** (finding #3):
 * `keyManager.assertAnthropicBaseUrl` hard-rejects any non-Anthropic origin,
 * and the request shapes carry Anthropic-specific fields (`betas`, `container`,
 * `code_execution`, `cache_creation_input_tokens`). The names here say
 * `Anthropic*` on purpose — this is not a provider-agnostic seam, and should
 * not be generalised into one.
 *
 * Lazy-chunk contract: the whole `llm/` directory is a lazy chunk and the
 * `import("@anthropic-ai/sdk")` inside `buildAnthropicClient` is the only path
 * to the SDK, so it never lands in the first-load bundle (docs/07 size budget;
 * CLAUDE.md lazy-chunk contract).
 */

import type Anthropic from "@anthropic-ai/sdk";
import { assertAnthropicBaseUrl } from "./keyManager";
import { AgentError } from "./types";

// --- The shared structural Anthropic surface --------------------------------
//
// A deliberately SMALL subset of `@anthropic-ai/sdk`. The real builder wires the
// SDK to it; the fakes in tests implement the same methods. Coding the callers
// against these types (not the SDK types directly) is what keeps the loop/call
// testable without a network.

/**
 * A content block in a model turn (text / tool_use / thinking / server-tool /
 * etc.). Only the fields the callers actually read are typed (finding #4 — no
 * `[k: string]: unknown` index signature, so discriminated narrowing on `type`
 * works). Server-side tool blocks (`code_execution`) carry extra payloads we
 * only surface as coarse narration; we never read those fields.
 */
export interface AnthropicContentBlock {
  type: string;
  /** text blocks */
  text?: string;
  /** thinking blocks */
  thinking?: string;
  /** tool_use blocks */
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicMessage {
  role: "assistant";
  content: AnthropicContentBlock[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string } | null;
  usage?: AnthropicUsage;
  container?: { id?: string } | null;
}

/** A message we send back (a user turn carrying tool results, or the kickoff). */
export interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: unknown;
}

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: AnthropicRequestMessage[];
  tools?: unknown[];
  /** Container to reuse across iterations (code-execution sandbox). */
  container?: string;
  /** Structured-output constraint (e.g. the final recipe / layout schema). */
  output_config?: unknown;
  thinking?: unknown;
}

/** Uploaded Files-API object handle. */
export interface AnthropicUploadedFile {
  id: string;
}

/**
 * Map a thrown SDK/transport error to a typed, human `AgentError`. Shared by
 * the engine and the layout call (finding #2). The two callers differ only in
 * the user-facing copy for abort / 401 / 429, so those strings are injected via
 * `messages` — runtime behaviour and the exact wording each caller emits are
 * preserved.
 */
export function mapApiError(
  err: unknown,
  messages: { aborted: string; keyRejected: string; rateLimited: string },
): AgentError {
  if (err instanceof AgentError) return err;
  const status = (err as { status?: number })?.status;
  const name = (err as { name?: string })?.name;
  if (name === "AbortError") {
    return new AgentError("aborted", messages.aborted, { cause: err });
  }
  if (status === 401) {
    return new AgentError("key-rejected", messages.keyRejected, { cause: err });
  }
  if (status === 429) {
    return new AgentError("rate-limited", messages.rateLimited, { cause: err });
  }
  const msg = (err as { message?: string })?.message ?? String(err);
  return new AgentError("api", `Anthropic API error: ${msg}`, { cause: err });
}

// --- The ONE real SDK construction site (lazy import; isolated by design) ----

/** What the SDK client exposes once built — the `beta.messages.create` callable
 *  plus the beta Files API the engine uses. Built once per run. */
export interface AnthropicSdk {
  client: Anthropic;
  toFile: typeof import("@anthropic-ai/sdk").toFile;
}

/**
 * Lazily build the real `@anthropic-ai/sdk` client for `cfg`. Guards the base
 * URL up front (`assertAnthropicBaseUrl`) and enables `dangerouslyAllowBrowser`
 * — that flag gates exactly the "key is exposed to the page" risk, which is the
 * POINT of BYOK. Everything Anthropic-SDK-specific (beta tool shapes, the Files
 * API, structured outputs) is exercised only through the returned client; the
 * unit tests inject a fake and never reach this code.
 */
export async function buildAnthropicClient(cfg: {
  apiKey: string;
  baseUrl: string;
}): Promise<AnthropicSdk> {
  assertAnthropicBaseUrl(cfg.baseUrl);
  const { default: AnthropicCtor, toFile } = await import("@anthropic-ai/sdk");
  const client = new AnthropicCtor({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    dangerouslyAllowBrowser: true,
  });
  return { client, toFile };
}
