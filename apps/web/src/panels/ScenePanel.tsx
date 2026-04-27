// Phase 6 · ScenePanel — placeholder until the Rust core defines a
// point-cloud Arrow schema. The integration plan
// (`docs/design/v1-shell-integration.md` §6.4) is explicit that we do
// not pull in `three.js` speculatively.
//
// Rendering nothing data-driven is intentional. The empty-state callout
// names the gating dependency so a reviewer can see why this panel is
// inert at v1. The `sceneBindings[panelId]` slot is allocated for
// forward compatibility — once `point_cloud` channels exist, this panel
// upgrades in place without a layout-schema bump (the binding map is
// already part of `LAYOUT_SCHEMA_VERSION = 3`).

import { useEffect, useRef } from "react";
import { useSession } from "../state/store";
import styles from "./ScenePanel.module.css";

interface ScenePanelProps {
  panelId: string;
}

export function ScenePanel({ panelId }: ScenePanelProps) {
  const binding = useSession((s) => s.sceneBindings[panelId] ?? null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Keep the ResizeObserver lifecycle wired even when there's nothing
  // to draw — that way upgrading this panel later doesn't require
  // reworking the shell. Frontend-skill rule: every effect cleans up.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // Placeholder — no canvas to size yet.
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <section
      ref={containerRef}
      className={styles.panel}
      data-testid="scene-panel"
    >
      <div className={styles.empty} data-testid="scene-empty">
        <p className={styles.title}>3D scene</p>
        <p className={styles.body}>
          Rendering pending point-cloud format from rust core.
        </p>
        {binding !== null && (
          <p className={styles.bound} data-testid="scene-bound-channel">
            Bound: <code>{binding}</code>
          </p>
        )}
      </div>
    </section>
  );
}
