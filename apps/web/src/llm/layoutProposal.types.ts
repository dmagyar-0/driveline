/**
 * `LayoutProposal` — the structured output of the visualisation-bootstrap
 * (docs/12-format-agent.md §7). A proposal places freshly-opened channels onto
 * panels; it is DATA, not code — it can only reference channel ids that exist
 * (post-validated client-side) and is capped per panel.
 *
 * This is a CHEAP, SDK-free module: the type and the heuristic floor
 * (`layoutHeuristics.ts`) may be imported eagerly by the Apply UI without a key.
 * Anything that pulls `@anthropic-ai/sdk` (the LLM `requestLayoutProposal` call)
 * stays behind a dynamic `import("../llm/...")` — see `llm/README.md`.
 *
 * The single source of truth for the SHAPE is the JSON Schema at
 * `docs/schemas/layoutProposal.v1.schema.json` (byte-identical web copy at
 * `apps/web/src/llm/layoutProposal.v1.schema.json`); the contract test in
 * `apps/web/src/tests/layoutProposalSchema.contract.test.ts` holds the two in
 * lock-step and proves this interface matches.
 */

/** A signal plot of up to `MAX_PLOT_SERIES` scalar channels. */
export interface PlotPanelProposal {
  kind: "plot";
  title: string;
  channelIds: string[];
  /** Optional grouping of `channelIds` onto shared y-axes (channels that share
   * a unit / range). Each inner array is a subset of `channelIds`. */
  yAxisGroups?: string[][];
}

/** A Leaflet map driven by a latitude/longitude channel pair. */
export interface MapPanelProposal {
  kind: "map";
  latChannelId: string;
  lonChannelId: string;
}

/** An enum lane of discrete-state channels. */
export interface EnumPanelProposal {
  kind: "enum";
  channelIds: string[];
}

/** A tabular value readout of channels. */
export interface TablePanelProposal {
  kind: "table";
  channelIds: string[];
}

/** A single-value readout of channels at the cursor. */
export interface ValuePanelProposal {
  kind: "value";
  channelIds: string[];
}

export type PanelProposal =
  | PlotPanelProposal
  | MapPanelProposal
  | EnumPanelProposal
  | TablePanelProposal
  | ValuePanelProposal;

export interface LayoutProposal {
  panels: PanelProposal[];
  /** A short human-readable explanation, shown to the user as PLAIN TEXT
   * (untrusted model output — never rendered as HTML; docs/12 §6). */
  rationale: string;
}

/**
 * The minimal per-channel facts the heuristics + the LLM call reason over: the
 * channel manifest plus the dry-run stats (min/max/constant). No raw data.
 */
export interface ProposalChannel {
  id: string;
  name: string;
  kind: string;
  dtype: string | null;
  unit: string | null;
  sampleCount: number;
}

/** Per-channel stats from the dry-run report, keyed by channel id. */
export interface ProposalChannelStat {
  min: number;
  max: number;
  constant: boolean;
}
