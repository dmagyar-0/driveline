// Phase 1 · Top bar (logo + wordmark + right-aligned meta).
//
// The meta slot shows: relative cursor time · sources count · worker
// status. The `data-testid="worker-status"` span is load-bearing for
// 8 e2e specs that assert it has text exactly `workers ready`.

import { useSession } from "../state/store";
import { formatRelative } from "../timeline/formatTime";
import styles from "./TopBar.module.css";

export interface TopBarProps {
  ready: boolean;
}

export function TopBar({ ready }: TopBarProps) {
  // Single-key selectors only (frontend skill). cursorNs ticks every
  // rAF during playback — keep its subscriber narrow.
  const cursorNs = useSession((s) => s.cursorNs);
  const startNs = useSession((s) => s.globalRange?.startNs ?? null);
  const sourceCount = useSession((s) => s.sources.length);

  const elapsed = formatRelative(cursorNs, startNs ?? 0n);
  const sourceLabel = `${sourceCount} source${sourceCount === 1 ? "" : "s"}`;

  return (
    <header className={styles.bar}>
      <img
        className={styles.logo}
        src="/brand/logo.svg"
        width={22}
        height={22}
        alt=""
        aria-hidden="true"
      />
      <span className={styles.wordmark}>driveline</span>
      <div className={styles.meta}>
        <span className="tabular">{elapsed}</span>
        <span className={styles.metaSep}>·</span>
        <span>{sourceLabel}</span>
        <span className={styles.metaSep}>·</span>
        <span
          className={styles.workerStatus}
          data-testid="worker-status"
        >
          {ready ? "workers ready" : "workers initialising"}
        </span>
      </div>
    </header>
  );
}
