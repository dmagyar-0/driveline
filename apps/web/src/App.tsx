import { useEffect, useRef, useState } from "react";
import { tableFromIPC } from "apache-arrow";
import * as Comlink from "comlink";
import { makeDataCoreClient, makeVideoDecodeClient } from "./workerClient";
import type { DataCoreApi, Mf4Summary, VideoDecodeApi } from "./workerClient";
import type { Remote } from "comlink";
import { useSession } from "./state/store";
import type { OpenResult } from "./state/store";
import type { RailTab } from "./state/persist/ui";
import type { MapBinding } from "./layout/persist";
import type { VideoHudSnapshot } from "./panels/VideoPanel";
import type { PlotSyncSnapshot } from "./panels/PlotPanel";
import { getReadinessSnapshot } from "./panels/videoReadiness";
import { isCursorGated, startPlaybackLoop } from "./timeline/playback";
import { Transport } from "./timeline/Transport";
import { Workspace } from "./layout/Workspace";
import type { WorkspaceHandle } from "./layout/Workspace";
import { attachLayoutPersistence } from "./layout/persist";
import { attachUiPersistence } from "./state/persist/ui";
import { attachNamedLayoutsPersistence } from "./state/persist/namedLayouts";
import { attachBookmarksPersistence } from "./state/persist/bookmarks";
import { installPerfHooks } from "./perf";
import { Shell } from "./shell/Shell";

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

// Dev-only hook surface. Playwright drives all smoke tests and the
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
      // Serialised HUD snapshot so Playwright can assert seek settles
      // without pixel compare. BigInt → string for `page.evaluate`.
      videoHudStats: () => {
        ptsNs: string | null;
        frameIndex: number;
        decodeQueue: number;
        blitQueueLen: number;
        dropped: number;
        codec: string | null;
        hudOn: boolean;
      } | null;
      // Read-only snapshot for e2e. BigInts serialised as strings so the
      // value survives `page.evaluate`.
      getSessionSnapshot: () => {
        cursorNs: string;
        playing: boolean;
        speed: number;
        globalRange: { startNs: string; endNs: string } | null;
      };
      // Layout + panel-add actions for e2e. `getLayoutJson` returns a
      // serialised snapshot; `setLayoutJson` replaces wholesale; the
      // add methods create a new FlexLayout tab with a fresh panel id.
      getLayoutJson: () => string;
      setLayoutJson: (json: unknown | null) => void;
      addVideoPanel: (channelId?: string) => string | undefined;
      addPlotPanel: () => string | undefined;
      // Each addXPanel returns the freshly-minted tab id so e2e specs can
      // correlate the binding flow with the new panel.
      addScenePanel: () => string | undefined;
      addMapPanel: () => string | undefined;
      addTablePanel: () => string | undefined;
      addEnumPanel: () => string | undefined;
      resetLayout: () => void;
      // Programmatic bindings + per-panel sync snapshot so e2e specs can
      // assert the cross-panel "PTS/ts ≤ cursor" invariant without
      // driving the picker UI.
      setVideoChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      addPlotChannelBinding: (panelId: string, channelId: string) => void;
      setSceneChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      setMapChannelBinding: (
        panelId: string,
        binding: MapBinding | null,
      ) => void;
      addTableChannelBinding: (panelId: string, channelId: string) => void;
      removeTableChannelBinding: (panelId: string, channelId: string) => void;
      setEnumChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      getPlotPanelSync: (panelId: string) => {
        cursorNs: string;
        boundChannelIds: string[];
        lastFetchedRange: { startNs: string; endNs: string } | null;
        sampleAtCursor: Array<{
          channelId: string;
          tsNs: string;
          value: number;
        } | null>;
      } | null;
      // Per-series min/max stats over the most recent render
      // (`signalAlignment.spec.ts`).
      getPlotPanelSeriesStats: (panelId: string) => Array<{
        channelId: string;
        min: number;
        max: number;
        count: number;
      }> | null;
      // Enumerate channels without exposing the Zustand store.
      listChannels: () => Array<{
        id: string;
        sourceId: string;
        name: string;
        kind: string;
        dtype: string | null;
        unit: string | null;
        sampleCount: number;
      }>;
      // Resolve the qualified channel id from a per-source native id.
      // `sourceName` is matched against `SourceMeta.name` — equality
      // first, substring fallback so `"short.mp4 (2)"` still resolves
      // when a re-run collides on the base name. Returns null if no
      // source/channel matches.
      findChannelId: (q: {
        sourceName: string;
        nativeId: string;
      }) => string | null;
      // Enumerate loaded sources and the session's global range.
      // BigInts serialised as decimal strings so `page.evaluate` can
      // return them.
      listSources: () => Array<{
        id: string;
        kind: "mcap" | "mf4" | "mp4+sidecar";
        name: string;
        timeRange: { startNs: string; endNs: string };
        channelIds: string[];
      }>;
      getGlobalRange: () => { startNs: string; endNs: string } | null;
      // Rail/drawer state seam.
      setActiveRailTab: (tab: RailTab | null) => void;
      getActiveRailTab: () => RailTab | null;
      setRailCollapsed: (collapsed: boolean) => void;
      // Panel marked active for click-to-bind in the Channels / Panel
      // drawers.
      setSelectedPanelId: (id: string | null) => void;
      getSelectedPanelId: () => string | null;
      // Read the per-panel HUD overlay bit straight from the store,
      // decoupled from the rAF-published `__drivelineVideoHud` snapshot
      // so persistence-survival e2e doesn't have to wait for a
      // VideoPanel remount + republish after reload.
      getVideoHudOn: (panelId: string) => boolean;
      // Saved-layout actions. `listNamedLayouts` deliberately omits the
      // heavy `layoutJson` and binding maps — tests assert on
      // names/live/active.
      saveCurrentLayoutAs: (name: string) => string;
      restoreNamedLayout: (id: string) => void;
      listNamedLayouts: () => Array<{
        id: string;
        name: string;
        createdAt: number;
        isLive: boolean;
        isActive: boolean;
      }>;
      // Bookmark actions. `addBookmarkAtCursor` returns the new id, or
      // `null` when no fixture is loaded. `listBookmarks` serialises
      // `ns` as a decimal string (matches `getSessionSnapshot`).
      addBookmarkAtCursor: (label?: string) => string | null;
      listBookmarks: () => Array<{
        id: string;
        ns: string;
        label: string;
        color: string;
        createdAt: number;
      }>;
      removeBookmark: (id: string) => void;
      renameBookmark: (id: string, label: string) => void;
      // Decode-aware cursor gating. `getVideoReadiness` returns the
      // per-panel state of every entry in the readiness registry;
      // `getCursorGated` returns the most recent gate decision from
      // `playback.ts`'s tick. Read-only Playwright seams.
      getVideoReadiness: () => Array<{
        panelId: string;
        state: "ready" | "waiting" | "stalled" | "absent";
        lastReadyMs: number;
        waitingSinceMs: number | null;
        lastBlitPtsNs: string | null;
      }>;
      getCursorGated: () => boolean;
      // Seed synthetic offset segments so the screenshot spec can
      // exercise the segment-tick path without building real
      // multi-segment fixtures. Test-only — do NOT use in production
      // code. Segment ranges are short enough to stay inside
      // `Number.MAX_SAFE_INTEGER`.
      seedSegmentsForScreenshot: (
        segments: { start: number; end: number; name: string }[],
      ) => void;
      // Synchronous cursor seek. Accepts a `bigint` (the store's native
      // unit) or a finite `number` (decimal ns, converted via
      // `BigInt(Math.round(n))`). Anything else is ignored. Clamps and
      // seek-epoch bumping happen in the store.
      setCursorNs: (ns: bigint | number) => void;
      // Direct setter for the time-display mode — screenshot specs
      // shouldn't depend on the chip's currently-visible label.
      setTimeMode: (mode: "relative" | "absolute") => void;
    };
  }
}

export function App() {
  const dataCore = useRef<Remote<DataCoreApi> | null>(null);
  const videoDecode = useRef<Remote<VideoDecodeApi> | null>(null);
  const workspaceRef = useRef<WorkspaceHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    const { proxy: dc, worker: dcWorker } = makeDataCoreClient();
    const { proxy: vd, worker: vdWorker } = makeVideoDecodeClient();
    dataCore.current = dc;
    videoDecode.current = vd;
    useSession.getState().setWorker(dc);
    installPerfHooks();
    // Persistence subscribers — each writes its slice to localStorage on
    // every change. Stores were hydrated from the same keys at module
    // load, so the first render already matches.
    const detachPersistence = attachLayoutPersistence(useSession);
    const detachUiPersistence = attachUiPersistence(useSession);
    const detachNamedLayoutsPersistence =
      attachNamedLayoutsPersistence(useSession);
    const detachBookmarksPersistence = attachBookmarksPersistence(useSession);

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
        const files = descs.map((d) => new File([d.bytes as BlobPart], d.name));
        return await useSession.getState().openFiles(files);
      },
      clearSession: async () => {
        await useSession.getState().clear();
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
      getLayoutJson: () => JSON.stringify(useSession.getState().layoutJson),
      setLayoutJson: (json) => useSession.getState().setLayoutJson(json),
      addVideoPanel: (channelId) =>
        workspaceRef.current?.addVideoPanel(channelId),
      addPlotPanel: () => workspaceRef.current?.addPlotPanel(),
      addScenePanel: () => workspaceRef.current?.addScenePanel(),
      addMapPanel: () => workspaceRef.current?.addMapPanel(),
      addTablePanel: () => workspaceRef.current?.addTablePanel(),
      addEnumPanel: () => workspaceRef.current?.addEnumPanel(),
      resetLayout: () => workspaceRef.current?.resetLayout(),
      setVideoChannelBinding: (panelId, channelId) =>
        useSession.getState().setVideoBinding(panelId, channelId),
      addPlotChannelBinding: (panelId, channelId) =>
        useSession.getState().addPlotChannel(panelId, channelId),
      setSceneChannelBinding: (panelId, channelId) =>
        useSession.getState().setSceneBinding(panelId, channelId),
      setMapChannelBinding: (panelId, binding) =>
        useSession.getState().setMapBinding(panelId, binding),
      addTableChannelBinding: (panelId, channelId) =>
        useSession.getState().addTableChannel(panelId, channelId),
      removeTableChannelBinding: (panelId, channelId) =>
        useSession.getState().removeTableChannel(panelId, channelId),
      setEnumChannelBinding: (panelId, channelId) =>
        useSession.getState().setEnumBinding(panelId, channelId),
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
      findChannelId: ({ sourceName, nativeId }) => {
        const sources = useSession.getState().sources;
        const exact = sources.find((s) => s.name === sourceName);
        const src =
          exact ?? sources.find((s) => s.name.includes(sourceName)) ?? null;
        if (!src) return null;
        const ch = src.channels.find((c) => c.nativeId === nativeId);
        return ch?.id ?? null;
      },
      listSources: () =>
        useSession.getState().sources.map((s) => ({
          id: s.id,
          kind: s.kind,
          name: s.name,
          timeRange: {
            startNs: s.timeRange.startNs.toString(),
            endNs: s.timeRange.endNs.toString(),
          },
          channelIds: s.channels.map((c) => c.id),
        })),
      getGlobalRange: () => {
        const r = useSession.getState().globalRange;
        return r === null
          ? null
          : { startNs: r.startNs.toString(), endNs: r.endNs.toString() };
      },
      setActiveRailTab: (tab) => useSession.getState().setActiveRailTab(tab),
      getActiveRailTab: () => useSession.getState().activeRailTab,
      setRailCollapsed: (collapsed) =>
        useSession.getState().setRailCollapsed(collapsed),
      setSelectedPanelId: (id) => useSession.getState().setSelectedPanelId(id),
      getSelectedPanelId: () => useSession.getState().selectedPanelId,
      getVideoHudOn: (panelId) =>
        useSession.getState().videoHudOn[panelId] ?? false,
      saveCurrentLayoutAs: (name) =>
        useSession.getState().saveCurrentLayoutAs(name),
      restoreNamedLayout: (id) => useSession.getState().restoreNamedLayout(id),
      listNamedLayouts: () => {
        const st = useSession.getState();
        const currentJsonStr = JSON.stringify(st.layoutJson ?? null);
        return st.namedLayouts.map((l) => ({
          id: l.id,
          name: l.name,
          createdAt: l.createdAt,
          isLive: JSON.stringify(l.layoutJson ?? null) === currentJsonStr,
          isActive: st.activeNamedLayoutId === l.id,
        }));
      },
      addBookmarkAtCursor: (label) =>
        useSession.getState().addBookmarkAtCursor(label),
      listBookmarks: () =>
        useSession.getState().bookmarks.map((b) => ({
          id: b.id,
          ns: b.ns.toString(),
          label: b.label,
          color: b.color,
          createdAt: b.createdAt,
        })),
      removeBookmark: (id) => useSession.getState().removeBookmark(id),
      renameBookmark: (id, label) =>
        useSession.getState().renameBookmark(id, label),
      getVideoReadiness: () => {
        const out: Array<{
          panelId: string;
          state: "ready" | "waiting" | "stalled" | "absent";
          lastReadyMs: number;
          waitingSinceMs: number | null;
          lastBlitPtsNs: string | null;
        }> = [];
        for (const [panelId, r] of getReadinessSnapshot()) {
          out.push({
            panelId,
            state: r.state,
            lastReadyMs: r.lastReadyMs,
            waitingSinceMs: r.waitingSinceMs,
            lastBlitPtsNs:
              r.lastBlitPtsNs === null ? null : r.lastBlitPtsNs.toString(),
          });
        }
        return out;
      },
      getCursorGated: () => isCursorGated(),
      setCursorNs: (ns) => {
        let asBigInt: bigint;
        if (typeof ns === "bigint") {
          asBigInt = ns;
        } else if (typeof ns === "number" && Number.isFinite(ns)) {
          asBigInt = BigInt(Math.round(ns));
        } else {
          return;
        }
        useSession.getState().setCursor(asBigInt);
      },
      setTimeMode: (mode) => useSession.getState().setTimeMode(mode),
      seedSegmentsForScreenshot: (segments) => {
        const sources = segments.map((s, i) => ({
          id: `${s.name}#${i}`,
          kind: "mcap" as const,
          name: s.name,
          handle: -1 - i,
          timeRange: {
            startNs: BigInt(s.start),
            endNs: BigInt(s.end),
          },
          channels: [],
        }));
        let startNs = sources[0]?.timeRange.startNs ?? 0n;
        let endNs = sources[0]?.timeRange.endNs ?? 0n;
        for (const s of sources) {
          if (s.timeRange.startNs < startNs) startNs = s.timeRange.startNs;
          if (s.timeRange.endNs > endNs) endNs = s.timeRange.endNs;
        }
        useSession.setState({
          sources,
          channels: [],
          globalRange: { startNs, endNs },
          cursorNs: startNs,
        });
      },
    };
    setReady(true);
    return () => {
      detachPersistence();
      detachUiPersistence();
      detachNamedLayoutsPersistence();
      detachBookmarksPersistence();
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

  // Drive `cursorNs` forward in real time while `playing`. The loop
  // only reads/writes the existing store actions; lifetime is tied to
  // the App component.
  useEffect(() => startPlaybackLoop(useSession), []);

  const onDrop = async (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    await useSession.getState().openFiles(files);
  };

  const onDragOver = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragActive(false);
  };

  // The Channels drawer auto-adds a plot panel when the user clicks a
  // channel with no panel selected. App owns `workspaceRef` and
  // forwards a narrow callback so Shell/Drawer/LayoutDrawer don't have
  // to know about the FlexLayout ref. `addPlotPanel` mutates the
  // FlexLayout model and returns the new tab id synchronously.
  const ensurePlotPanel = (): string | null =>
    workspaceRef.current?.addPlotPanel() ?? null;

  const addVideoPanel = (): void => {
    workspaceRef.current?.addVideoPanel();
  };
  const addPlotPanel = (): void => {
    workspaceRef.current?.addPlotPanel();
  };
  const addScenePanel = (): void => {
    workspaceRef.current?.addScenePanel();
  };
  const addMapPanel = (): void => {
    workspaceRef.current?.addMapPanel();
  };
  const addTablePanel = (): void => {
    workspaceRef.current?.addTablePanel();
  };
  const addEnumPanel = (): void => {
    workspaceRef.current?.addEnumPanel();
  };
  const resetLayout = (): void => {
    workspaceRef.current?.resetLayout();
  };

  return (
    <Shell
      ready={ready}
      dragActive={dragActive}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      ensurePlotPanel={ensurePlotPanel}
      addVideoPanel={addVideoPanel}
      addPlotPanel={addPlotPanel}
      addScenePanel={addScenePanel}
      addMapPanel={addMapPanel}
      addTablePanel={addTablePanel}
      addEnumPanel={addEnumPanel}
      resetLayout={resetLayout}
      transport={<Transport />}
    >
      <Workspace ref={workspaceRef} />
    </Shell>
  );
}
