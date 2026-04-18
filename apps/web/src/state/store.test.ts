// Store unit tests. Uses a hand-rolled fake worker so the tests run under
// jsdom without needing wasm-pack artifacts. Covers:
// - global range merge across multiple sources
// - duplicate basenames getting a " (2)" suffix
// - concurrent openFiles calls serialising rather than interleaving

import { beforeEach, describe, expect, it } from "vitest";
import type { Remote } from "comlink";
import { useSession } from "./store";
import type {
  DataCoreApi,
  McapSummary,
  Mf4Summary,
  Mp4SidecarSummary,
} from "../workerClient";

interface Summaries {
  mcap: McapSummary;
  mf4: Mf4Summary;
  mp4: Mp4SidecarSummary;
}

function defaultSummaries(): Summaries {
  return {
    mcap: {
      start_ns: 1_000n,
      end_ns: 2_000n,
      channels: [
        {
          id: "/a",
          name: "a",
          kind: "scalar",
          dtype: "f64",
          unit: null,
          sample_count: 3,
          start_ns: 1_000n,
          end_ns: 2_000n,
        },
      ],
    },
    mf4: {
      start_ns: 500n,
      end_ns: 3_000n,
      channels: [
        {
          id: "0/1",
          name: "speed",
          unit: null,
          sample_count: 10,
          start_ns: 500n,
          end_ns: 3_000n,
        },
      ],
    },
    mp4: {
      start_ns: 10_000n,
      end_ns: 20_000n,
      channels: [
        {
          id: "1/video",
          name: "track_1",
          sample_count: 30,
          start_ns: 10_000n,
          end_ns: 20_000n,
        },
      ],
    },
  };
}

type FakeWorker = Remote<DataCoreApi> & {
  openLog: string[];
  closeLog: string[];
  openResolvers: Array<() => void>;
};

function makeFakeWorker(summaries: Summaries): FakeWorker {
  let nextHandle = 1;
  const openLog: string[] = [];
  const closeLog: string[] = [];
  const openResolvers: Array<() => void> = [];
  // If non-empty, each open call blocks until its resolver is invoked.
  let blocking = false;

  function maybeBlock(): Promise<void> {
    if (!blocking) return Promise.resolve();
    return new Promise((resolve) => openResolvers.push(resolve));
  }

  const api = {
    async ping() {
      return "pong";
    },
    async fetchRangeStub() {
      return new Uint8Array();
    },
    async openMcap() {
      openLog.push("mcap");
      await maybeBlock();
      return nextHandle++;
    },
    async closeMcap(h: number) {
      closeLog.push(`mcap:${h}`);
    },
    async mcapSummary() {
      return summaries.mcap;
    },
    async openMf4() {
      openLog.push("mf4");
      await maybeBlock();
      return nextHandle++;
    },
    async closeMf4(h: number) {
      closeLog.push(`mf4:${h}`);
    },
    async mf4Summary() {
      return summaries.mf4;
    },
    async mf4FetchRange() {
      return new Uint8Array();
    },
    async openMp4Sidecar() {
      openLog.push("mp4");
      await maybeBlock();
      return nextHandle++;
    },
    async closeMp4Sidecar(h: number) {
      closeLog.push(`mp4:${h}`);
    },
    async mp4SidecarSummary() {
      return summaries.mp4;
    },
  } as unknown as Remote<DataCoreApi>;

  const fake = api as FakeWorker;
  fake.openLog = openLog;
  fake.closeLog = closeLog;
  fake.openResolvers = openResolvers;
  // @ts-expect-error — attach the blocking toggle for tests that need it
  fake.__setBlocking = (b: boolean) => {
    blocking = b;
  };
  return fake;
}

function file(name: string, bytes = new Uint8Array([1, 2, 3])): File {
  return new File([bytes], name);
}

beforeEach(async () => {
  await useSession.getState().clear();
});

describe("session store", () => {
  it("merges the global range over multiple sources", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    const r = await useSession.getState().openFiles([
      file("short.mcap"),
      file("short.mf4"),
      file("short.mp4"),
      file("short.mp4.ts.bin"),
    ]);
    expect(r.opened.sort()).toEqual(["short.mcap", "short.mf4", "short.mp4"]);
    expect(r.errors).toHaveLength(0);

    const s = useSession.getState();
    expect(s.sources).toHaveLength(3);
    // min start across all three (mf4 wins at 500), max end across all
    // three (mp4 wins at 20_000).
    expect(s.globalRange).toEqual({ startNs: 500n, endNs: 20_000n });
    expect(s.channels).toHaveLength(3);
  });

  it("assigns a ' (2)' suffix to duplicate basenames", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mcap")]);
    await useSession.getState().openFiles([file("short.mcap")]);
    const ids = useSession.getState().sources.map((s) => s.id);
    expect(ids).toEqual(["short.mcap", "short.mcap (2)"]);
  });

  it("reports bucket errors without opening unrelated files", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    const r = await useSession.getState().openFiles([
      file("lone.mp4"), // missing sidecar
      file("notes.txt"), // unknown extension
      file("short.mf4"), // opens fine
    ]);
    expect(r.opened).toEqual(["short.mf4"]);
    expect(r.errors).toHaveLength(2);
    expect(useSession.getState().sources).toHaveLength(1);
  });

  it("serialises overlapping openFiles calls", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    // @ts-expect-error — toggle added by makeFakeWorker
    worker.__setBlocking(true);
    useSession.getState().setWorker(worker);

    const p1 = useSession.getState().openFiles([file("a.mcap")]);
    const p2 = useSession.getState().openFiles([file("b.mcap")]);

    // Both open calls are queued. Resolve them in order.
    await new Promise((r) => setTimeout(r, 0));
    expect(worker.openLog).toEqual(["mcap"]);
    worker.openResolvers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    worker.openResolvers.shift()!();
    await Promise.all([p1, p2]);

    expect(useSession.getState().sources.map((s) => s.id)).toEqual([
      "a.mcap",
      "b.mcap",
    ]);
  });

  it("clear closes every wasm handle", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([
      file("short.mcap"),
      file("short.mf4"),
    ]);
    expect(useSession.getState().sources).toHaveLength(2);
    await useSession.getState().clear();
    expect(useSession.getState().sources).toHaveLength(0);
    expect(worker.closeLog.sort()).toEqual(["mcap:1", "mf4:2"]);
  });
});
