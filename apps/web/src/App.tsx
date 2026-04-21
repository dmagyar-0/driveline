import { useEffect, useRef, useState } from "react";
import { tableFromIPC } from "apache-arrow";
import * as Comlink from "comlink";
import { makeDataCoreClient, makeVideoDecodeClient } from "./workerClient";
import type { DataCoreApi, Mf4Summary, VideoDecodeApi } from "./workerClient";
import type { Remote } from "comlink";
import { useSession } from "./state/store";
import type { OpenResult, SourceMeta, TimeRange } from "./state/store";
import type { VideoHudSnapshot } from "./panels/VideoPanel";
import type { PlotSyncSnapshot } from "./panels/PlotPanel";
import { startPlaybackLoop } from "./timeline/playback";
import { Transport } from "./timeline/Transport";
import { Workspace } from "./layout/Workspace";
import type { WorkspaceHandle } from "./layout/Workspace";
import { attachLayoutPersistence } from "./layout/persist";
import { installPerfHooks } from "./perf";
import styles from "./App.module.css";

export interface OpenMf4Result {
  handle: number;
  summary: Mf4Summary;
}

export interface Mf4FetchResult {
  rows: number;
  tsSchema: string;
  valueSchema: string;
  firstTsNs: string;
  lastTsNs: string;
  valueSum: number;
}

export interface DevFileDesc {
  name: string;
  bytes: Uint8Array;
}

// Dev-only hook surface. Playwright drives all smoke tests and the T2.4
// `openFiles` drop test through this. The real `onDrop` handler calls
// exactly the same store action.
declare global {
  interface Window {
    __drivelineDevHooks?: {
      ping: () => Promise<string>;
      pingVideo: () => Promise<string>;
      fetchScalar: () => Promise<{ rows: number; sum: number }>;
      openMf4: (bytes: Uint8Array) => Promise<OpenMf4Result>;
      closeMf4: (handle: number) => Promise<void>;
      mf4FetchRange: (
        handle: number,
        channelId: string,
        startNs: bigint,
        endNs: bigint,
        includePrev: boolean,
      ) => Promise<Mf4FetchResult>;
      openFiles: (files: DevFileDesc[]) => Promise<OpenResult>;
      clearSession: () => Promise<void>;
      videoLastBlitPtsNs: () => bigint | null;
      // T5.2 — serialised HUD snapshot so Playwright can assert seek
      // settles without pixel compare. BigInt → string for `page.evaluate`.
      videoHudStats: () => {
        ptsNs: string | null;
        frameIndex: number;
        decodeQueue: number;
        blitQueueLen: number;
        dropped: number;
        codec: string | null;
        hudOn: boolean;
      } | null;
      // Read-only snapshot for e2e (T3.2). BigInts serialised as strings
      // so the value survives `page.evaluate`.
      getSessionSnapshot: () => {
        cursorNs: string;
        playing: boolean;
        speed: number;
        globalRange: { startNs: string; endNs: string } | null;
      };
      // T6.2 — expose layout + panel-add actions for future e2e driving.
      // `getLayoutJson` returns a serialised snapshot; `setLayoutJson`
      // replaces it wholesale; the add methods create a new FlexLayout
      // tab (video/plot) with a fresh panel id.
      getLayoutJson: () => string;
      setLayoutJson: (json: unknown | null) => void;
      addVideoPanel: (channelId?: string) => string | undefined;
      addPlotPanel: () => string | undefined;
      resetLayout: () => void;
      // T6.1 — bind panels programmatically and read the per-panel
      // sync snapshot so e2e specs can assert the cross-panel
      // "PTS/ts ≤ cursor" invariant without driving the picker UI.
      setVideoChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      addPlotChannelBinding: (panelId: string, channelId: string) => void;
      getPlotPanelSync: (panelId: string) => {
        cursorNs: string;
        boundChannelIds: string[];
        lastFetchedRange: { startNs: string; endNs: string } | null;
        sampleAtCursor: Array<
          { channelId: string; tsNs: string; value: number } | null
        >;
      } | null;
      // T6.3 — per-series min/max stats over the most recent render for
      // `signalAlignment.spec.ts`.
      getPlotPanelSeriesStats: (panelId: string) => Array<{
        channelId: string;
        min: number;
        max: number;
        count: number;
      }> | null;
      // T6.3 — enumerate channels without exposing the Zustand store.
      listChannels: () => Array<{
        id: string;
        sourceId: string;
        name: string;
        kind: string;
        dtype: string | null;
        unit: string | null;
        sampleCount: number;
      }>;
    };
  }
}

function formatRange(r: TimeRange | null): string {
  if (!r) return "(empty)";
  return `[${r.startNs.toString()}, ${r.endNs.toString()})`;
}

function SessionSummary() {
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  return (
    <section data-testid="session-summary">
      <p className={styles.global} data-testid="global-range">
        Global range: {formatRange(globalRange)}
      </p>
      <p data-testid="source-count">Sources: {sources.length}</p>
      <ul className={styles.sources} data-testid="sources">
        {sources.map((s: SourceMeta) => (
          <li
            key={s.id}
            className={styles.source}
            data-testid={`source-${s.id}`}
          >
            <div className={styles.sourceHeader}>
              <span className={styles.sourceName} data-testid="source-name">
                {s.name}
              </span>
              <span className={styles.sourceKind}>{s.kind}</span>
            </div>
            <p className={styles.meta}>
              <span data-testid="channel-count">
                {s.channels.length} channel{s.channels.length === 1 ? "" : "s"}
              </span>
              {" · "}
              <span data-testid="source-range">{formatRange(s.timeRange)}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function App() {
  const dataCore = useRef<Remote<DataCoreApi> | null>(null);
  const videoDecode = useRef<Remote<VideoDecodeApi> | null>(null);
  const workspaceRef = useRef<WorkspaceHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [recentErrors, setRecentErrors] = useState<
    { name: string; reason: string }[]
  >([]);

  useEffect(() => {
    const { proxy: dc, worker: dcWorker } = makeDataCoreClient();
    const { proxy: vd, worker: vdWorker } = makeVideoDecodeClient();
    dataCore.current = dc;
    videoDecode.current = vd;
    useSession.getState().setWorker(dc);
    installPerfHooks();
    // T6.2 — start saving `layoutJson` / `videoBindings` / `plotBindings`
    // to localStorage on every change. The store was hydrated from the
    // same key at module load, so the first render already matches.
    const detachPersistence = attachLayoutPersistence(useSession);

    window.__drivelineDevHooks = {
      ping: async () => await dc.ping(),
      pingVideo: async () => await vd.ping(),
      fetchScalar: async () => {
        const bytes = await dc.fetchRangeStub();
        const table = tableFromIPC(bytes);
        const value = table.getChild("value");
        if (!value) throw new Error("arrow table missing 'value' column");
        let sum = 0;
        for (let i = 0; i < value.length; i++) sum += Number(value.get(i));
        return { rows: table.numRows, sum };
      },
      openMf4: async (bytes) => {
        const handle = await dc.openMf4(bytes);
        const summary = await dc.mf4Summary(handle);
        return { handle, summary };
      },
      closeMf4: async (handle) => {
        await dc.closeMf4(handle);
      },
      mf4FetchRange: async (handle, channelId, startNs, endNs, includePrev) => {
        const bytes = await dc.mf4FetchRange(
          handle,
          channelId,
          startNs,
          endNs,
          includePrev,
        );
        const table = tableFromIPC(bytes);
        const ts = table.getChild("ts");
        if (!ts) throw new Error("arrow table missing 'ts' column");
        const value = table.getChild("value");
        if (!value) throw new Error("arrow table missing 'value' column");
        let valueSum = 0;
        for (let i = 0; i < value.length; i++) valueSum += Number(value.get(i));
        return {
          rows: table.numRows,
          tsSchema: table.schema.fields[0].type.toString(),
          valueSchema: table.schema.fields[1].type.toString(),
          firstTsNs: String(ts.get(0)),
          lastTsNs: String(ts.get(ts.length - 1)),
          valueSum,
        };
      },
      openFiles: async (descs) => {
        const files = descs.map(
          (d) => new File([d.bytes as BlobPart], d.name),
        );
        const result = await useSession.getState().openFiles(files);
        setRecentErrors(result.errors);
        return result;
      },
      clearSession: async () => {
        await useSession.getState().clear();
        setRecentErrors([]);
      },
      videoLastBlitPtsNs: () => window.__drivelineVideoLastBlitPtsNs ?? null,
      videoHudStats: () => {
        const h: VideoHudSnapshot | undefined = window.__drivelineVideoHud;
        if (!h) return null;
        return {
          ptsNs: h.ptsNs === null ? null : h.ptsNs.toString(),
          frameIndex: h.frameIndex,
          decodeQueue: h.decodeQueue,
          blitQueueLen: h.blitQueueLen,
          dropped: h.dropped,
          codec: h.codec,
          hudOn: h.hudOn,
        };
      },
      getSessionSnapshot: () => {
        const s = useSession.getState();
        return {
          cursorNs: s.cursorNs.toString(),
          playing: s.playing,
          speed: s.speed,
          globalRange: s.globalRange
            ? {
                startNs: s.globalRange.startNs.toString(),
                endNs: s.globalRange.endNs.toString(),
              }
            : null,
        };
      },
      getLayoutJson: () =>
        JSON.stringify(useSession.getState().layoutJson),
      setLayoutJson: (json) => useSession.getState().setLayoutJson(json),
      addVideoPanel: (channelId) =>
        workspaceRef.current?.addVideoPanel(channelId),
      addPlotPanel: () => workspaceRef.current?.addPlotPanel(),
      resetLayout: () => workspaceRef.current?.resetLayout(),
      setVideoChannelBinding: (panelId, channelId) =>
        useSession.getState().setVideoBinding(panelId, channelId),
      addPlotChannelBinding: (panelId, channelId) =>
        useSession.getState().addPlotChannel(panelId, channelId),
      getPlotPanelSync: (panelId) => {
        const snap: PlotSyncSnapshot | undefined =
          window.__drivelinePlotPanels?.[panelId];
        if (!snap) return null;
        return {
          cursorNs: snap.cursorNs.toString(),
          boundChannelIds: [...snap.boundChannelIds],
          lastFetchedRange: snap.lastFetchedRange
            ? {
                startNs: snap.lastFetchedRange.startNs.toString(),
                endNs: snap.lastFetchedRange.endNs.toString(),
              }
            : null,
          sampleAtCursor: snap.sampleAtCursor.map((s) =>
            s === null
              ? null
              : {
                  channelId: s.channelId,
                  tsNs: s.tsNs.toString(),
                  value: s.value,
                },
          ),
        };
      },
      getPlotPanelSeriesStats: (panelId) => {
        const snap: PlotSyncSnapshot | undefined =
          window.__drivelinePlotPanels?.[panelId];
        if (!snap) return null;
        return snap.seriesStats.map((s) => ({
          channelId: s.channelId,
          min: s.min,
          max: s.max,
          count: s.count,
        }));
      },
      listChannels: () =>
        useSession.getState().channels.map((c) => ({
          id: c.id,
          sourceId: c.sourceId,
          name: c.name,
          kind: c.kind,
          dtype: c.dtype,
          unit: c.unit,
          sampleCount: c.sampleCount,
        })),
    };
    setReady(true);
    return () => {
      detachPersistence();
      delete window.__drivelineDevHooks;
      useSession.getState().setWorker(null);
      dataCore.current = null;
      videoDecode.current = null;
      dc[Comlink.releaseProxy]();
      vd[Comlink.releaseProxy]();
      dcWorker.terminate();
      vdWorker.terminate();
    };
  }, []);

  // T3.3 · Drive `cursorNs` forward in real time while `playing`. The
  // loop only reads/writes the existing store actions; its lifetime is
  // tied to the App component.
  useEffect(() => startPlaybackLoop(useSession), []);

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const result = await useSession.getState().openFiles(files);
    setRecentErrors(result.errors);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
  };

  return (
    <main className={styles.shell}>
      <h1>Driveline</h1>
      <p data-testid="worker-status">
        {ready ? "workers ready" : "workers initialising"}
      </p>
      <div
        className={`${styles.dropZone} ${dragActive ? styles.dropZoneActive : ""}`}
        data-testid="drop-zone"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        Drop .mcap, .mf4, or .mp4 (+ .mp4.timestamps) files here to load a session.
      </div>
      <SessionSummary />
      {recentErrors.length > 0 && (
        <ul className={styles.errors} data-testid="session-errors">
          {recentErrors.map((e, i) => (
            <li key={i}>
              {e.name}: {e.reason}
            </li>
          ))}
        </ul>
      )}
      <Workspace ref={workspaceRef} />
      <Transport />
    </main>
  );
}
