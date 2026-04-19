import styles from "./unsupportedSplash.module.css";

export function isWebCodecsSupported(
  scope: { VideoDecoder?: unknown } = globalThis as {
    VideoDecoder?: unknown;
  },
): boolean {
  const vd = scope.VideoDecoder;
  if (typeof vd !== "function") return false;
  const isConfigSupported = (vd as { isConfigSupported?: unknown })
    .isConfigSupported;
  return typeof isConfigSupported === "function";
}

export const unsupportedSplashHtml = `
  <div class="${styles.card}" role="alert" aria-live="polite">
    <h1 class="${styles.title}">Driveline requires a WebCodecs-capable browser</h1>
    <p class="${styles.body}">
      Driveline decodes video in the browser using the WebCodecs API,
      which this browser does not support. Please open Driveline in a
      recent Chromium-based browser.
    </p>
    <ul class="${styles.browsers}">
      <li><a href="https://www.google.com/chrome/" rel="noreferrer noopener" target="_blank">Google Chrome 94+</a></li>
      <li><a href="https://www.microsoft.com/edge" rel="noreferrer noopener" target="_blank">Microsoft Edge 94+</a></li>
    </ul>
    <p class="${styles.note}">
      Firefox and Safari do not yet ship the WebCodecs video APIs
      Driveline needs.
    </p>
  </div>
`;

export function renderUnsupportedSplash(root: HTMLElement): void {
  root.className = styles.splash;
  root.innerHTML = unsupportedSplashHtml;
}
