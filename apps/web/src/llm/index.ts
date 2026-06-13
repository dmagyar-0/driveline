/**
 * Barrel for the Format Agent engine. The UI layer reaches everything here
 * through a single dynamic `import("../llm")` behind the "Decode with Claude"
 * CTA — that dynamic import is the chunk boundary that keeps the Anthropic SDK
 * out of the first-load bundle (see ./README.md, the lazy-chunk contract).
 *
 * DO NOT static-`import` this module (or anything under `llm/`) from any
 * always-loaded code (App, store, panels, workers). Doing so folds the SDK into
 * the entry chunk and blows the docs/07 size budget.
 */

export type {
  AgentErrorKind,
  AgentProgress,
  AgentRunInput,
  AgentRunResult,
  CostTally,
  FormatAgentEngine,
  SampleBundle,
  SampleManifest,
  SampleSlice,
} from "./types";
export { AcceptanceGateError, AgentError } from "./types";

export { buildSampleBundle, planSlices, type SamplerOptions } from "./sampler";

export {
  ANTHROPIC_BASE_URL,
  assertAnthropicBaseUrl,
  clearKey,
  getKey,
  hasPersistedKey,
  setKey,
} from "./keyManager";

export { FORMAT_AGENT_SYSTEM_PROMPT, buildKickoffText } from "./prompts";

export {
  ClientOrchestratedEngine,
  DEFAULT_MODEL,
  applyAcceptanceGate,
  reportToJsonSafe,
  type AnthropicLike,
  type EngineConfig,
} from "./engine";

export {
  getFormatAgentEngineFactory,
  resetFormatAgentEngineFactory,
  setFormatAgentEngineFactory,
  type FormatAgentEngineFactory,
} from "./engineFactory";

export {
  getSampleConverterFactory,
  resetSampleConverterFactory,
  setSampleConverterFactory,
  type ConvertInput,
  type ConvertResult,
  type ConverterConfig,
  type SampleConverter,
  type SampleConverterFactory,
} from "./convert";

export { proposeLayoutHeuristic, MAX_PLOT_SERIES } from "./layoutHeuristics";

export {
  requestLayoutProposal,
  sanitizeProposal,
  validateProposalAgainstSchema,
  buildProposalPrompt,
  DEFAULT_LAYOUT_MODEL,
  LAYOUT_PROPOSAL_V1_SCHEMA,
  type CreateMessagesClient,
  type MessagesClient,
  type RequestLayoutProposalInput,
} from "./layoutProposal";

export {
  runLayoutProposal,
  setLayoutProposalClientFactory,
  resetLayoutProposalClientFactory,
} from "./layoutProposalFactory";

export {
  applyLayoutProposal,
  applyLayoutPanels,
  type ApplyResult,
  type LayoutAgent,
} from "./applyLayoutProposal";

export type {
  LayoutProposal,
  PanelProposal,
  PlotPanelProposal,
  MapPanelProposal,
  EnumPanelProposal,
  TablePanelProposal,
  ValuePanelProposal,
  ProposalChannel,
  ProposalChannelStat,
} from "./layoutProposal.types";
