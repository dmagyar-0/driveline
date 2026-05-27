// VideoPanelEmptyState — issues #22, #32, #33.
//
// First-impression UX for the video panel. The previous empty state
// was a single sentence of plain text ("Drop an MCAP file or mp4 +
// sidecar...") which left the panel looking dead and hid the
// product's hero claim (everything runs in the browser, no upload).
//
// This component replaces it with:
//   - a simple line-art icon so the panel has a visual centre
//   - a short headline that names the surface
//   - the original instruction as supporting copy
//   - format-supported badges (MCAP / MF4 / MP4 + sidecar)
//   - a "Try sample data" CTA that fetches the in-repo `short.*`
//     fixtures from the dev server's `/sample-data/` route and calls
//     the existing `openFiles` store action. The button surfaces a
//     loading state for the entire ingestion path (#33).
//
// We deliberately render this as a "blank-canvas" surface rather than
// a busy form: the user hasn't picked a channel yet, so we don't want
// the picker chrome competing with the call to action. When channels
// *are* available, `VideoPanelContainer` swaps in a small picker
// below — see that module for the routing logic.

import { useEffect, useState } from "react";
import { useSession } from "../state/store";
import styles from "./VideoPanelEmptyState.module.css";

interface VideoPanelEmptyStateProps {
  /** Render variant. Bare `"primary"` is the centred hero; `"compact"`
   *  is for cases where the picker is also visible and we want the
   *  empty-state explainer to step back. */
  variant?: "primary" | "compact";
  /** Optional override copy for the headline (used by the
   *  "no longer available" branch). */
  headline?: string;
  /** Optional override copy for the supporting paragraph. */
  description?: string;
}

// Fetch and `openFiles` the in-repo sample corpus. Pulls the small
// `short.mcap` + `short.mp4` + `short.mp4.timestamps` set from
// `/sample-data/*` (served by the dev server via the
// `driveline-sample-data` Vite middleware). The bundled production
// build serves the same path through the static asset handler so this
// works in dev *and* in a deployed instance, as long as `sample-data/`
// is shipped.
async function loadSampleData(): Promise<void> {
  const names = ["short.mcap", "short.mp4", "short.mp4.timestamps"];
  const files: File[] = [];
  for (const name of names) {
    const resp = await fetch(`/sample-data/${name}`);
    if (!resp.ok) {
      throw new Error(`fetch /sample-data/${name}: ${resp.status}`);
    }
    const blob = await resp.blob();
    files.push(new File([blob], name));
  }
  await useSession.getState().openFiles(files);
}

export function VideoPanelEmptyState({
  variant = "primary",
  headline,
  description,
}: VideoPanelEmptyStateProps) {
  // Ingestion in flight — disable the CTA and swap the label so the
  // user doesn't fire a second drop on top of the first. Reading via
  // a selector is cheap; `ingesting` flips at most twice per drop.
  const ingesting = useSession((s) => s.ingesting);
  const [error, setError] = useState<string | null>(null);
  // Local "we kicked off a sample load" flag so we can show a spinner
  // on the button itself even before the store flips `ingesting`.
  const [loadingSample, setLoadingSample] = useState(false);

  useEffect(() => {
    if (!ingesting) setLoadingSample(false);
  }, [ingesting]);

  const onTrySample = async () => {
    setError(null);
    setLoadingSample(true);
    try {
      await loadSampleData();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load sample data",
      );
      setLoadingSample(false);
    }
  };

  const isLoading = ingesting || loadingSample;
  const wrapperClass =
    variant === "compact"
      ? `${styles.empty} ${styles.compact}`
      : styles.empty;

  return (
    <div
      className={wrapperClass}
      data-testid="video-panel-empty-state"
      role="region"
      aria-label="Video panel empty state"
    >
      <div className={styles.icon} aria-hidden="true">
        {/* Simple line-art "frame + play" mark. Stays restrained on
         *  purpose — Driveline is a tool, not a marketing page. */}
        <svg
          viewBox="0 0 64 48"
          width="64"
          height="48"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="6" width="58" height="36" rx="3" />
          <path d="M3 14 L61 14" opacity="0.4" />
          <circle cx="9" cy="10" r="0.9" fill="currentColor" />
          <circle cx="13" cy="10" r="0.9" fill="currentColor" />
          <path d="M26 21 L42 30 L26 39 Z" />
        </svg>
      </div>

      <h2 className={styles.headline}>
        {headline ?? "Drop a recording"}
      </h2>
      {/* Iter 4 issue #5 — the previous two-sentence description was
       *  too talky for a drop-zone. Headline now names the action
       *  ("Drop a recording"), the sub-line names accepted formats in
       *  one beat, and the privacy-claim that used to lead the
       *  paragraph drops to a smaller footnote below the CTA. */}
      <p className={styles.description}>
        {description ?? "MP4 with sidecar, or an MCAP with H.264 video."}
      </p>

      <ul className={styles.formats} aria-label="Supported formats">
        <li className={styles.format}>MCAP</li>
        <li className={styles.format}>MF4</li>
        <li className={styles.format}>MP4 + sidecar</li>
      </ul>

      <div className={styles.cta}>
        <button
          type="button"
          className={styles.tryButton}
          onClick={onTrySample}
          disabled={isLoading}
          data-testid="video-panel-try-sample"
          aria-busy={isLoading}
        >
          {isLoading ? (
            <>
              <span className={styles.spinner} aria-hidden="true" />
              <span>Loading sample…</span>
            </>
          ) : (
            <>Try sample data</>
          )}
        </button>
      </div>

      {/* Privacy footnote — deliberately small + de-emphasised so it
       *  doesn't fight the CTA for attention. Same load-target hint
       *  that used to be the ctaHint now folds in here too. */}
      <p className={styles.footnote}>
        Decoded locally in your browser. No uploads.
      </p>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
