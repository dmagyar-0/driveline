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

export function makeDataCoreClient(): DataCoreClient {
  const worker = new Worker(
    new URL("./workers/dataCore.worker.ts", import.meta.url),
    { type: "module", name: "dataCore" },
  );
  return { proxy: Comlink.wrap<DataCoreApi>(worker), worker };
}

export function makeVideoDecodeClient(): VideoDecodeClient {
  const worker = new Worker(
    new URL("./workers/videoDecode.worker.ts", import.meta.url),
    { type: "module", name: "videoDecode" },
  );
  return { proxy: Comlink.wrap<VideoDecodeApi>(worker), worker };
}
