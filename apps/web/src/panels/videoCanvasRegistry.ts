// Module-scoped registry of the live <canvas> element behind every
// VideoPanel, keyed by panel id. Mirrors `sceneDevState.ts`: the panel
// registers on mount and clears on unmount, so the agent API
// (`captureVideoFrame`) can grab the decoded pixels at the cursor via
// `canvas.toDataURL()` without scraping the DOM or owning panel
// internals. The blit path draws with a plain 2D context (no WebGL, no
// OffscreenCanvas transfer), so reading the canvas back is always legal.

const registry = new Map<string, HTMLCanvasElement>();

export function setVideoCanvas(
  panelId: string,
  canvas: HTMLCanvasElement,
): void {
  registry.set(panelId, canvas);
}

export function clearVideoCanvas(panelId: string): void {
  registry.delete(panelId);
}

export function getVideoCanvas(panelId: string): HTMLCanvasElement | null {
  return registry.get(panelId) ?? null;
}

/** Panel ids with a live canvas, in registration order. */
export function listVideoCanvasPanelIds(): string[] {
  return [...registry.keys()];
}
