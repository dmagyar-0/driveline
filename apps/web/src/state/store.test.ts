// Store unit tests. Uses a hand-rolled fake worker so the tests run under
// jsdom without needing wasm-pack artifacts. Covers:
// - global range merge across multiple sources
// - duplicate basenames getting a " (2)" suffix
// - concurrent openFiles calls serialising rather than interleaving

import { beforeEach, describe, expect, it } from "vitest";
import type { Remote } from "comlink";
import { MAX_SPEED, MIN_SPEED, useSession } from "./store";
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
    async mcapFetchRange(
      handle: number,
      channelId: string,
      startNs: bigint,
      endNs: bigint,
      includePrev: boolean,
      maxPoints: number | undefined,
    ) {
      openLog.push(
        `mcapFetchRange:${handle}:${channelId}:${startNs}:${endNs}:${includePrev}:${maxPoints ?? "none"}`,
      );
      return new Uint8Array([0xaa]);
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
    async mf4FetchRange(
      handle: number,
      channelId: string,
      startNs: bigint,
      endNs: bigint,
      includePrev: boolean,
      maxPoints: number | undefined,
    ) {
      openLog.push(
        `mf4FetchRange:${handle}:${channelId}:${startNs}:${endNs}:${includePrev}:${maxPoints ?? "none"}`,
      );
      return new Uint8Array([0xbb]);
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

describe("transport", () => {
  // Seed a known globalRange [500n, 3_000n] via the mf4 summary; tests that
  // need a wider range open additional sources inline.
  async function loadMf4(): Promise<void> {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("seed.mf4")]);
  }

  it("has sane defaults on an empty session", () => {
    const s = useSession.getState();
    expect(s.cursorNs).toBe(0n);
    expect(s.playing).toBe(false);
    expect(s.speed).toBe(1);
  });

  it("openFiles seeds cursorNs to globalRange.startNs on first drop", async () => {
    await loadMf4();
    const s = useSession.getState();
    // Default cursor (0n) is below the mf4 range start (500n) so the drop
    // should snap the cursor up to the session start.
    expect(s.globalRange).toEqual({ startNs: 500n, endNs: 3_000n });
    expect(s.cursorNs).toBe(500n);
  });

  it("openFiles leaves an in-range cursor alone on a later drop", async () => {
    await loadMf4();
    useSession.getState().setCursor(1_500n);
    // Add the mcap source: range widens to [500n, 3_000n] (mcap is 1000..2000,
    // already inside), cursor at 1500n stays valid.
    await useSession.getState().openFiles([file("extra.mcap")]);
    expect(useSession.getState().cursorNs).toBe(1_500n);
  });

  it("setCursor is a no-op without a session", () => {
    useSession.getState().setCursor(123n);
    expect(useSession.getState().cursorNs).toBe(0n);
  });

  it("setCursor clamps below the session start", async () => {
    await loadMf4();
    useSession.getState().setCursor(-1n);
    expect(useSession.getState().cursorNs).toBe(500n);
  });

  it("setCursor clamps above the session end and pauses", async () => {
    await loadMf4();
    useSession.getState().play();
    expect(useSession.getState().playing).toBe(true);
    useSession.getState().setCursor(999_999n);
    const s = useSession.getState();
    expect(s.cursorNs).toBe(3_000n);
    expect(s.playing).toBe(false);
  });

  it("setCursor accepts a value strictly inside the range", async () => {
    await loadMf4();
    useSession.getState().setCursor(1_234n);
    const s = useSession.getState();
    expect(s.cursorNs).toBe(1_234n);
    expect(s.playing).toBe(false);
  });

  it("play / pause toggle the playing flag", async () => {
    await loadMf4();
    useSession.getState().play();
    expect(useSession.getState().playing).toBe(true);
    useSession.getState().pause();
    expect(useSession.getState().playing).toBe(false);
  });

  it("play is a no-op without a session", () => {
    useSession.getState().play();
    expect(useSession.getState().playing).toBe(false);
  });

  it("play from end-of-session rewinds to the session start", async () => {
    await loadMf4();
    // Park the cursor at the end (setCursor will pause as a side effect).
    useSession.getState().setCursor(3_000n);
    expect(useSession.getState().cursorNs).toBe(3_000n);
    useSession.getState().play();
    const s = useSession.getState();
    expect(s.cursorNs).toBe(500n);
    expect(s.playing).toBe(true);
  });

  it("setSpeed clamps to [MIN_SPEED, MAX_SPEED]", () => {
    useSession.getState().setSpeed(0.01);
    expect(useSession.getState().speed).toBe(MIN_SPEED);
    useSession.getState().setSpeed(99);
    expect(useSession.getState().speed).toBe(MAX_SPEED);
    useSession.getState().setSpeed(2);
    expect(useSession.getState().speed).toBe(2);
  });

  it("setSpeed ignores non-finite input", () => {
    useSession.getState().setSpeed(2);
    useSession.getState().setSpeed(Number.NaN);
    expect(useSession.getState().speed).toBe(2);
    useSession.getState().setSpeed(Number.POSITIVE_INFINITY);
    expect(useSession.getState().speed).toBe(2);
  });

  it("clear resets transport state to defaults", async () => {
    await loadMf4();
    useSession.getState().setCursor(1_000n);
    useSession.getState().setSpeed(2);
    useSession.getState().play();
    await useSession.getState().clear();
    const s = useSession.getState();
    expect(s.cursorNs).toBe(0n);
    expect(s.playing).toBe(false);
    expect(s.speed).toBe(1);
    expect(s.globalRange).toBeNull();
  });
});

describe("fetchChannelRange", () => {
  it("routes mcap channels to mcapFetchRange", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mcap")]);
    const mcapSource = useSession.getState().sources[0];
    const bytes = await useSession
      .getState()
      .fetchChannelRange("/a", 100n, 200n, false);
    expect(bytes).toEqual(new Uint8Array([0xaa]));
    expect(worker.openLog).toContain(
      `mcapFetchRange:${mcapSource.handle}:/a:100:200:false:none`,
    );
  });

  it("routes mf4 channels to mf4FetchRange", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mf4")]);
    const mf4Source = useSession.getState().sources[0];
    const bytes = await useSession
      .getState()
      .fetchChannelRange("0/1", 500n, 3_000n, true);
    expect(bytes).toEqual(new Uint8Array([0xbb]));
    expect(worker.openLog).toContain(
      `mf4FetchRange:${mf4Source.handle}:0/1:500:3000:true:none`,
    );
  });

  it("forwards maxPoints to mcapFetchRange for T4.3 decimation", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mcap")]);
    const mcapSource = useSession.getState().sources[0];
    await useSession
      .getState()
      .fetchChannelRange("/a", 100n, 200n, false, 2048);
    expect(worker.openLog).toContain(
      `mcapFetchRange:${mcapSource.handle}:/a:100:200:false:2048`,
    );
  });

  it("forwards maxPoints to mf4FetchRange for T4.3 decimation", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mf4")]);
    const mf4Source = useSession.getState().sources[0];
    await useSession
      .getState()
      .fetchChannelRange("0/1", 500n, 3_000n, true, 1024);
    expect(worker.openLog).toContain(
      `mf4FetchRange:${mf4Source.handle}:0/1:500:3000:true:1024`,
    );
  });

  it("throws for unknown channels", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mcap")]);
    await expect(
      useSession.getState().fetchChannelRange("missing", 0n, 1n, false),
    ).rejects.toThrow(/unknown channel/);
  });

  it("throws for non-plottable source kinds (video)", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession
      .getState()
      .openFiles([file("short.mp4"), file("short.mp4.ts.bin")]);
    await expect(
      useSession.getState().fetchChannelRange("1/video", 0n, 1n, false),
    ).rejects.toThrow(/channel kind not plottable/);
  });

});
