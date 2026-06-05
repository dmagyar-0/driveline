import styles from "./unsupportedSplash.module.css";

export function isWebCodecsSupported(
  scope: { VideoDecoder?: unknown } = globalThis as {
    VideoDecoder?: unknown;
  },
): boolean {
  // Synchronous existence check only. The accurate, codec-specific gate is
  // the async `VideoDecoder.isConfigSupported(config)` call performed at
  // stream-open time in the videoDecode worker (`configureFromFirstKeyframe`)
  // — it varies by the actual SPS/profile/level and can't be answered
  // synchronously here without a real config. This splash gate just rules
  // out browsers that ship no WebCodecs at all (Safari, by design). Keeping
  // it sync preserves the boot-time contract: callers render the splash
  // before any worker exists.
  const vd = scope.VideoDecoder;
  if (typeof vd !== "function") return false;
  const isConfigSupported = (vd as { isConfigSupported?: unknown })
    .isConfigSupported;
  return typeof isConfigSupported === "function";
}

// Baseline per CLAUDE.md / docs/07: Chrome, Edge, and Firefox 130+ ship the
// WebCodecs video APIs Driveline needs. Safari is unsupported by design.
export const unsupportedSplashHtml = `
  <div class="${styles.card}" role="alert" aria-live="polite">
    <h1 class="${styles.title}">Driveline requires a WebCodecs-capable browser</h1>
    <p class="${styles.body}">
      Driveline decodes video in the browser using the WebCodecs API,
      which this browser does not support. Please open Driveline in a
      recent version of Chrome, Edge, or Firefox.
    </p>
    <ul class="${styles.browsers}">
      <li><a href="https://www.google.com/chrome/" rel="noreferrer noopener" target="_blank">Google Chrome 130+</a></li>
      <li><a href="https://www.microsoft.com/edge" rel="noreferrer noopener" target="_blank">Microsoft Edge 130+</a></li>
      <li><a href="https://www.mozilla.org/firefox/" rel="noreferrer noopener" target="_blank">Mozilla Firefox 130+</a></li>
    </ul>
    <p class="${styles.note}">
      Safari does not ship the WebCodecs video APIs Driveline needs and is
      unsupported.
    </p>
  </div>
`;

export function renderUnsupportedSplash(root: HTMLElement): void {
  root.className = styles.splash;
  root.innerHTML = unsupportedSplashHtml;
}
