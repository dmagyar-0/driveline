import styles from "./WorkerErrorBanner.module.css";
import type { WorkerCrash } from "./workerClient";

export interface WorkerErrorBannerProps {
  crash: WorkerCrash;
  /** Defaults to a full page reload. Injectable for tests. */
  onReload?: () => void;
}

/**
 * Fatal, non-dismissable banner shown when a background worker crashes.
 *
 * A crashed worker leaves its Comlink proxy permanently unresponsive (the
 * `MessagePort` peer is gone), so the app can't recover in place — the only
 * safe action is a reload. The banner therefore has no close button; it stays
 * up until the user reloads. `role="alert"` + `aria-live="assertive"` makes
 * screen readers announce it immediately.
 */
export function WorkerErrorBanner({
  crash,
  onReload,
}: WorkerErrorBannerProps): React.JSX.Element {
  const reload = onReload ?? (() => window.location.reload());
  return (
    <div className={styles.banner} role="alert" aria-live="assertive">
      <span className={styles.icon} aria-hidden="true">
        ⚠
      </span>
      <div className={styles.text}>
        <span className={styles.title}>
          A background worker stopped responding.
        </span>{" "}
        Driveline can&rsquo;t continue and needs to be reloaded.{" "}
        <span className={styles.detail}>({crash.message})</span>
      </div>
      <button type="button" className={styles.reloadBtn} onClick={reload}>
        Reload
      </button>
    </div>
  );
}
