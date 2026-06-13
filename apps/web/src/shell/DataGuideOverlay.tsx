// "What can Driveline load?" overlay — an opt-in reference you open from the
// top bar when you're curious, not part of the main workflow. A full-window
// scrim with two tabs: the data formats the core can read (with a concrete
// example for the non-obvious ones) and the agent / API-key surfaces.
//
// Pure chrome, no store reads — modelled on ShortcutsOverlay. Open state is
// owned by the TopBar. Click the scrim, press Close, or hit Escape to dismiss.

import { useEffect, useId, useState } from "react";
import { AGENT_API_VERSION } from "../agent/agentApi";
import { FORMATS, AGENTS } from "./dataGuide";
import type { FormatEntry, AgentEntry } from "./dataGuide";
import styles from "./DataGuideOverlay.module.css";

export interface DataGuideOverlayProps {
  onClose: () => void;
}

type Tab = "formats" | "agents";

export function DataGuideOverlay({ onClose }: DataGuideOverlayProps) {
  const [tab, setTab] = useState<Tab>("formats");
  const titleId = useId();
  const formatsTabId = useId();
  const agentsTabId = useId();
  const panelId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
      data-testid="data-guide-overlay"
    >
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            What can Driveline load?
          </h2>
          <p className={styles.lede}>
            The formats the viewer reads in the browser, and how agents or your
            own API key can feed and drive it.
          </p>
        </header>

        <div className={styles.tabs} role="tablist" aria-label="Guide sections">
          <button
            type="button"
            role="tab"
            id={formatsTabId}
            aria-selected={tab === "formats"}
            aria-controls={panelId}
            className={styles.tab}
            data-active={tab === "formats" ? "true" : "false"}
            onClick={() => setTab("formats")}
            data-testid="data-guide-tab-formats"
          >
            Data formats
          </button>
          <button
            type="button"
            role="tab"
            id={agentsTabId}
            aria-selected={tab === "agents"}
            aria-controls={panelId}
            className={styles.tab}
            data-active={tab === "agents" ? "true" : "false"}
            onClick={() => setTab("agents")}
            data-testid="data-guide-tab-agents"
          >
            Agents &amp; API key
          </button>
        </div>

        <div
          className={styles.body}
          role="tabpanel"
          id={panelId}
          aria-labelledby={tab === "formats" ? formatsTabId : agentsTabId}
        >
          {tab === "formats" ? (
            <ul className={styles.list}>
              {FORMATS.map((f) => (
                <FormatRow key={f.name} entry={f} />
              ))}
            </ul>
          ) : (
            <>
              <p className={styles.apiVersion}>
                Agent surface version{" "}
                <code className={styles.code}>{AGENT_API_VERSION}</code> — call{" "}
                <code className={styles.code}>
                  window.__drivelineAgent.getSkill()
                </code>{" "}
                in the console for the live guide.
              </p>
              <ul className={styles.list}>
                {AGENTS.map((a) => (
                  <AgentRow key={a.name} entry={a} />
                ))}
              </ul>
            </>
          )}
        </div>

        <footer className={styles.foot}>
          <button
            type="button"
            className={styles.dismiss}
            onClick={onClose}
            data-testid="data-guide-close"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

function FormatRow({ entry }: { entry: FormatEntry }) {
  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.name}>{entry.name}</span>
        <span className={styles.exts}>
          {entry.exts.map((e) => (
            <code key={e} className={styles.ext}>
              {e}
            </code>
          ))}
        </span>
      </div>
      <p className={styles.blurb}>{entry.blurb}</p>
      {entry.note && <p className={styles.note}>{entry.note}</p>}
      {entry.example && <pre className={styles.example}>{entry.example}</pre>}
    </li>
  );
}

function AgentRow({ entry }: { entry: AgentEntry }) {
  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.name}>{entry.name}</span>
      </div>
      <p className={styles.blurb}>{entry.blurb}</p>
      {entry.note && <p className={styles.note}>{entry.note}</p>}
      {entry.example && <pre className={styles.example}>{entry.example}</pre>}
    </li>
  );
}
