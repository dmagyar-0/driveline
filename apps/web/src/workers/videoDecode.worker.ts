import * as Comlink from "comlink";

// M1 shell: the real WebCodecs pipeline lands in M5.
export const videoDecodeApi = {
  ping(): string {
    return "pong";
  },
};

export type VideoDecodeApi = typeof videoDecodeApi;

Comlink.expose(videoDecodeApi);
