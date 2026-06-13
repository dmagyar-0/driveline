// Tiny module-scoped registry the ScenePanel writes its current frame state
// into, so the `window.__drivelineDevHooks.getScenePanelSync(panelId)` hook
// (and Playwright) can assert what the 3D panel is actually showing — point
// count, the spin timestamp at the cursor, camera, GL health — without
// scraping a WebGL canvas. Mirrors the videoReadiness registry pattern.

export interface SceneFrameInfo {
  /** Channel id bound to the panel, or null when nothing is bound. */
  boundChannelId: string | null;
  /** Points currently uploaded to the GPU for the active spin. */
  pointCount: number;
  /** Bounding boxes currently rendered for the active frame (OpenLABEL). */
  boxCount: number;
  /** Predicted trajectory paths currently rendered for the active frame. */
  trajectoryPathCount: number;
  /** Timestamp (ns) of the spin shown at the cursor, as a string (bigint). */
  frameTsNs: string | null;
  /** Index of the active spin in the source's spin list (-1 if none). */
  spinIndex: number;
  /** Total spins in the bound source. */
  spinCount: number;
  /** False if the WebGL2 context could not be created. */
  glOk: boolean;
  /** Last error surfaced to the panel, or null. */
  error: string | null;
}

const registry = new Map<string, SceneFrameInfo>();

export function setSceneFrameInfo(panelId: string, info: SceneFrameInfo): void {
  registry.set(panelId, info);
}

export function clearSceneFrameInfo(panelId: string): void {
  registry.delete(panelId);
}

export function getSceneFrameInfo(panelId: string): SceneFrameInfo | null {
  return registry.get(panelId) ?? null;
}
