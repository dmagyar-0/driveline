// First-run / empty state. Shown over the (still-mounted) workspace
// until a session is loaded; it owns the primary "Load files" action.
//
// Once any source is present this renders nothing — so the load button
// is gone the moment data is loaded (teammate review comment: "once data
// is loaded the button should not show"). The workspace behind it stays
// mounted the whole time, so the FlexLayout model / WorkspaceHandle ref
// in App.tsx survive.
//
// It also hosts "Try the demo": a one-click session (60 s comma2k19
// highway drive — dashcam + CAN + IMU + GNSS) fetched by
// `demo/demoSession.ts`. While that downloads, the action buttons are
// replaced by a progress bar driven from the `demoLoad` store slice; the
// overlay itself disappears when the demo's sources open.

import { useRef } from "react";
import { useSession } from "../state/store";
import { loadDemoSession, DEMO_TOTAL_BYTES } from "../demo/demoSession";
import { UrlLoad } from "./UrlLoad";
import styles from "./FirstRun.module.css";

function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

export function FirstRun() {
  const hasSession = useSession((s) => s.sources.length > 0);
  const openFiles = useSession((s) => s.openFiles);
  const demoLoad = useSession((s) => s.demoLoad);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // The empty state — and the only prominent load CTA — disappears the
  // moment a session exists.
  if (hasSession) return null;

  const onLoadClick = () => fileInputRef.current?.click();
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files;
    if (picked && picked.length > 0) {
      await openFiles(Array.from(picked));
    }
    // Reset so picking the same file twice in a row still fires onChange.
    e.target.value = "";
  };

  // Explicit inclusion list (not a boolean chain) for which demo phases
  // swap the action buttons for the progress strip.
  const demoBusy =
    demoLoad.phase === "fetching" || demoLoad.phase === "opening";
  const demoPct =
    demoLoad.totalBytes > 0
      ? Math.min(
          100,
          Math.round((demoLoad.receivedBytes / demoLoad.totalBytes) * 100),
        )
      : 0;

  return (
    <div className={styles.root} data-testid="first-run">
      <svg
        className={styles.glyph}
        viewBox="0 0 64 64"
        width="56"
        height="56"
        aria-hidden="true"
      >
        <rect
          x="8"
          y="29"
          width="48"
          height="4"
          rx="2"
          fill="var(--color-border-subtle)"
        />
        <rect
          x="8"
          y="29"
          width="22"
          height="4"
          rx="2"
          fill="var(--color-accent-orange)"
        />
        <path
          d="M30 18 L42 32 L30 46"
          fill="none"
          stroke="var(--color-accent-orange)"
          strokeWidth="4"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      </svg>

      <h2 className={styles.title}>No session loaded</h2>
      <p className={styles.body}>
        Drop <code className={styles.code}>.mcap</code>,{" "}
        <code className={styles.code}>.mf4</code>, or{" "}
        <code className={styles.code}>.mp4</code>{" "}
        <code className={styles.code}>(+ .mp4.timestamps)</code> files anywhere
        to load a session — or paste a URL to a{" "}
        <code className={styles.code}>.mcap</code> /{" "}
        <code className={styles.code}>.mf4</code> below. Local files never leave
        the tab.
      </p>

      <div className={styles.chips}>
        <span className={styles.kindChip}>MCAP</span>
        <span className={styles.kindChip}>MF4</span>
        <span className={styles.kindChip}>MP4+TS</span>
      </div>

      {demoBusy ? (
        <div className={styles.demoProgress} data-testid="demo-progress">
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label="Demo download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={demoLoad.phase === "opening" ? 100 : demoPct}
          >
            <div
              className={styles.progressFill}
              style={{
                transform: `scaleX(${
                  demoLoad.phase === "opening" ? 1 : demoPct / 100
                })`,
              }}
            />
          </div>
          <span className={styles.progressText} role="status">
            {demoLoad.phase === "opening"
              ? "Opening demo session…"
              : `Downloading demo… ${mb(demoLoad.receivedBytes)} / ${mb(
                  demoLoad.totalBytes,
                )} MB`}
          </span>
        </div>
      ) : (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.loadBtn}
            onClick={onLoadClick}
            data-testid="first-run-load"
          >
            <UploadIcon />
            <span>Load files…</span>
          </button>
          <button
            type="button"
            className={styles.demoBtn}
            onClick={() => void loadDemoSession()}
            data-testid="first-run-demo"
          >
            <PlayIcon />
            <span>Try the demo</span>
          </button>
        </div>
      )}

      {demoLoad.phase === "error" && (
        <p className={styles.demoError} role="alert" data-testid="demo-error">
          Demo failed to load: {demoLoad.error}
        </p>
      )}

      <p className={styles.demoNote}>
        The demo streams a 60 s highway drive (~{mb(DEMO_TOTAL_BYTES)} MB) —
        dashcam video, CAN, IMU and GNSS from{" "}
        <a
          className={styles.demoLink}
          href="https://github.com/commaai/comma2k19"
          target="_blank"
          rel="noreferrer"
        >
          comma2k19
        </a>{" "}
        (© comma.ai, MIT).
      </p>

      <div className={styles.urlRow}>
        <span className={styles.orRule} aria-hidden="true" />
        <span className={styles.orText}>or load from URL</span>
        <span className={styles.orRule} aria-hidden="true" />
      </div>
      <UrlLoad variant="firstrun" />

      <p className={styles.kbd}>
        <kbd>Space</kbd> play · <kbd>←</kbd> <kbd>→</kbd> step ·{" "}
        <kbd>Home</kbd> / <kbd>End</kbd> jump
      </p>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        onChange={onFileChange}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}

function UploadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5M12 3v12" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  );
}
