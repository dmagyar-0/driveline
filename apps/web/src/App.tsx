import { useEffect, useRef, useState } from "react";
import * as Comlink from "comlink";
import { makeDataCoreClient, makeVideoDecodeClient } from "./workerClient";
import type { DataCoreApi, VideoDecodeApi, WorkerCrash } from "./workerClient";
import type { Remote } from "comlink";
import { WorkerErrorBanner } from "./WorkerErrorBanner";
import { useSession } from "./state/store";
import { hasChannelDrag } from "./panels/channelDrag";
import { startPlaybackLoop } from "./timeline/playback";
import { Transport } from "./timeline/Transport";
import { Workspace } from "./layout/Workspace";
import type { WorkspaceHandle } from "./layout/Workspace";
import { attachLayoutPersistence } from "./layout/persist";
import { attachUiPersistence } from "./state/persist/ui";
import { attachNamedLayoutsPersistence } from "./state/persist/namedLayouts";
import { attachBookmarksPersistence } from "./state/persist/bookmarks";
import { attachEventTagConfigPersistence } from "./state/persist/eventTagConfig";
import { attachUrlState } from "./state/urlState";
import { installPerfHooks } from "./perf";
import { loadDemoSession } from "./demo/demoSession";
import { agentApiRequested, installAgentApi } from "./agent/agentApi";
import { installDevHooks } from "./devHooks";
// Re-export the dev-hook helper types from their previous `App.tsx` home so
// any existing importer keeps resolving (SHELL-01 relocated the definitions
// into `devHooks.ts`).
export type { OpenMf4Result, Mf4FetchResult, DevFileDesc } from "./devHooks";
import { Shell } from "./shell/Shell";

export function App() {
  const dataCore = useRef<Remote<DataCoreApi> | null>(null);
  const videoDecode = useRef<Remote<VideoDecodeApi> | null>(null);
  const workspaceRef = useRef<WorkspaceHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  // Fatal worker-crash state, kept LOCAL to App (not the Zustand store). The
  // first crash wins — a crashed worker can cascade into the other, and the
  // user only needs to know to reload once.
  const [workerCrash, setWorkerCrash] = useState<WorkerCrash | null>(null);

  useEffect(() => {
    // `setWorkerCrash` is a stable React setter, so capturing it inside this
    // mount-once effect is safe. Functional update keeps the first crash and
    // ignores any follow-on crashes from the cascading worker.
    const onCrash = (crash: WorkerCrash) =>
      setWorkerCrash((prev) => prev ?? crash);
    const { proxy: dc, worker: dcWorker } = makeDataCoreClient(onCrash);
    const { proxy: vd, worker: vdWorker } = makeVideoDecodeClient(onCrash);
    dataCore.current = dc;
    videoDecode.current = vd;
    useSession.getState().setWorker(dc);
    installPerfHooks();
    // T6.2 — start saving `layoutJson` / `videoBindings` / `plotBindings`
    // to localStorage on every change. The store was hydrated from the
    // same key at module load, so the first render already matches.
    const detachPersistence = attachLayoutPersistence(useSession);
    // Phase 1 — persist `activeRailTab` / `railCollapsed` to
    // `driveline.ui.v1` so the rail state survives reloads.
    const detachUiPersistence = attachUiPersistence(useSession);
    // Phase 4 — persist `namedLayouts` and `activeNamedLayoutId` to
    // `driveline.layouts.named.v1`. Saved layouts outlive a session.
    const detachNamedLayoutsPersistence =
      attachNamedLayoutsPersistence(useSession);
    // Phase 8 — persist `bookmarks` to `driveline.bookmarks.v1`.
    // Bookmarks outlive a session (same posture as `namedLayouts`).
    const detachBookmarksPersistence = attachBookmarksPersistence(useSession);
    // Phase 8 — persist the Event Tag config (attribute schema) to
    // `driveline.eventTags.config.v1`. Outlives a session like bookmarks.
    const detachEventTagConfigPersistence =
      attachEventTagConfigPersistence(useSession);
    // Shareable deep-link URL state. Attached AFTER the localStorage
    // persistence so a `#v=...` fragment wins over hydrated storage: it
    // applies the shared view on mount, then keeps the URL fragment current
    // (debounced) as the session evolves.
    const detachUrlState = attachUrlState();

    // Dev-only `window.__driveline*` hook surface, gated behind
    // `import.meta.env.DEV` so the ~60 store-mutating methods are
    // tree-shaken out of production builds and never reach `window` for end
    // users. Playwright e2e runs against the Vite dev server
    // (`pnpm --filter web dev`, see apps/e2e/playwright.config.ts), where
    // `import.meta.env.DEV` is `true`, so the specs keep their hooks. The
    // surface itself lives in `devHooks.ts` (SHELL-01); the names/shapes are
    // the stable Playwright contract.
    let uninstallDevHooks: (() => void) | undefined;
    if (import.meta.env.DEV) {
      uninstallDevHooks = installDevHooks({ dc, vd, workspaceRef });
    }
    // Agent interface — unlike the dev hooks above this ships in the
    // production bundle. The discovery trio (version/getSkill/describe) is
    // ALWAYS installed; the full mutating surface unlocks only with `?agent`
    // (or in DEV, so e2e and local automation get it for free). See
    // docs/11-agent-interface.md + docs/13-bring-your-own-agent.md.
    const uninstallAgentApi = installAgentApi(
      import.meta.env.DEV || agentApiRequested(window.location.search),
    );
    // Public deep-link: `?demo` starts the baked demo session on an empty
    // boot (the share-link view state lives in the hash, so the query is
    // ours). The loader waits for worker registration itself and no-ops if
    // a session already exists, so racing init here is safe.
    if (
      new URLSearchParams(window.location.search).has("demo") &&
      useSession.getState().sources.length === 0
    ) {
      void loadDemoSession();
    }
    setReady(true);
    return () => {
      uninstallAgentApi?.();
      detachPersistence();
      detachUiPersistence();
      detachNamedLayoutsPersistence();
      detachBookmarksPersistence();
      detachEventTagConfigPersistence();
      detachUrlState();
      // Removes the whole `window.__driveline*` dev surface (only installed in
      // DEV; `uninstallDevHooks` is undefined in prod, so this is a no-op).
      uninstallDevHooks?.();
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

  // A channel drag (drawer → plot panel) is handled by the target panel.
  // Ignore it at the shell level so it never trips the file-drop overlay or
  // gets mistaken for a session load — the shell only loads dropped *files*.
  const onDrop = async (e: React.DragEvent<HTMLElement>) => {
    if (hasChannelDrag(e.dataTransfer)) return;
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    await useSession.getState().openFiles(files);
  };

  const onDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (hasChannelDrag(e.dataTransfer)) return;
    e.preventDefault();
    setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent<HTMLElement>) => {
    if (hasChannelDrag(e.dataTransfer)) return;
    e.preventDefault();
    setDragActive(false);
  };

  return (
    <>
      {workerCrash && <WorkerErrorBanner crash={workerCrash} />}
      <Shell
        ready={ready}
        dragActive={dragActive}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        transport={<Transport />}
      >
        <Workspace ref={workspaceRef} />
      </Shell>
    </>
  );
}
