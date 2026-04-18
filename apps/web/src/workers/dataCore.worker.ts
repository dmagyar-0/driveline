import * as Comlink from "comlink";
import init, {
  ping as wasmPing,
  fetch_range_stub,
  open_mf4,
  close_mf4,
  mf4_summary,
  mf4_fetch_range,
} from "../wasm/wasm_bindings.js";

// Register the Comlink listener BEFORE awaiting wasm init. A top-level await
// here would suspend module evaluation; any messages posted by the main
// thread during that window fire on an empty listener list and are lost.
// Each API method awaits the init promise instead.
const ready = init();

export interface Mf4ChannelInfo {
  id: string;
  name: string;
  unit: string | null;
  sample_count: number;
  start_ns: bigint;
  end_ns: bigint;
}

export interface Mf4Summary {
  start_ns: bigint;
  end_ns: bigint;
  channels: Mf4ChannelInfo[];
}

export const dataCoreApi = {
  async ping(): Promise<string> {
    await ready;
    return wasmPing();
  },
  async fetchRangeStub(): Promise<Uint8Array> {
    await ready;
    return fetch_range_stub();
  },
  async openMf4(bytes: Uint8Array): Promise<number> {
    await ready;
    return open_mf4(bytes);
  },
  async closeMf4(handle: number): Promise<void> {
    await ready;
    close_mf4(handle);
  },
  async mf4Summary(handle: number): Promise<Mf4Summary> {
    await ready;
    return mf4_summary(handle) as Mf4Summary;
  },
  async mf4FetchRange(
    handle: number,
    channelId: string,
    startNs: bigint,
    endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array> {
    await ready;
    return mf4_fetch_range(handle, channelId, startNs, endNs, includePrev);
  },
};

export type DataCoreApi = typeof dataCoreApi;

Comlink.expose(dataCoreApi);
