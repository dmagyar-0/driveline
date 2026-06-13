// Module-scoped registry the VideoPanel's overlay draw loop writes its current
// state into, so `window.__drivelineDevHooks.getVideoOverlaySync(panelId)` (and
// Playwright) can assert what the point-cloud-on-video overlay is projecting
// without scraping the canvas. Mirrors the `sceneDevState` registry pattern.
//
// Timestamps are decimal STRINGS so the value survives any Comlink/agent
// boundary intact (never narrow a ns bigint through `Number`).

export interface VideoOverlayInfo {
  /** True when an overlay binding is set for this panel and being drawn. */
  enabled: boolean;
  /** Bound camera name within the calibration, or null when no binding. */
  cameraName: string | null;
  /** Timestamp (ns) of the LiDAR spin projected onto the frame, as a string. */
  spinTsNs: string | null;
  /** Total points in the projected spin. */
  pointCount: number;
  /** Points that projected in front of the camera and inside the image. */
  projectedVisibleCount: number;
}

const EMPTY: VideoOverlayInfo = {
  enabled: false,
  cameraName: null,
  spinTsNs: null,
  pointCount: 0,
  projectedVisibleCount: 0,
};

const registry = new Map<string, VideoOverlayInfo>();

export function setVideoOverlayInfo(
  panelId: string,
  info: VideoOverlayInfo,
): void {
  registry.set(panelId, info);
}

export function clearVideoOverlayInfo(panelId: string): void {
  registry.delete(panelId);
}

export function getVideoOverlayInfo(panelId: string): VideoOverlayInfo {
  return registry.get(panelId) ?? EMPTY;
}
