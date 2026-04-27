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
    ) {
      openLog.push(
        `mcapFetchRange:${handle}:${channelId}:${startNs}:${endNs}:${includePrev}`,
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
    ) {
      openLog.push(
        `mf4FetchRange:${handle}:${channelId}:${startNs}:${endNs}:${includePrev}`,
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
  // `clear()` leaves `layoutJson` alone (by design — layout outlives a
  // session); wipe it manually so layout-slice tests start from a known
  // empty state instead of whatever an earlier test last set.
  useSession.getState().setLayoutJson(null);
  // Same for the named-layouts slice — `clear()` deliberately preserves
  // it (saved layouts outlive a session) so the per-test reset has to
  // be explicit.
  for (const l of [...useSession.getState().namedLayouts]) {
    useSession.getState().removeNamedLayout(l.id);
  }
});

describe("session store", () => {
  it("merges the global range over multiple sources", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    const r = await useSession.getState().openFiles([
      file("short.mcap"),
      file("short.mf4"),
      file("short.mp4"),
      file("short.mp4.timestamps"),
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
      `mcapFetchRange:${mcapSource.handle}:/a:100:200:false`,
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
      `mf4FetchRange:${mf4Source.handle}:0/1:500:3000:true`,
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
      .openFiles([file("short.mp4"), file("short.mp4.timestamps")]);
    await expect(
      useSession.getState().fetchChannelRange("1/video", 0n, 1n, false),
    ).rejects.toThrow(/channel kind not plottable/);
  });

});

describe("layout + bindings (T6.2)", () => {
  it("defaults to null layoutJson and empty binding maps", () => {
    const s = useSession.getState();
    expect(s.layoutJson).toBeNull();
    expect(s.videoBindings).toEqual({});
    expect(s.plotBindings).toEqual({});
  });

  it("setLayoutJson replaces the stored layout", () => {
    const model = { layout: { type: "row", weight: 100, children: [] } };
    useSession.getState().setLayoutJson(model);
    expect(useSession.getState().layoutJson).toBe(model);
    useSession.getState().setLayoutJson(null);
    expect(useSession.getState().layoutJson).toBeNull();
  });

  it("setVideoBinding sets and clears", () => {
    useSession.getState().setVideoBinding("video-1", "/cam/front");
    expect(useSession.getState().videoBindings).toEqual({
      "video-1": "/cam/front",
    });

    // no-op when value already matches — object identity preserved
    const snapshot = useSession.getState().videoBindings;
    useSession.getState().setVideoBinding("video-1", "/cam/front");
    expect(useSession.getState().videoBindings).toBe(snapshot);

    useSession.getState().setVideoBinding("video-1", null);
    expect(useSession.getState().videoBindings["video-1"]).toBeNull();
  });

  it("setVideoBinding on different panels does not collide", () => {
    useSession.getState().setVideoBinding("video-1", "/cam/front");
    useSession.getState().setVideoBinding("video-2", "/cam/rear");
    expect(useSession.getState().videoBindings).toEqual({
      "video-1": "/cam/front",
      "video-2": "/cam/rear",
    });
  });

  it("addPlotChannel appends, dedupes, and caps at MAX_PLOT_SERIES", () => {
    const store = useSession.getState();
    for (let i = 0; i < 10; i++) {
      store.addPlotChannel("plot-1", `/ch/${i}`);
    }
    const bound = useSession.getState().plotBindings["plot-1"];
    expect(bound).toHaveLength(8);
    expect(bound).toEqual([
      "/ch/0",
      "/ch/1",
      "/ch/2",
      "/ch/3",
      "/ch/4",
      "/ch/5",
      "/ch/6",
      "/ch/7",
    ]);
    // dedupe: adding an existing id is a no-op
    store.addPlotChannel("plot-1", "/ch/0");
    expect(useSession.getState().plotBindings["plot-1"]).toEqual(bound);
  });

  it("removePlotChannel drops the id and no-ops when absent", () => {
    const store = useSession.getState();
    store.addPlotChannel("plot-1", "/a");
    store.addPlotChannel("plot-1", "/b");
    store.removePlotChannel("plot-1", "/a");
    expect(useSession.getState().plotBindings["plot-1"]).toEqual(["/b"]);
    // absent → no change
    const before = useSession.getState().plotBindings;
    store.removePlotChannel("plot-1", "/missing");
    expect(useSession.getState().plotBindings).toBe(before);
    // unknown panel → no change
    store.removePlotChannel("plot-does-not-exist", "/b");
    expect(useSession.getState().plotBindings).toBe(before);
  });

  it("setPlotBinding dedupes and caps the input", () => {
    useSession
      .getState()
      .setPlotBinding("plot-1", [
        "/a",
        "/a",
        "/b",
        "/c",
        "/d",
        "/e",
        "/f",
        "/g",
        "/h",
        "/i",
      ]);
    expect(useSession.getState().plotBindings["plot-1"]).toEqual([
      "/a",
      "/b",
      "/c",
      "/d",
      "/e",
      "/f",
      "/g",
      "/h",
    ]);
  });

  it("bindings on different plot panels are independent", () => {
    const store = useSession.getState();
    store.addPlotChannel("plot-1", "/speed");
    store.addPlotChannel("plot-2", "/rpm");
    const pb = useSession.getState().plotBindings;
    expect(pb["plot-1"]).toEqual(["/speed"]);
    expect(pb["plot-2"]).toEqual(["/rpm"]);
  });

  it("clear wipes bindings but keeps layoutJson", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mcap")]);
    const model = { layout: { type: "row", weight: 100, children: [] } };
    useSession.getState().setLayoutJson(model);
    useSession.getState().setVideoBinding("video-1", "/cam");
    useSession.getState().addPlotChannel("plot-1", "/a");

    await useSession.getState().clear();
    const s = useSession.getState();
    expect(s.videoBindings).toEqual({});
    expect(s.plotBindings).toEqual({});
    // layout survives
    expect(s.layoutJson).toBe(model);
  });
});

describe("named layouts (Phase 4)", () => {
  it("starts empty with no active id", () => {
    const s = useSession.getState();
    expect(s.namedLayouts).toEqual([]);
    expect(s.activeNamedLayoutId).toBeNull();
  });

  it("saveCurrentLayoutAs snapshots layoutJson + bindings and marks active", () => {
    const model = { layout: { type: "row", weight: 100, children: [] } };
    useSession.getState().setLayoutJson(model);
    useSession.getState().setVideoBinding("video-1", "/cam");
    useSession.getState().addPlotChannel("plot-1", "/a");

    const id = useSession.getState().saveCurrentLayoutAs("default");
    const s = useSession.getState();
    expect(s.namedLayouts).toHaveLength(1);
    const entry = s.namedLayouts[0];
    expect(entry.id).toBe(id);
    expect(entry.name).toBe("default");
    expect(entry.layoutJson).toBe(model);
    expect(entry.videoBindings).toEqual({ "video-1": "/cam" });
    expect(entry.plotBindings).toEqual({ "plot-1": ["/a"] });
    expect(typeof entry.createdAt).toBe("number");
    expect(s.activeNamedLayoutId).toBe(id);
  });

  it("saveCurrentLayoutAs deep-copies the binding maps", () => {
    useSession.getState().setVideoBinding("video-1", "/cam");
    useSession.getState().addPlotChannel("plot-1", "/a");
    const id = useSession.getState().saveCurrentLayoutAs("snap");

    // Mutate the live bindings; the snapshot must not see the change.
    useSession.getState().setVideoBinding("video-1", "/changed");
    useSession.getState().addPlotChannel("plot-1", "/b");

    const entry = useSession
      .getState()
      .namedLayouts.find((l) => l.id === id)!;
    expect(entry.videoBindings).toEqual({ "video-1": "/cam" });
    expect(entry.plotBindings).toEqual({ "plot-1": ["/a"] });
  });

  it("setLayoutJson clears activeNamedLayoutId", () => {
    useSession.getState().setLayoutJson({ a: 1 });
    const id = useSession.getState().saveCurrentLayoutAs("x");
    expect(useSession.getState().activeNamedLayoutId).toBe(id);
    useSession.getState().setLayoutJson({ a: 2 });
    expect(useSession.getState().activeNamedLayoutId).toBeNull();
  });

  it("restoreNamedLayout writes layout + bindings + active id in one set", () => {
    // Save a layout, then drift the live state away from it.
    useSession.getState().setLayoutJson({ ver: "saved" });
    useSession.getState().setVideoBinding("video-1", "/cam");
    useSession.getState().addPlotChannel("plot-1", "/saved");
    const id = useSession.getState().saveCurrentLayoutAs("named");

    useSession.getState().setLayoutJson({ ver: "drifted" });
    useSession.getState().setVideoBinding("video-1", "/other");
    useSession.getState().setPlotBinding("plot-1", ["/drifted"]);
    expect(useSession.getState().activeNamedLayoutId).toBeNull();

    useSession.getState().restoreNamedLayout(id);
    const s = useSession.getState();
    expect(s.layoutJson).toEqual({ ver: "saved" });
    expect(s.videoBindings).toEqual({ "video-1": "/cam" });
    expect(s.plotBindings).toEqual({ "plot-1": ["/saved"] });
    expect(s.activeNamedLayoutId).toBe(id);
  });

  it("restoreNamedLayout is a no-op for an unknown id", () => {
    useSession.getState().setLayoutJson({ live: true });
    const before = useSession.getState();
    useSession.getState().restoreNamedLayout("ghost-id");
    const after = useSession.getState();
    expect(after.layoutJson).toBe(before.layoutJson);
    expect(after.activeNamedLayoutId).toBeNull();
  });

  it("removeNamedLayout drops the entry and clears active when it matched", () => {
    const id1 = useSession.getState().saveCurrentLayoutAs("a");
    const id2 = useSession.getState().saveCurrentLayoutAs("b");
    expect(useSession.getState().activeNamedLayoutId).toBe(id2);

    useSession.getState().removeNamedLayout(id2);
    let s = useSession.getState();
    expect(s.namedLayouts.map((l) => l.id)).toEqual([id1]);
    expect(s.activeNamedLayoutId).toBeNull();

    // Removing a non-active entry leaves activeNamedLayoutId untouched.
    useSession.getState().restoreNamedLayout(id1);
    expect(useSession.getState().activeNamedLayoutId).toBe(id1);
    const id3 = useSession.getState().saveCurrentLayoutAs("c");
    useSession.getState().restoreNamedLayout(id1);
    useSession.getState().removeNamedLayout(id3);
    s = useSession.getState();
    expect(s.activeNamedLayoutId).toBe(id1);
  });

  it("clear() leaves namedLayouts and activeNamedLayoutId alone", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mcap")]);
    const id = useSession.getState().saveCurrentLayoutAs("keep");

    await useSession.getState().clear();
    const s = useSession.getState();
    expect(s.namedLayouts.map((l) => l.id)).toEqual([id]);
    expect(s.activeNamedLayoutId).toBe(id);
  });
});
