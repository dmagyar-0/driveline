// "Try the demo" session — a 60 s comma2k19 highway segment (dashcam mp4 +
// sidecar, CAN/IMU in MCAP, wheel/IMU/GNSS scalars in MF4) fetched from the
// repo's public `demo-assets` orphan branch and opened through the normal
// `openFiles` path, then arranged into a curated workspace.
//
// The assets are MIT-licensed comma2k19 data (© comma.ai) — see the README on
// the `demo-assets` branch for provenance and regeneration steps.
//
// Loading is observable via the `demoLoad` store slice (FirstRun renders the
// progress bar from it), and idempotent: a second call while fetching/opening
// — or once a session exists — is a no-op, so the FirstRun button and the
// `?demo` deep-link can't double-load.

import { useSession } from "../state/store";
import type { WorkspaceSnapshot } from "../state/store";
import type { MapBinding } from "../layout/persist";

/** Asset host. Override with VITE_DEMO_ASSET_BASE (e.g. a local dir served by
 *  the dev middleware) to test the loader without hitting GitHub. */
export const DEMO_ASSET_BASE: string =
  (import.meta.env.VITE_DEMO_ASSET_BASE as string | undefined) ??
  "https://raw.githubusercontent.com/dmagyar-0/driveline/demo-assets";

interface DemoAsset {
  name: string;
  /** Exact size on the asset host — drives the download progress bar. */
  bytes: number;
}

// Sizes must match the files on the `demo-assets` branch (Content-Length is
// unreliable for progress: raw.githubusercontent.com may serve gzip).
export const DEMO_ASSETS: readonly DemoAsset[] = [
  { name: "comma2k19_seg10.mp4", bytes: 34_583_240 },
  { name: "comma2k19_seg10.mp4.timestamps", bytes: 28_890 },
  { name: "comma2k19.mcap", bytes: 1_317_320 },
  { name: "comma2k19.mf4", bytes: 463_656 },
];

export const DEMO_TOTAL_BYTES = DEMO_ASSETS.reduce((n, a) => n + a.bytes, 0);

// Source ids equal the dropped file names (fresh session ⇒ no uniquifier
// suffix); channels are resolved by display name after open so this module
// never hardcodes the qualified-channel-id scheme.
const SRC_VIDEO = "comma2k19_seg10.mp4";
const SRC_MCAP = "comma2k19.mcap";
const SRC_MF4 = "comma2k19.mf4";

// Panel ids carry the kind prefix `layout/panelId.ts` discriminates on.
const VIDEO_PANEL = "video-demo-dashcam";
const MAP_PANEL = "map-demo-route";
const PLOT_SPEED_PANEL = "plot-demo-speed";
const PLOT_DYN_PANEL = "plot-demo-dynamics";

// Dashcam left; route map + two plots stacked on the right. Mirrors
// `defaultLayoutModel`'s global flags (Workspace's buildModel re-enforces
// them for every loaded layout anyway).
const DEMO_LAYOUT = {
  global: {
    tabEnableClose: false,
    tabSetEnableMaximize: false,
    tabEnableRename: false,
    splitterSize: 4,
    borderEnableAutoHide: true,
  },
  borders: [],
  layout: {
    type: "row",
    weight: 100,
    children: [
      {
        type: "tabset",
        weight: 58,
        children: [
          {
            type: "tab",
            id: VIDEO_PANEL,
            name: "Dashcam",
            component: "video",
          },
        ],
      },
      {
        type: "row",
        weight: 42,
        children: [
          {
            type: "tabset",
            weight: 40,
            children: [
              { type: "tab", id: MAP_PANEL, name: "Route", component: "map" },
            ],
          },
          {
            type: "tabset",
            weight: 30,
            children: [
              {
                type: "tab",
                id: PLOT_SPEED_PANEL,
                name: "Speed",
                component: "plot",
              },
            ],
          },
          {
            type: "tabset",
            weight: 30,
            children: [
              {
                type: "tab",
                id: PLOT_DYN_PANEL,
                name: "Steering · yaw",
                component: "plot",
              },
            ],
          },
        ],
      },
    ],
  },
};

/** Stream one asset to a `File`, reporting each chunk's size to `onBytes`. */
async function fetchDemoFile(
  asset: DemoAsset,
  onBytes: (n: number) => void,
): Promise<File> {
  const res = await fetch(`${DEMO_ASSET_BASE}/${asset.name}`);
  if (!res.ok) {
    throw new Error(`${asset.name}: HTTP ${res.status}`);
  }
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onBytes(buf.byteLength);
    return new File([buf], asset.name);
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.byteLength);
  }
  return new File(chunks, asset.name);
}

/** `openFiles` throws if the Comlink worker isn't registered yet; the demo
 *  can be triggered (button or `?demo`) before init finishes, so wait for
 *  `setWorker` — the download usually outlasts worker boot anyway. */
async function waitForWorker(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (useSession.getState().getWorker() === null) {
    if (Date.now() > deadline) {
      throw new Error("workers did not initialise");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function channelId(sourceId: string, name: string): string | null {
  const { channels } = useSession.getState();
  return (
    channels.find((c) => c.sourceId === sourceId && c.name === name)?.id ??
    null
  );
}

function applyDemoWorkspaceFromSession(): void {
  const { channels, applyDemoWorkspace } = useSession.getState();

  const video =
    channels.find((c) => c.sourceId === SRC_VIDEO && c.kind === "video")?.id ??
    null;
  const speed = channelId(SRC_MCAP, "/vehicle/speed");
  const wheelFl = channelId(SRC_MF4, "WheelSpeedFL");
  const steer = channelId(SRC_MCAP, "/vehicle/steering_angle");
  const gyroZ = channelId(SRC_MF4, "IMU_Gyro_Z");
  const lat = channelId(SRC_MF4, "GNSS_Lat");
  const lon = channelId(SRC_MF4, "GNSS_Lon");

  const map: MapBinding | null =
    lat !== null && lon !== null
      ? { latChannelId: lat, lonChannelId: lon }
      : null;

  // Steering (deg) and yaw rate (rad/s) share a panel on stacked axes.
  const dynAxes: Record<string, number> = {};
  if (steer !== null) dynAxes[steer] = 0;
  if (gyroZ !== null) dynAxes[gyroZ] = 1;

  const snapshot: WorkspaceSnapshot = {
    layoutJson: DEMO_LAYOUT,
    videoBindings: { [VIDEO_PANEL]: video },
    plotBindings: {
      // /vehicle/speed (MCAP) next to WheelSpeedFL (MF4): two formats, one
      // axis — both m/s.
      [PLOT_SPEED_PANEL]: [speed, wheelFl].filter((c): c is string => c !== null),
      [PLOT_DYN_PANEL]: [steer, gyroZ].filter((c): c is string => c !== null),
    },
    sceneBindings: {},
    mapBindings: { [MAP_PANEL]: map },
    tableBindings: {},
    valueBindings: {},
    enumBindings: {},
    plotPanelSettings: {
      [PLOT_DYN_PANEL]: {
        gapThresholdSec: null,
        axisAssignments: dynAxes,
        stackAxes: true,
      },
    },
  };
  applyDemoWorkspace(snapshot);
}

/**
 * Fetch + open + arrange the demo session. Progress and failures surface via
 * the `demoLoad` store slice; resolves once the workspace is applied and
 * playback starts. No-op when a session already exists or a load is running.
 */
export async function loadDemoSession(): Promise<void> {
  const initial = useSession.getState();
  if (
    initial.sources.length > 0 ||
    initial.demoLoad.phase === "fetching" ||
    initial.demoLoad.phase === "opening"
  ) {
    return;
  }
  initial.setDemoLoad({
    phase: "fetching",
    receivedBytes: 0,
    totalBytes: DEMO_TOTAL_BYTES,
    error: null,
  });
  try {
    let received = 0;
    let lastPush = 0;
    // Coalesce progress writes (network chunks arrive far faster than the
    // bar needs) — at most ~8 store updates per second plus the final one.
    const onBytes = (n: number) => {
      received += n;
      const now = performance.now();
      if (now - lastPush > 120 || received >= DEMO_TOTAL_BYTES) {
        lastPush = now;
        useSession.getState().setDemoLoad({ receivedBytes: received });
      }
    };
    const files = await Promise.all(
      DEMO_ASSETS.map((a) => fetchDemoFile(a, onBytes)),
    );
    await waitForWorker();
    useSession.getState().setDemoLoad({
      phase: "opening",
      receivedBytes: DEMO_TOTAL_BYTES,
    });
    const result = await useSession.getState().openFiles(files);
    if (result.opened.length === 0) {
      throw new Error(result.errors[0]?.reason ?? "no demo files opened");
    }
    applyDemoWorkspaceFromSession();
    useSession.getState().setDemoLoad({ phase: "idle" });
    useSession.getState().play();
  } catch (e) {
    useSession.getState().setDemoLoad({
      phase: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
