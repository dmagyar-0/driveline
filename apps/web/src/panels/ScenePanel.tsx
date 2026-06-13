// ScenePanel — 3D scene viewer. Binds a single scene channel via
// `sceneBindings[panelId]` and renders the geometry active at the shared cursor
// through a dependency-free WebGL2 renderer. Three channel kinds are handled:
//
//   • `point_cloud` (LiDAR): a spin coloured by intensity (turbo colormap);
//   • `bounding_box` (OpenLABEL): amber wireframe 3D boxes + floating HTML
//     labels, one frame of boxes at the cursor.
//   • `trajectory`: predicted ego future trajectories — cyan→green candidate
//     polylines (per-confidence alpha), one frame of paths at the cursor.
//
// Time sync without waste: the bound source's frame start-times are pulled once
// (`lidarSpinTimes` for clouds, `boxFrameTimes` for boxes, `trajectoryFrameTimes`
// for trajectories) and binary-searched
// locally, so the panel only refetches geometry when the cursor crosses into a
// new frame — not on every rAF cursor tick. The fetch+decode+upload is
// bracketed with `perf` marks per the cursor/video hot-path budget rule.
// Rendering is imperative and lives in refs (a WebGL canvas is not
// serialisable), mirroring MapPanel/Leaflet.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { Channel, ChannelKind, SourceMeta } from "../state/store";
import { mark, measure } from "../perf";
import { decodePointCloud } from "./pointCloudFromArrow";
import { decodeBoxes, type BoundingBox } from "./boxesFromArrow";
import { decodeTrajectories } from "./trajectoriesFromArrow";
import { PointCloudRenderer } from "./pointCloudRenderer";
import { clearSceneFrameInfo, setSceneFrameInfo } from "./sceneDevState";
import styles from "./ScenePanel.module.css";

interface ScenePanelProps {
  panelId: string;
}

// A box label positioned in CSS pixels for the HTML overlay.
interface LabelPlacement {
  key: string;
  text: string;
  x: number;
  y: number;
}

function findChannel(sources: SourceMeta[], channelId: string): Channel | null {
  for (const s of sources) {
    const hit = s.channels.find((c) => c.id === channelId);
    if (hit) return hit;
  }
  return null;
}

// Largest index `i` with `times[i] <= cursor`, or -1 if cursor precedes the
// first frame. `times` is ascending (frame start timestamps).
function activeFrameIndex(times: BigInt64Array, cursorNs: bigint): number {
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
  | { kind: "before" } // cursor before the first frame
  | { kind: "ready"; points: number; boxes: number; paths: number };

export function ScenePanel({ panelId }: ScenePanelProps) {
  const sources = useSession((s) => s.sources);
  const binding = useSession((s) => s.sceneBindings[panelId] ?? null);
  const setSceneBinding = useSession((s) => s.setSceneBinding);
  // Following the cursor through a selector (not a manual store.subscribe) is
  // the pattern MapPanel uses: playback advances `cursorNs` at most once per
  // rAF, so this re-renders ≤1×/frame, and the effect below turns each change
  // into a (cheap) frame lookup that only refetches geometry on a frame change.
  const cursorNs = useSession((s) => s.cursorNs);

  const channel = binding === null ? null : findChannel(sources, binding);
  const channelId = channel?.id ?? null;
  const channelKind: ChannelKind | null = channel?.kind ?? null;
  const isBoxes = channelKind === "bounding_box";
  const isTraj = channelKind === "trajectory";
  const isEmpty = channelId === null;

  // Drop a stale persisted binding once sources exist but the channel is gone.
  useEffect(() => {
    if (sources.length === 0) return;
    if (binding !== null && channel === null) {
      setSceneBinding(panelId, null);
    }
  }, [binding, channel, panelId, setSceneBinding, sources.length]);

  const [status, setStatus] = useState<Status>({ kind: "loading" });
  // Box label placements, recomputed each render() via the onRender hook.
  const [labels, setLabels] = useState<LabelPlacement[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PointCloudRenderer | null>(null);
  // Frame start timestamps for the bound source (spins or box frames).
  const frameTimesRef = useRef<BigInt64Array | null>(null);
  const lastFrameRef = useRef<number>(-1);
  const framedRef = useRef<boolean>(false);
  const reqIdRef = useRef<number>(0);
  const channelIdRef = useRef<string | null>(channelId);
  channelIdRef.current = channelId;
  const isBoxesRef = useRef<boolean>(isBoxes);
  isBoxesRef.current = isBoxes;
  const isTrajRef = useRef<boolean>(isTraj);
  isTrajRef.current = isTraj;
  // The boxes shown for the active frame, kept so the onRender hook can
  // reproject their centres without re-decoding.
  const boxesRef = useRef<BoundingBox[]>([]);

  // Reproject every active box centre to screen pixels and push the visible
  // ones into `labels`. Called at the END of each renderer.render() (orbit /
  // zoom / resize) and after a fresh frame is uploaded.
  const placeLabels = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer || boxesRef.current.length === 0) {
      setLabels((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const next: LabelPlacement[] = [];
    boxesRef.current.forEach((b, i) => {
      // Label the top-face centre so the chip floats above the box.
      const p = renderer.project([
        b.center[0],
        b.center[1],
        b.center[2] + b.size[2] / 2,
      ]);
      if (!p.visible) return;
      next.push({ key: `${i}:${b.label}`, text: b.label, x: p.x, y: p.y });
    });
    setLabels(next);
  }, []);

  // Push the latest frame state into the dev-hook registry.
  const publish = useCallback(
    (over: Partial<Parameters<typeof setSceneFrameInfo>[1]>) => {
      setSceneFrameInfo(panelId, {
        boundChannelId: channelIdRef.current,
        pointCount: rendererRef.current?.pointCountValue() ?? 0,
        boxCount: rendererRef.current?.boxCountValue() ?? 0,
        trajectoryPathCount:
          rendererRef.current?.trajectoryPathCountValue() ?? 0,
        frameTsNs: null,
        spinIndex: lastFrameRef.current,
        spinCount: frameTimesRef.current?.length ?? 0,
        glOk: rendererRef.current !== null,
        error: null,
        ...over,
      });
    },
    [panelId],
  );

  // Recompute the active frame for the current cursor and, if it changed, fetch
  // + decode + upload it. Cheap no-op when the cursor stayed in-frame. Branches
  // on the bound channel kind: point cloud vs. bounding boxes.
  const updateFrame = useCallback(async () => {
    const renderer = rendererRef.current;
    const times = frameTimesRef.current;
    const id = channelIdRef.current;
    if (!renderer || !times || id === null) return;

    const cursorNs = useSession.getState().cursorNs;
    const idx = activeFrameIndex(times, cursorNs);
    if (idx === lastFrameRef.current) return; // same frame — nothing to do
    lastFrameRef.current = idx;

    if (idx < 0) {
      renderer.clearPoints();
      renderer.clearBoxes();
      renderer.clearTrajectories();
      boxesRef.current = [];
      placeLabels();
      setStatus({ kind: "before" });
      publish({
        pointCount: 0,
        boxCount: 0,
        trajectoryPathCount: 0,
        frameTsNs: null,
        spinIndex: -1,
      });
      return;
    }

    const reqId = ++reqIdRef.current;
    const ts = times[idx];
    mark("scene-frame:start");
    try {
      // Narrow window [ts, ts+1) returns exactly this frame (one row).
      const bytes = await useSession
        .getState()
        .fetchChannelRange(id, ts, ts + 1n, false);
      if (reqId !== reqIdRef.current || rendererRef.current !== renderer)
        return;

      if (isTrajRef.current) {
        const res = decodeTrajectories(bytes);
        if (!res.ok) {
          setStatus({ kind: "error", message: res.message });
          publish({ error: res.message });
          return;
        }
        // A trajectory source carries no point cloud, so the point-cloud
        // auto-frame never fires. Frame the camera to the path set once per
        // fresh binding (gated on `framedRef`, mirroring the box path).
        if (!framedRef.current && res.paths.length > 0) {
          renderer.frameToTrajectories(res.paths);
          framedRef.current = true;
        }
        renderer.setTrajectories(res.paths);
        // Trajectories carry no HTML labels; clear any stale box labels.
        boxesRef.current = [];
        placeLabels();
        setStatus({
          kind: "ready",
          points: 0,
          boxes: 0,
          paths: res.paths.length,
        });
        publish({
          trajectoryPathCount: res.paths.length,
          boxCount: 0,
          pointCount: 0,
          frameTsNs: (res.tsNs ?? ts).toString(),
          spinIndex: idx,
          error: null,
        });
        return;
      }

      if (isBoxesRef.current) {
        const res = decodeBoxes(bytes);
        if (!res.ok) {
          setStatus({ kind: "error", message: res.message });
          publish({ error: res.message });
          return;
        }
        // A bounding_box source carries no point cloud, so the point-cloud
        // auto-frame never fires. Frame the camera to the box set once per
        // fresh binding (gated on `framedRef`, mirroring the cloud path) so the
        // boxes are comfortably in view; manual orbiting afterwards is never
        // overridden.
        if (!framedRef.current && res.boxes.length > 0) {
          renderer.frameToBoxes(res.boxes);
          framedRef.current = true;
        }
        renderer.setBoxes(res.boxes);
        boxesRef.current = res.boxes;
        placeLabels();
        setStatus({
          kind: "ready",
          points: 0,
          boxes: res.boxes.length,
          paths: 0,
        });
        publish({
          boxCount: res.boxes.length,
          pointCount: 0,
          trajectoryPathCount: 0,
          frameTsNs: (res.tsNs ?? ts).toString(),
          spinIndex: idx,
          error: null,
        });
        return;
      }

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
      setStatus({ kind: "ready", points: res.count, boxes: 0, paths: 0 });
      publish({
        pointCount: res.count,
        trajectoryPathCount: 0,
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
  }, [publish, placeLabels]);

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
    // Re-glue the HTML labels at the end of every frame so they track the
    // camera during orbit / zoom / resize.
    renderer.setOnRender(() => placeLabels());
    renderer.resize(host.clientWidth, host.clientHeight);

    const ro = new ResizeObserver(() => {
      renderer.resize(host.clientWidth, host.clientHeight);
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      renderer.setOnRender(null);
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [isEmpty, publish, placeLabels]);

  // Load the bound source's frame timeline; reset per-binding state. Runs after
  // the renderer effect on the same commit, so an initial frame can paint.
  useEffect(() => {
    if (isEmpty || channelId === null) {
      clearSceneFrameInfo(panelId);
      return;
    }
    let aborted = false;
    lastFrameRef.current = -1;
    framedRef.current = false;
    frameTimesRef.current = null;
    boxesRef.current = [];
    setLabels([]);
    setStatus({ kind: "loading" });
    publish({
      pointCount: 0,
      boxCount: 0,
      trajectoryPathCount: 0,
      frameTsNs: null,
      spinIndex: -1,
      error: null,
    });

    void (async () => {
      try {
        const st = useSession.getState();
        const times = isTrajRef.current
          ? await st.trajectoryFrameTimes(channelId)
          : isBoxesRef.current
            ? await st.boxFrameTimes(channelId)
            : await st.lidarSpinTimes(channelId);
        if (aborted || channelIdRef.current !== channelId) return;
        frameTimesRef.current = times;
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

  // Follow the cursor: each `cursorNs` change runs the (cheap) frame lookup,
  // which only refetches geometry when the active frame actually changes. The
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
            Bind a point-cloud, bounding-box, or trajectory channel from the
            Panel drawer to render it here — a LiDAR cloud coloured by
            intensity, labelled 3D boxes, or predicted ego trajectories —
            stepping with the cursor.
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

        {isBoxes && labels.length > 0 && (
          <div className={styles.labelLayer} data-testid="scene-label-layer">
            {labels.map((l) => (
              <span
                key={l.key}
                className={styles.boxLabel}
                style={{
                  // Position at the projected pixel, then re-centre the chip
                  // horizontally and lift it above the box (matching the
                  // translate the CSS class would otherwise apply alone).
                  transform: `translate(${l.x}px, ${l.y}px) translate(-50%, -120%)`,
                }}
                data-testid="scene-box-label"
              >
                {l.text}
              </span>
            ))}
          </div>
        )}

        {status.kind === "loading" && (
          <div
            className={styles.statusOverlay}
            data-testid="scene-loading"
            role="status"
          >
            {isTraj
              ? "Loading trajectories…"
              : isBoxes
                ? "Loading boxes…"
                : "Loading point cloud…"}
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
            {isTraj
              ? "No predicted trajectory at this time."
              : isBoxes
                ? "No labelled frame at this time."
                : "No LiDAR spin at this time."}
          </div>
        )}

        <span className={styles.hint} data-testid="scene-hint">
          drag to orbit · scroll to zoom · shift-drag to pan
        </span>
        {status.kind === "ready" && isTraj && (
          <span className={styles.pointsPill} data-testid="scene-path-count">
            {status.paths.toLocaleString()} paths
          </span>
        )}
        {status.kind === "ready" && isBoxes && (
          <span className={styles.pointsPill} data-testid="scene-box-count">
            {status.boxes.toLocaleString()} boxes
          </span>
        )}
        {status.kind === "ready" && !isBoxes && !isTraj && (
          <span className={styles.pointsPill} data-testid="scene-points-count">
            {status.points.toLocaleString()} pts
          </span>
        )}
      </div>
    </section>
  );
}
