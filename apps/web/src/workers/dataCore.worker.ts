import * as Comlink from "comlink";
import init, { ping as wasmPing, fetch_range_stub } from "../wasm/wasm_bindings.js";

// Register the Comlink listener BEFORE awaiting wasm init. A top-level await
// here would suspend module evaluation; any messages posted by the main
// thread during that window fire on an empty listener list and are lost.
// Each API method awaits the init promise instead.
const ready = init();

export const dataCoreApi = {
  async ping(): Promise<string> {
    await ready;
    return wasmPing();
  },
  async fetchRangeStub(): Promise<Uint8Array> {
    await ready;
    return fetch_range_stub();
  },
};

export type DataCoreApi = typeof dataCoreApi;

Comlink.expose(dataCoreApi);
