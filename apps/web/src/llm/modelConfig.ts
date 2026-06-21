/**
 * Single source of truth for the Anthropic model id + list price the LLM layer
 * defaults to. The engine (`engine.ts`), the layout-proposal call
 * (`layoutProposal.ts`), and the cost estimate all read from here so the
 * default model and its price can never drift apart (finding #11).
 *
 * This module is part of the lazy `llm/` chunk — no first-load cost.
 */

/** The default Anthropic model for every LLM call (engine + layout proposal). */
export const DEFAULT_MODEL = "claude-opus-4-8";

/**
 * Anthropic list price for `DEFAULT_MODEL`, USD per million tokens. Used only
 * for the live cost estimate shown to the user; not load-bearing. Cache reads
 * bill at ~0.1x input (see docs/12 / the claude-api pricing table).
 */
export const PRICE_PER_MTOK = { input: 5, output: 25, cacheRead: 0.5 } as const;
