import { useEffect, useRef, useState } from "react";
import { tableFromIPC } from "apache-arrow";
import { makeDataCoreClient, makeVideoDecodeClient } from "./workerClient";
import type { DataCoreApi, Mf4Summary, VideoDecodeApi } from "./workerClient";
import type { Remote } from "comlink";

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

// Dev-only hook surface. Playwright and DevTools use this for M1 / M2 smoke
// tests; real UI replaces it in M3+.
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
