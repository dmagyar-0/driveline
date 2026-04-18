import * as Comlink from "comlink";
import type { DataCoreApi, Mf4ChannelInfo, Mf4Summary } from "./workers/dataCore.worker";
import type { VideoDecodeApi } from "./workers/videoDecode.worker";

export type { DataCoreApi, Mf4ChannelInfo, Mf4Summary, VideoDecodeApi };

export function makeDataCoreClient(): Comlink.Remote<DataCoreApi> {
  const worker = new Worker(
    new URL("./workers/dataCore.worker.ts", import.meta.url),
    { type: "module", name: "dataCore" },
  );
  return Comlink.wrap<DataCoreApi>(worker);
}

export function makeVideoDecodeClient(): Comlink.Remote<VideoDecodeApi> {
  const worker = new Worker(
    new URL("./workers/videoDecode.worker.ts", import.meta.url),
    { type: "module", name: "videoDecode" },
  );
  return Comlink.wrap<VideoDecodeApi>(worker);
}
