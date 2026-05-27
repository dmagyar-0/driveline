// Shell skeleton — owns the top-row / work-row / transport-row CSS grid
// and hosts the dropzone handlers. The <main> root is the dnd target;
// `videoSeek.spec.ts:205` depends on its testid and focus contract.

import type { ReactNode } from "react";
import { TopBar } from "./TopBar";
import { Rail } from "./Rail";
import { Drawer } from "./Drawer";
import { useSession } from "../state/store";
import styles from "./Shell.module.css";

export interface ShellProps {
  ready: boolean;
  dragActive: boolean;
  onDrop: (e: React.DragEvent<HTMLElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
  /** Mints a plot panel when the Channels drawer's click-to-bind needs
   *  a target and none is selected. App owns the `WorkspaceHandle`;
   *  Shell only forwards. */
  ensurePlotPanel: () => string | null;
  addVideoPanel: () => void;
  addPlotPanel: () => void;
  addScenePanel: () => void;
  addMapPanel: () => void;
  addTablePanel: () => void;
  addEnumPanel: () => void;
  resetLayout: () => void;
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
  addVideoPanel,
  addPlotPanel,
  addScenePanel,
  addMapPanel,
  addTablePanel,
  addEnumPanel,
  resetLayout,
  transport,
  children,
}: ShellProps) {
  const setActiveRailTab = useSession((s) => s.setActiveRailTab);
  return (
    <main
      className={styles.shell}
      data-testid="drop-zone"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <TopBar
        ready={ready}
        onOpenSourcesDrawer={() => setActiveRailTab("sources")}
      />
      <div className={styles.work}>
        <Rail />
        <Drawer
          ensurePlotPanel={ensurePlotPanel}
          addVideoPanel={addVideoPanel}
          addPlotPanel={addPlotPanel}
          addScenePanel={addScenePanel}
          addMapPanel={addMapPanel}
          addTablePanel={addTablePanel}
          addEnumPanel={addEnumPanel}
          resetLayout={resetLayout}
        />
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
