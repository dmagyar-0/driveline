// Phase 1 · Shell skeleton.
//
// Owns the top-row / work-row / transport-row CSS grid and hosts the
// dropzone handlers (the <main> root is the dnd target — its testid and
// focus contract are used by `videoSeek.spec.ts:205`).
//
// `App.tsx` keeps the worker bootstrap, the dev-hook surface, and the
// drag-state useState; Shell is purely presentational and takes those
// as props. Selectors for the top-bar meta and the drawer state are
// pulled from the store inside TopBar and Drawer respectively.

import type { ReactNode } from "react";
import { TopBar } from "./TopBar";
import { Rail } from "./Rail";
import { Drawer } from "./Drawer";
import styles from "./Shell.module.css";

export interface ShellProps {
  ready: boolean;
  dragActive: boolean;
  onDrop: (e: React.DragEvent<HTMLElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
  /** Forwarded to the Channels drawer so it can mint a plot panel
   *  when the user clicks a channel without a panel selected. App
   *  owns the FlexLayout `WorkspaceHandle`; Shell only forwards. */
  ensurePlotPanel: () => string | null;
  transport: ReactNode;
  children: ReactNode;
}

export function Shell({
  ready,
  dragActive,
  onDrop,
  onDragOver,
  onDragLeave,
  ensurePlotPanel,
  transport,
  children,
}: ShellProps) {
  return (
    <main
      className={styles.shell}
      data-testid="drop-zone"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <TopBar ready={ready} />
      <div className={styles.work}>
        <Rail />
        <Drawer ensurePlotPanel={ensurePlotPanel} />
        <div className={styles.workMain}>{children}</div>
      </div>
      {transport}
      {dragActive && (
        <div className={styles.dragOverlay}>
          Drop .mcap, .mf4, or .mp4 (+ .mp4.timestamps) to load a session.
        </div>
      )}
    </main>
  );
}
