import { useEffect, useRef, useState } from "react";
import { tableFromIPC } from "apache-arrow";
import { makeDataCoreClient, makeVideoDecodeClient } from "./workerClient";
import type { DataCoreApi, Mf4Summary, VideoDecodeApi } from "./workerClient";
import type { Remote } from "comlink";
import { useSession } from "./state/store";
import type { OpenResult, SourceMeta, TimeRange } from "./state/store";
import { VideoPanel } from "./panels/VideoPanel";
import type { VideoHudSnapshot } from "./panels/VideoPanel";
import { startPlaybackLoop } from "./timeline/playback";
import { Transport } from "./timeline/Transport";
import { PlotPanel } from "./panels/PlotPanel";
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
    };
  }
}

function formatRange(r: TimeRange | null): string {
  if (!r) return "(empty)";
  return `[${r.startNs.toString()}, ${r.endNs.toString()})`;
}

// Pre-FlexLayout (T6.2) shim: mount VideoPanel for the first video channel
// found in the session, whether it comes from an MCAP or an mp4+sidecar
// source.
function FirstVideo() {
  const sources = useSession((s) => s.sources);
  for (const source of sources) {
    if (source.kind !== "mcap" && source.kind !== "mp4+sidecar") continue;
    const channel = source.channels.find((c) => c.kind === "video");
    if (!channel) continue;
    const sourceKind: "mcap" | "mp4" = source.kind === "mcap" ? "mcap" : "mp4";
    return (
      <section
        data-testid="video-panel-mount"
        style={{ width: "100%", aspectRatio: "16 / 9", maxWidth: 960 }}
      >
        <VideoPanel
          key={`${source.id}:${channel.id}`}
          sourceKind={sourceKind}
          sourceHandle={source.handle}
          channelId={channel.id}
        />
      </section>
    );
  }
  return null;
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
  const [ready, setReady] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [recentErrors, setRecentErrors] = useState<
    { name: string; reason: string }[]
  >([]);

  useEffect(() => {
    dataCore.current = makeDataCoreClient();
    videoDecode.current = makeVideoDecodeClient();
    useSession.getState().setWorker(dataCore.current);

    window.__drivelineDevHooks = {
      ping: async () => await dataCore.current!.ping(),
      pingVideo: async () => await videoDecode.current!.ping(),
      fetchScalar: async () => {
        const bytes = await dataCore.current!.fetchRangeStub();
        const table = tableFromIPC(bytes);
        const value = table.getChild("value")!;
        let sum = 0;
        for (let i = 0; i < value.length; i++) sum += Number(value.get(i));
        return { rows: table.numRows, sum };
      },
      openMf4: async (bytes) => {
        const handle = await dataCore.current!.openMf4(bytes);
        const summary = await dataCore.current!.mf4Summary(handle);
        return { handle, summary };
      },
      closeMf4: async (handle) => {
        await dataCore.current!.closeMf4(handle);
      },
      mf4FetchRange: async (handle, channelId, startNs, endNs, includePrev) => {
        const bytes = await dataCore.current!.mf4FetchRange(
          handle,
          channelId,
          startNs,
          endNs,
          includePrev,
          undefined,
        );
        const table = tableFromIPC(bytes);
        const ts = table.getChild("ts")!;
        const value = table.getChild("value")!;
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
    };
    setReady(true);
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
        Drop .mcap, .mf4, or .mp4 (+ .mp4.ts.bin) files here to load a session.
      </div>
      <SessionSummary />
      <FirstVideo />
      <PlotPanel />
      {recentErrors.length > 0 && (
        <ul className={styles.errors} data-testid="session-errors">
          {recentErrors.map((e, i) => (
            <li key={i}>
              {e.name}: {e.reason}
            </li>
          ))}
        </ul>
      )}
      <Transport />
    </main>
  );
}
