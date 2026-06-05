import * as Comlink from "comlink";
import type {
  ChannelKindWire,
  DataCoreApi,
  EncodedChunkWire,
  McapChannelInfo,
  McapSummary,
  Mf4ChannelInfo,
  Mf4Summary,
  Mp4SidecarChannelInfo,
  Mp4SidecarIndex,
  Mp4SidecarSummary,
} from "./workers/dataCore.worker";
import type { VideoDecodeApi } from "./workers/videoDecode.worker";

export type {
  ChannelKindWire,
  DataCoreApi,
  EncodedChunkWire,
  McapChannelInfo,
  McapSummary,
  Mf4ChannelInfo,
  Mf4Summary,
  Mp4SidecarChannelInfo,
  Mp4SidecarIndex,
  Mp4SidecarSummary,
  VideoDecodeApi,
};

export interface DataCoreClient {
  proxy: Comlink.Remote<DataCoreApi>;
  worker: Worker;
}

export interface VideoDecodeClient {
  proxy: Comlink.Remote<VideoDecodeApi>;
  worker: Worker;
}

/**
 * Reported when a worker dies unexpectedly — an uncaught error, a WASM trap,
 * or an OOM kill. Once a worker is gone its Comlink proxy silently hangs
 * forever (the underlying `MessagePort` has no peer), so the app must treat
 * this as fatal and prompt a reload. `name` identifies which worker crashed;
 * `message` is the best-effort detail from the originating event.
 */
export interface WorkerCrash {
  name: "dataCore" | "videoDecode";
  message: string;
}

/**
 * Attach crash detection to a freshly-constructed worker. `onerror` fires for
 * uncaught errors / WASM traps inside the worker; `onmessageerror` fires when
 * a message can't be deserialised (a structured-clone failure that also leaves
 * the Comlink channel unusable). Both are terminal for our purposes, so we
 * surface a single `WorkerCrash` and let the caller show the reload banner.
 */
function attachCrashHandlers(
  worker: Worker,
  name: WorkerCrash["name"],
  onCrash?: (crash: WorkerCrash) => void,
): void {
  if (!onCrash) return;
  worker.onerror = (event: ErrorEvent) => {
    onCrash({
      name,
      message: event.message || `${name} worker crashed`,
    });
  };
  worker.onmessageerror = () => {
    onCrash({
      name,
      message: `${name} worker sent an undeserialisable message`,
    });
  };
}

export function makeDataCoreClient(
  onCrash?: (crash: WorkerCrash) => void,
): DataCoreClient {
  const worker = new Worker(
    new URL("./workers/dataCore.worker.ts", import.meta.url),
    { type: "module", name: "dataCore" },
  );
  attachCrashHandlers(worker, "dataCore", onCrash);
  return { proxy: Comlink.wrap<DataCoreApi>(worker), worker };
}

export function makeVideoDecodeClient(
  onCrash?: (crash: WorkerCrash) => void,
): VideoDecodeClient {
  const worker = new Worker(
    new URL("./workers/videoDecode.worker.ts", import.meta.url),
    { type: "module", name: "videoDecode" },
  );
  attachCrashHandlers(worker, "videoDecode", onCrash);
  return { proxy: Comlink.wrap<VideoDecodeApi>(worker), worker };
}
