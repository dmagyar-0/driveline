// Layout-proposal dialog — the visualisation bootstrap's Apply UI
// (docs/12-format-agent.md §7, the journey's final "Layout proposal … [Apply]
// [Skip]" step).
//
// After a recipe source opens (`confirmRecipeImport` sets
// `pendingLayoutProposal`), this dialog proposes a panel layout for the
// freshly-opened source's channels and lets the user apply it:
//   - The HEURISTIC floor (`proposeLayoutHeuristic`) is shown IMMEDIATELY — no
//     API key, no network (lat/lon → map, enum-kind → enum lane, scalars →
//     capped plots).
//   - "Refine with Claude" runs ONE structured-output call
//     (`requestLayoutProposal`, lazily imported with the SDK) using the stored
//     BYOK key to improve grouping / naming. The returned proposal is
//     post-validated against the real channel list (docs/12 §6).
//   - Apply places the CHECKED panels through the EXISTING `__drivelineAgent` v2
//     write ops (`applyLayoutProposal` → createPanel/bindChannels/setMapBinding).
//
// Store-driven and self-contained (mirrors `UnknownFormatDialog`): no props,
// reads the one Zustand store via selectors. Mounted once in `Shell`. All
// model-derived text (rationale, titles) is rendered as PLAIN TEXT NODES
// (docs/12 §6 — never HTML), since it is untrusted output.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSession, type Channel } from "../state/store";
import { Dialog } from "./Dialog";
import { proposeLayoutHeuristic } from "../llm/layoutHeuristics";
import { applyLayoutPanels } from "../llm/applyLayoutProposal";
import type {
  LayoutProposal,
  PanelProposal,
  ProposalChannel,
} from "../llm/layoutProposal.types";
import s from "./LayoutProposalDialog.module.css";

export function LayoutProposalDialog() {
  const pending = useSession((st) => st.pendingLayoutProposal);
  const dismiss = useSession((st) => st.dismissLayoutProposal);
  const sources = useSession((st) => st.sources);

  if (!pending) return null;
  const source = sources.find((src) => src.id === pending.sourceId);
  // The source vanished (e.g. cleared) — nothing to propose.
  if (!source) return null;

  return (
    <LayoutProposalForm
      key={source.id}
      sourceName={source.name}
      channels={source.channels}
      onDismiss={dismiss}
    />
  );
}

interface FormProps {
  sourceName: string;
  channels: Channel[];
  onDismiss: () => void;
}

/** Project a store `Channel` to the SDK-free `ProposalChannel` the heuristics /
 * LLM call consume. */
function toProposalChannel(c: Channel): ProposalChannel {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    dtype: c.dtype,
    unit: c.unit,
    sampleCount: c.sampleCount,
  };
}

/** Human label for a proposed panel's contents. */
function panelSummary(
  panel: PanelProposal,
  names: Map<string, string>,
): string {
  const nameOf = (id: string) => names.get(id) ?? id;
  switch (panel.kind) {
    case "map":
      return `Map · ${nameOf(panel.latChannelId)} / ${nameOf(panel.lonChannelId)}`;
    case "plot":
      return `Plot "${panel.title}" · ${panel.channelIds.length} series`;
    case "enum":
      return `Enum lane · ${panel.channelIds.length} channel${
        panel.channelIds.length === 1 ? "" : "s"
      }`;
    case "table":
      return `Table · ${panel.channelIds.length} channel${
        panel.channelIds.length === 1 ? "" : "s"
      }`;
    case "value":
      return `Value · ${panel.channelIds.length} channel${
        panel.channelIds.length === 1 ? "" : "s"
      }`;
  }
}

type RefineState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error"; message: string };

function LayoutProposalForm({ sourceName, channels, onDismiss }: FormProps) {
  const proposalChannels = useMemo(
    () => channels.map(toProposalChannel),
    [channels],
  );
  const names = useMemo(
    () => new Map(channels.map((c) => [c.id, c.name] as const)),
    [channels],
  );

  // The heuristic floor — computed eagerly, no key. Becomes the initial
  // proposal; "Refine with Claude" replaces it with the LLM's version.
  const heuristic = useMemo(
    () => proposeLayoutHeuristic(proposalChannels),
    [proposalChannels],
  );

  const [proposal, setProposal] = useState<LayoutProposal>(heuristic);
  const [refinedBy, setRefinedBy] = useState<"heuristic" | "claude">(
    "heuristic",
  );
  // Per-panel checkbox state, indexed by panel position. Reset whenever the
  // proposal changes (refine replaces it).
  const [checked, setChecked] = useState<boolean[]>(() =>
    heuristic.panels.map(() => true),
  );
  const [refine, setRefine] = useState<RefineState>({ kind: "idle" });
  const [applied, setApplied] = useState<{
    applied: number;
    failed: number;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const titleId = useId();
  // Initial focus lands on the Skip button (mirroring the prior behaviour);
  // Escape is suppressed while a refine is in flight (the BYOK run lock).
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Abort any in-flight refine when the dialog unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const setProposalFrom = (
    next: LayoutProposal,
    by: "heuristic" | "claude",
  ) => {
    setProposal(next);
    setRefinedBy(by);
    setChecked(next.panels.map(() => true));
    setApplied(null);
  };

  const refineWithClaude = async () => {
    setRefine({ kind: "running" });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // Lazy-import the LLM chunk (pulls the SDK) only when the user asks. Go
      // through the factory seam so the deterministic e2e can inject a fake.
      const [{ runLayoutProposal }, { getKey }] = await Promise.all([
        import("../llm/layoutProposalFactory"),
        import("../llm/keyManager"),
      ]);
      const apiKey = getKey();
      if (!apiKey) {
        setRefine({
          kind: "error",
          message:
            "No Anthropic API key is set. Decode a format with Claude first, or paste a key, to enable refinement.",
        });
        return;
      }
      const next = await runLayoutProposal({
        channels: proposalChannels,
        apiKey,
        signal: controller.signal,
      });
      setProposalFrom(next, "claude");
      setRefine({ kind: "idle" });
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setRefine({ kind: "error", message });
    } finally {
      abortRef.current = null;
    }
  };

  const apply = () => {
    const panels = proposal.panels.filter((_, i) => checked[i]);
    const result = applyLayoutPanels(panels);
    setApplied({ applied: result.applied, failed: result.failed });
    // Leave the success line visible briefly, then dismiss so the user sees
    // their new panels.
    onDismiss();
  };

  const anyChecked = checked.some(Boolean);
  const busy = refine.kind === "running";

  return (
    <Dialog
      onClose={onDismiss}
      escapeEnabled={refine.kind !== "running"}
      ariaLabelledBy={titleId}
      initialFocusRef={closeRef}
      data-testid="layout-proposal-dialog"
    >
      <div className={s.card} onClick={(e) => e.stopPropagation()}>
        <header className={s.header}>
          <h2 id={titleId} className={s.title}>
            Suggested layout
          </h2>
          <p className={s.subtitle} data-testid="layout-proposal-source">
            {sourceName} · {channels.length} channel
            {channels.length === 1 ? "" : "s"}
          </p>
        </header>

        <p
          className={s.rationale}
          data-testid="layout-proposal-rationale"
          data-by={refinedBy}
        >
          {proposal.rationale}
        </p>

        {proposal.panels.length === 0 ? (
          <p className={s.empty}>No panels to propose for this source.</p>
        ) : (
          <ul className={s.panelList} data-testid="layout-proposal-panels">
            {proposal.panels.map((panel, i) => (
              <li key={i} className={s.panelRow}>
                <label className={s.panelLabel}>
                  <input
                    type="checkbox"
                    checked={checked[i] ?? false}
                    onChange={(e) =>
                      setChecked((prev) => {
                        const next = [...prev];
                        next[i] = e.target.checked;
                        return next;
                      })
                    }
                    disabled={busy}
                    data-testid={`layout-proposal-check-${i}`}
                  />
                  <span>{panelSummary(panel, names)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {refine.kind === "error" ? (
          <p className={s.errorBox} data-testid="layout-proposal-error">
            {refine.message}
          </p>
        ) : null}

        {applied ? (
          <p className={s.appliedLine} data-testid="layout-proposal-applied">
            Applied {applied.applied} panel
            {applied.applied === 1 ? "" : "s"}
            {applied.failed > 0 ? ` · ${applied.failed} skipped` : ""}.
          </p>
        ) : null}

        <div className={s.actions}>
          <button
            type="button"
            ref={closeRef}
            className={s.skip}
            onClick={onDismiss}
            disabled={busy}
            data-testid="layout-proposal-skip"
          >
            Skip
          </button>
          <button
            type="button"
            className={s.refine}
            onClick={refineWithClaude}
            disabled={busy || proposalChannels.length === 0}
            data-testid="layout-proposal-refine"
          >
            {busy ? "Refining…" : "Refine with Claude"}
          </button>
          <button
            type="button"
            className={s.apply}
            onClick={apply}
            disabled={busy || !anyChecked || proposal.panels.length === 0}
            data-testid="layout-proposal-apply"
          >
            Apply
          </button>
        </div>
      </div>
    </Dialog>
  );
}
