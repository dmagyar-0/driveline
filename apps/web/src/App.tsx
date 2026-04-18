import { useEffect, useRef, useState } from "react";
import { tableFromIPC } from "apache-arrow";
import { makeDataCoreClient, makeVideoDecodeClient } from "./workerClient";
import type { DataCoreApi, VideoDecodeApi } from "./workerClient";
import type { Remote } from "comlink";

// Dev-only hook surface. Playwright and DevTools use this for M1 smoke tests;
// real UI replaces it in M3+.
declare global {
  interface Window {
    __drivelineDevHooks?: {
      ping: () => Promise<string>;
      pingVideo: () => Promise<string>;
      fetchScalar: () => Promise<{ rows: number; sum: number }>;
    };
  }
}

export function App() {
  const dataCore = useRef<Remote<DataCoreApi> | null>(null);
  const videoDecode = useRef<Remote<VideoDecodeApi> | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    dataCore.current = makeDataCoreClient();
    videoDecode.current = makeVideoDecodeClient();

    window.__drivelineDevHooks = {
      ping: async () => (await dataCore.current!.ping()),
      pingVideo: async () => (await videoDecode.current!.ping()),
      fetchScalar: async () => {
        const bytes = await dataCore.current!.fetchRangeStub();
        const table = tableFromIPC(bytes);
        const value = table.getChild("value")!;
        let sum = 0;
        for (let i = 0; i < value.length; i++) sum += Number(value.get(i));
        return { rows: table.numRows, sum };
      },
    };
    setReady(true);
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Driveline</h1>
      <p>M1 Foundations skeleton.</p>
      <p data-testid="worker-status">{ready ? "workers ready" : "workers initialising"}</p>
    </main>
  );
}
