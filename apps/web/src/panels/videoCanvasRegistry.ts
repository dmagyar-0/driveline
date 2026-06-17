// Module-scoped registry of live VideoPanels, keyed by panel id. The panel
// registers on mount and clears on unmount.
//
// v5 (off-thread blit): the video canvas is now `transferControlToOffscreen`d
// to the videoDecode worker, which owns the blit. After the transfer the main
// thread can no longer read the canvas back — `canvas.toDataURL()` throws on a
// transferred element — so the registry no longer stores the `<canvas>`. Its
// job is now just "which panel ids have a live video panel", which the agent
// surface uses for `listVideoPanels()`. `captureVideoFrame(panelId?)` resolves
// the panel's bound video channel and decodes the frame at the current cursor
// off the playback path (see `agentApi.ts` / `videoCapture.ts`), so it never
// touches the live canvas. The registration still mirrors `sceneDevState.ts`:
// register on mount, clear on unmount.

const registry = new Set<string>();

/** Register a live video panel by id (called on mount). */
export function registerVideoPanel(panelId: string): void {
  registry.add(panelId);
}

/** Drop a video panel from the registry (called on unmount). */
export function unregisterVideoPanel(panelId: string): void {
  registry.delete(panelId);
}

/** Whether a panel id currently has a live video panel. */
export function hasVideoPanel(panelId: string): boolean {
  return registry.has(panelId);
}

/** Panel ids with a live video panel, in registration order. */
export function listVideoCanvasPanelIds(): string[] {
  return [...registry];
}
