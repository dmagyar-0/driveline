// ScenePanel — 3D point-cloud viewer (LiDAR). Binds a single `point_cloud`
// channel via `sceneBindings[panelId]` and renders the spin active at the
// shared cursor through a dependency-free WebGL2 renderer. Points are coloured
// by intensity (turbo colormap); orbit / pan / zoom with the mouse.
//
// Time sync without waste: the bound source's spin start-times are pulled once
// (`lidarSpinTimes`) and binary-searched locally, so the panel only refetches
// geometry when the cursor crosses into a new spin — not on every rAF cursor
// tick. The fetch+decode+upload is bracketed with `perf` marks per the
// cursor/video hot-path budget rule. Rendering is imperative and lives in
// refs (a WebGL canvas is not serialisable), mirroring MapPanel/Leaflet.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { Channel, SourceMeta } from "../state/store";
import { mark, measure } from "../perf";
import { decodePointCloud } from "./pointCloudFromArrow";
import { PointCloudRenderer } from "./pointCloudRenderer";
import { clearSceneFrameInfo, setSceneFrameInfo } from "./sceneDevState";
import styles from "./ScenePanel.module.css";

interface ScenePanelProps {
  panelId: string;
}

function findChannel(sources: SourceMeta[], channelId: string): Channel | null {
  for (const s of sources) {
    const hit = s.channels.find((c) => c.id === channelId);
    if (hit) return hit;
  }
  return null;
}

// Largest index `i` with `times[i] <= cursor`, or -1 if cursor precedes the
// first spin. `times` is ascending (spin start timestamps).
function activeSpinIndex(times: BigInt64Array, cursorNs: bigint): number {
  if (times.length === 0 || cursorNs < times[0]) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= cursorNs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

type Status =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "before" } // cursor before the first spin
  | { kind: "ready"; points: number };

export function ScenePanel({ panelId }: ScenePanelProps) {
  const sources = useSession((s) => s.sources);
  const binding = useSession((s) => s.sceneBindings[panelId] ?? null);
  const setSceneBinding = useSession((s) => s.setSceneBinding);
  // Following the cursor through a selector (not a manual store.subscribe) is
  // the pattern MapPanel uses: playback advances `cursorNs` at most once per
  // rAF, so this re-renders ≤1×/frame, and the effect below turns each change
  // into a (cheap) spin lookup that only refetches geometry on a spin change.
  const cursorNs = useSession((s) => s.cursorNs);

  const channel = binding === null ? null : findChannel(sources, binding);
  const channelId = channel?.id ?? null;
  const isEmpty = channelId === null;

  // Drop a stale persisted binding once sources exist but the channel is gone.
  useEffect(() => {
    if (sources.length === 0) return;
    if (binding !== null && channel === null) {
      setSceneBinding(panelId, null);
    }
  }, [binding, channel, panelId, setSceneBinding, sources.length]);

  const [status, setStatus] = useState<Status>({ kind: "loading" });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PointCloudRenderer | null>(null);
  const spinTimesRef = useRef<BigInt64Array | null>(null);
  const lastSpinRef = useRef<number>(-1);
  const framedRef = useRef<boolean>(false);
  const reqIdRef = useRef<number>(0);
  const channelIdRef = useRef<string | null>(channelId);
  channelIdRef.current = channelId;

  // Push the latest frame state into the dev-hook registry.
  const publish = useCallback(
    (over: Partial<Parameters<typeof setSceneFrameInfo>[1]>) => {
      setSceneFrameInfo(panelId, {
        boundChannelId: channelIdRef.current,
        pointCount: rendererRef.current?.pointCountValue() ?? 0,
        frameTsNs: null,
        spinIndex: lastSpinRef.current,
        spinCount: spinTimesRef.current?.length ?? 0,
        glOk: rendererRef.current !== null,
        error: null,
        ...over,
      });
    },
    [panelId],
  );

  // Recompute the active spin for the current cursor and, if it changed, fetch
  // + decode + upload that spin. Cheap no-op when the cursor stayed in-spin.
  const updateFrame = useCallback(async () => {
    const renderer = rendererRef.current;
    const times = spinTimesRef.current;
    const id = channelIdRef.current;
    if (!renderer || !times || id === null) return;

    const cursorNs = useSession.getState().cursorNs;
    const idx = activeSpinIndex(times, cursorNs);
    if (idx === lastSpinRef.current) return; // still the same spin — nothing to do
    lastSpinRef.current = idx;

    if (idx < 0) {
      renderer.clearPoints();
      setStatus({ kind: "before" });
      publish({ pointCount: 0, frameTsNs: null, spinIndex: -1 });
      return;
    }

    const reqId = ++reqIdRef.current;
    const ts = times[idx];
    mark("scene-frame:start");
    try {
      // Narrow window [ts, ts+1) returns exactly this spin (one row).
      const bytes = await useSession
        .getState()
        .fetchChannelRange(id, ts, ts + 1n, false);
      if (reqId !== reqIdRef.current || rendererRef.current !== renderer)
        return;
      const res = decodePointCloud(bytes);
      if (!res.ok) {
        setStatus({ kind: "error", message: res.message });
        publish({ error: res.message });
        return;
      }
      if (res.count === 0) {
        renderer.clearPoints();
        setStatus({ kind: "before" });
        publish({ pointCount: 0, frameTsNs: null });
        return;
      }
      if (!framedRef.current) {
        renderer.frameToBounds(res.positions);
        framedRef.current = true;
      }
      renderer.setPoints(res.positions, res.intensities, res.count);
      setStatus({ kind: "ready", points: res.count });
      publish({
        pointCount: res.count,
        frameTsNs: (res.tsNs ?? ts).toString(),
        spinIndex: idx,
        error: null,
      });
    } catch (err) {
      if (reqId !== reqIdRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
      publish({ error: message });
    } finally {
      mark("scene-frame:end");
      measure("scene-frame", "scene-frame:start", "scene-frame:end");
    }
  }, [publish]);

  // Keep the freshest `updateFrame` reachable from the cursor subscription
  // without re-subscribing on every render.
  const updateFrameRef = useRef(updateFrame);
  updateFrameRef.current = updateFrame;

  // Create / tear down the WebGL renderer with the bound canvas.
  useEffect(() => {
    if (isEmpty) return;
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    let renderer: PointCloudRenderer;
    try {
      renderer = new PointCloudRenderer(canvas);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
      publish({ glOk: false, error: message });
      return;
    }
    rendererRef.current = renderer;
    renderer.resize(host.clientWidth, host.clientHeight);

    const ro = new ResizeObserver(() => {
      renderer.resize(host.clientWidth, host.clientHeight);
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [isEmpty, publish]);

  // Load the bound source's spin timeline; reset per-binding state. Runs after
  // the renderer effect on the same commit, so an initial frame can paint.
  useEffect(() => {
    if (isEmpty || channelId === null) {
      clearSceneFrameInfo(panelId);
      return;
    }
    let aborted = false;
    lastSpinRef.current = -1;
    framedRef.current = false;
    spinTimesRef.current = null;
    setStatus({ kind: "loading" });
    publish({ pointCount: 0, frameTsNs: null, spinIndex: -1, error: null });

    void (async () => {
      try {
        const times = await useSession.getState().lidarSpinTimes(channelId);
        if (aborted || channelIdRef.current !== channelId) return;
        spinTimesRef.current = times;
        await updateFrameRef.current();
      } catch (err) {
        if (aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ kind: "error", message });
        publish({ error: message });
      }
    })();

    return () => {
      aborted = true;
    };
  }, [isEmpty, channelId, panelId, publish]);

  // Follow the cursor: each `cursorNs` change runs the (cheap) spin lookup,
  // which only refetches geometry when the active spin actually changes. The
  // store advances `cursorNs` ≤1×/rAF during playback, so this stays within
  // the cursor hot-path budget.
  useEffect(() => {
    if (isEmpty) return;
    void updateFrameRef.current();
  }, [cursorNs, isEmpty]);

  useEffect(() => () => clearSceneFrameInfo(panelId), [panelId]);

  if (isEmpty) {
    return (
      <section className={styles.panel} data-testid="scene-panel">
        <div className={styles.empty} data-testid="scene-empty">
          <p className={styles.title}>3D scene</p>
          <p className={styles.body}>
            Bind a point-cloud channel from the Panel drawer to render a LiDAR
            point cloud here — coloured by intensity, stepping with the cursor.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.panel} data-testid="scene-panel">
      <div className={styles.canvasHost} data-testid="scene-canvas-host">
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          data-testid="scene-canvas"
        />

        {status.kind === "loading" && (
          <div
            className={styles.statusOverlay}
            data-testid="scene-loading"
            role="status"
          >
            Loading point cloud…
          </div>
        )}
        {status.kind === "error" && (
          <div
            className={styles.statusOverlay}
            data-testid="scene-error"
            role="alert"
          >
            <span className={styles.statusIcon} aria-hidden="true">
              !
            </span>
            {status.message}
          </div>
        )}
        {status.kind === "before" && (
          <div
            className={styles.statusOverlay}
            data-testid="scene-no-frame"
            role="status"
          >
            No LiDAR spin at this time.
          </div>
        )}

        <span className={styles.hint} data-testid="scene-hint">
          drag to orbit · scroll to zoom · shift-drag to pan
        </span>
        {status.kind === "ready" && (
          <span className={styles.pointsPill} data-testid="scene-points-count">
            {status.points.toLocaleString()} pts
          </span>
        )}
      </div>
    </section>
  );
}
