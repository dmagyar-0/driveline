/**
 * Client-injection seam for the layout-proposal LLM call (docs/12 §7,
 * deterministic e2e). Mirrors `engineFactory.ts`.
 *
 * The Apply UI never builds the Anthropic client directly: it calls
 * `runLayoutProposal`, which threads the active `createClient` factory into
 * `requestLayoutProposal`. By default that factory is undefined, so the call
 * uses the real lazy `@anthropic-ai/sdk` client. Tests swap in a fake via
 * `setLayoutProposalClientFactory`, so the whole refine flow can be driven with
 * NO network and NO key. The override is module state INSIDE the lazy chunk, so
 * it adds nothing to the first-load bundle.
 */

import {
  requestLayoutProposal,
  type CreateMessagesClient,
  type RequestLayoutProposalInput,
} from "./layoutProposal";

let activeFactory: CreateMessagesClient | undefined;

/** Replace the messages-client factory (tests inject a fake). */
export function setLayoutProposalClientFactory(
  factory: CreateMessagesClient,
): void {
  activeFactory = factory;
}

/** Restore the default (real-SDK) client factory. */
export function resetLayoutProposalClientFactory(): void {
  activeFactory = undefined;
}

/**
 * Run a layout-proposal request through the active client factory. The UI calls
 * this rather than `requestLayoutProposal` directly so the e2e seam applies.
 */
export function runLayoutProposal(
  input: Omit<RequestLayoutProposalInput, "createClient">,
) {
  return requestLayoutProposal({ ...input, createClient: activeFactory });
}
