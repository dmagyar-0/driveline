// VideoPanelEmptyState — single, unified empty-state surface (iter5 #5).
//
// Before iter5 there were two diverging empty-state designs for the
// same panel state ("no video channel bound"):
//   • the "no candidates" variant: a rich panel with format chips and
//     a single orange "Try sample data" CTA — no obvious drop
//     affordance.
//   • the "candidates exist" variant: a compact explainer above a
//     picker list — drop hint visible, but the explainer text and the
//     primary CTA changed entirely.
//
// iter5 consolidates them into one component. The structure stays the
// same regardless of whether the session has video sources:
//   1. Primary affordance: an in-panel drop zone with the format chip
//      explainer. Drops here flow through the same `openFiles` store
//      action that the shell-level zone uses (App.tsx onDrop). The
//      zone is also a click target that opens an OS file picker so
//      users on touch devices have a path that doesn't require drag.
//   2. Secondary CTA: a small text link "Try sample data" that loads
//      the bundled `short.*` fixtures. De-emphasised so it doesn't
//      compete with the user's own data path.
//   3. Tertiary affordance: when the session already has loaded video
//      channels, surface a picker list below so the user can bind one
//      to this panel without re-dropping the file.
//
// The container (`VideoPanelContainer`) still routes between empty
// state and bound-panel rendering, but it now passes the picker
// candidates directly to this component instead of swapping in a
// different empty-state variant.

import { useEffect, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { Channel, SourceMeta } from "../state/store";
import styles from "./VideoPanelEmptyState.module.css";

export interface VideoPanelEmptyStateCandidate {
  source: SourceMeta;
  channel: Channel;
}

interface VideoPanelEmptyStateProps {
  /** Render variant. `"primary"` is the centred hero used inside an
   *  unbound video panel; `"compact"` is reserved for surfaces that
   *  embed the empty state in a smaller slot (the previous
   *  "no longer available" branch). Both variants share the unified
   *  drop-zone + sample-link + picker structure so the user never
   *  sees two different designs for the same state (iter5 #5). */
  variant?: "primary" | "compact";
  /** Optional override copy for the headline (used by the
   *  "no longer available" branch). */
  headline?: string;
  /** Optional override copy for the supporting paragraph. */
  description?: string;
  /** When non-empty, render a picker list of video channels already
   *  loaded into the session. The container passes its candidate set
   *  in; we render rows that call `onPick(channelId)` on click. */
  candidates?: VideoPanelEmptyStateCandidate[];
  /** Callback fired when the user clicks a picker row. Bound to the
   *  store's `setVideoBinding(panelId, channelId)` in the container. */
  onPick?: (channelId: string) => void;
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
  candidates,
  onPick,
}: VideoPanelEmptyStateProps) {
  // Ingestion in flight — disable the CTA and swap the label so the
  // user doesn't fire a second drop on top of the first. Reading via
  // a selector is cheap; `ingesting` flips at most twice per drop.
  const ingesting = useSession((s) => s.ingesting);
  const [error, setError] = useState<string | null>(null);
  // Local "we kicked off a sample load" flag so we can show a spinner
  // on the button itself even before the store flips `ingesting`.
  const [loadingSample, setLoadingSample] = useState(false);
  // iter5 #5 — in-panel drop affordance. `dropActive` tints the zone
  // when a file is over it; `inputRef` clicks through a hidden
  // <input type=file> so the user can choose files via OS picker on
  // touch or no-drag environments.
  const [dropActive, setDropActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  const onFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    try {
      await useSession.getState().openFiles(files);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to open files",
      );
    }
  };

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    await onFiles(files);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Stop the bubble — otherwise the shell-level dropzone also
    // highlights, which reads as two simultaneously-active dropzones.
    e.stopPropagation();
    setDropActive(true);
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
  };

  const onInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    await onFiles(files);
    // Reset so picking the same file twice still triggers `change`.
    e.target.value = "";
  };

  const isLoading = ingesting || loadingSample;
  const wrapperClass =
    variant === "compact"
      ? `${styles.empty} ${styles.compact}`
      : styles.empty;
  const dropZoneClass = dropActive
    ? `${styles.dropZone} ${styles.dropZoneActive}`
    : styles.dropZone;
  const hasCandidates = (candidates?.length ?? 0) > 0;

  return (
    <div
      className={wrapperClass}
      data-testid="video-panel-empty-state"
      data-variant={variant}
      role="region"
      aria-label="Video panel empty state"
    >
      {/* Primary affordance — the drop zone. Click → OS picker; drag →
       *  same `openFiles` path. Pre-selected via `data-active` so a
       *  Playwright/e2e check can pin the highlight state without
       *  scraping class names. */}
      <div
        className={dropZoneClass}
        data-testid="video-panel-drop-zone"
        data-active={dropActive ? "true" : "false"}
        role="button"
        tabIndex={0}
        aria-label="Drop a recording or click to browse files"
        aria-busy={isLoading}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
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
        <p className={styles.description}>
          {description ??
            "Drag a file here or click to browse. MP4 with sidecar, or an MCAP with H.264 video."}
        </p>

        <ul className={styles.formats} aria-label="Supported formats">
          <li className={styles.format}>MCAP</li>
          <li className={styles.format}>MF4</li>
          <li className={styles.format}>MP4 + sidecar</li>
        </ul>

        {isLoading && (
          <div
            className={styles.loadingBadge}
            role="status"
            aria-live="polite"
            data-testid="video-panel-empty-loading"
          >
            <span className={styles.spinner} aria-hidden="true" />
            <span>Opening files…</span>
          </div>
        )}

        {/* Hidden picker — wired up to `accept` so the OS picker
         *  filters to the formats we actually handle. */}
        <input
          ref={inputRef}
          className={styles.hiddenInput}
          type="file"
          multiple
          accept=".mcap,.mf4,.mp4,.timestamps"
          onChange={onInputChange}
          data-testid="video-panel-file-input"
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>

      {/* Secondary CTA — small text link below the drop zone. Used to
       *  be a primary orange button (the iter4 audit flagged it as the
       *  only visible CTA, which over-promoted sample data over the
       *  user's own recordings). De-emphasised so it stays
       *  discoverable but yields to the drop zone above. */}
      <div className={styles.secondaryRow}>
        <button
          type="button"
          className={styles.sampleLink}
          onClick={onTrySample}
          disabled={isLoading}
          data-testid="video-panel-try-sample"
          aria-busy={isLoading}
        >
          {loadingSample ? (
            <>
              <span className={styles.spinner} aria-hidden="true" />
              <span>Loading sample…</span>
            </>
          ) : (
            <>Try sample data</>
          )}
        </button>
      </div>

      {/* Tertiary — picker for video channels already loaded into the
       *  session. The container always passes this prop (empty array
       *  when the session is empty); we render the section only when
       *  there's at least one candidate. */}
      {hasCandidates && (
        <div
          className={styles.pickerSection}
          data-testid="video-panel-empty-picker"
        >
          <p className={styles.pickerLabel}>
            Or pick a video channel already loaded
          </p>
          <ul className={styles.pickerList}>
            {candidates!.map(({ source, channel }) => (
              <li key={channel.id}>
                <button
                  type="button"
                  className={styles.pickerChoice}
                  onClick={() => onPick?.(channel.id)}
                  data-testid={`video-pick-${channel.id}`}
                >
                  <span className={styles.pickerSource}>{source.name}</span>
                  <span className={styles.pickerName}>{channel.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Privacy footnote — deliberately small + de-emphasised so it
       *  doesn't fight the CTA for attention. */}
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
