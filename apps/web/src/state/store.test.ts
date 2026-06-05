// Store unit tests. Uses a hand-rolled fake worker so the tests run under
// jsdom without needing wasm-pack artifacts. Covers:
// - global range merge across multiple sources
// - duplicate basenames getting a " (2)" suffix
// - concurrent openFiles calls serialising rather than interleaving

import { beforeEach, describe, expect, it } from "vitest";
import type { Remote } from "comlink";
import { MAX_SPEED, MIN_SPEED, useSession } from "./store";
import { MAX_PLOT_SERIES } from "../panels/palette";
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
          group: "Powertrain",
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
    async mp4SidecarIndex() {
      // Empty per-sample table is enough for tests that exercise
      // `openFiles` end-to-end without actually decoding video. The
      // store wires up an `Mp4SampleCache` with these arrays; nothing
      // is fetched unless a video panel mounts.
      return {
        channelId: "1/video",
        ptsNs: new BigInt64Array(0),
        offsets: new BigUint64Array(0),
        sizes: new Uint32Array(0),
        isSync: new Uint8Array(0),
        sps: new Uint8Array(0),
        pps: new Uint8Array(0),
      };
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

/**
 * Minimal `[ftyp][moov]` byte sequence accepted by `readMp4HeaderBytes`.
 * The store now slices ftyp+moov out of the source `File` on the main
 * thread before handing bytes to wasm (see `mp4HeaderSlice.ts`), so mp4
 * file fixtures need a valid top-level box structure even though the
 * fake worker never parses the bytes themselves.
 */
function minimalMp4Bytes(): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, 8, false);
  out.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  view.setUint32(8, 8, false);
  out.set([0x6d, 0x6f, 0x6f, 0x76], 12); // 'moov'
  return out;
}

function file(name: string, bytes?: Uint8Array): File {
  const payload =
    bytes ?? (name.endsWith(".mp4") ? minimalMp4Bytes() : new Uint8Array([1, 2, 3]));
  return new File([payload as BlobPart], name);
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
  // Phase 8: bookmarks survive `clear()` for the same reason (saved
  // bookmarks outlive a session), so wipe explicitly per-test.
  for (const b of [...useSession.getState().bookmarks]) {
    useSession.getState().removeBookmark(b.id);
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
    // Errors land on the slice so the Sources drawer can render them.
    expect(useSession.getState().lastOpenErrors).toHaveLength(2);
  });

  it("dismissOpenErrors clears the lastOpenErrors slice", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession
      .getState()
      .openFiles([file("notes.txt")]);
    expect(useSession.getState().lastOpenErrors).toHaveLength(1);
    useSession.getState().dismissOpenErrors();
    expect(useSession.getState().lastOpenErrors).toHaveLength(0);
  });

  it("replaces lastOpenErrors on the next openFiles call", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("notes.txt")]);
    expect(useSession.getState().lastOpenErrors).toHaveLength(1);
    // A clean follow-up drop replaces the prior batch's errors with [].
    await useSession.getState().openFiles([file("short.mf4")]);
    expect(useSession.getState().lastOpenErrors).toHaveLength(0);
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

  it("removeSource closes one handle and keeps the others", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([
      file("short.mcap"),
      file("short.mf4"),
    ]);
    expect(useSession.getState().sources).toHaveLength(2);

    await useSession.getState().removeSource("short.mcap");

    const s = useSession.getState();
    expect(s.sources.map((src) => src.id)).toEqual(["short.mf4"]);
    // Only the mcap handle (1) is closed; the mf4 (2) stays open.
    expect(worker.closeLog).toEqual(["mcap:1"]);
    // Channels for the removed source are gone; the mf4 channel remains.
    expect(s.channels.every((c) => c.sourceId === "short.mf4")).toBe(true);
    // Global range recomputes to the surviving mf4 range.
    expect(s.globalRange).toEqual({ startNs: 500n, endNs: 3_000n });
  });

  it("removeSource of the last source empties the session", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("only.mcap")]);
    await useSession.getState().removeSource("only.mcap");

    const s = useSession.getState();
    expect(s.sources).toHaveLength(0);
    expect(s.channels).toHaveLength(0);
    expect(s.globalRange).toBeNull();
    expect(s.cursorNs).toBe(0n);
    expect(s.playing).toBe(false);
  });

  it("removeSource prunes panel bindings that pointed at the closed source", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([
      file("short.mcap"),
      file("short.mf4"),
    ]);
    const st = useSession.getState();
    const mcapCh = st.channels.find((c) => c.sourceId === "short.mcap")!;
    const mf4Ch = st.channels.find((c) => c.sourceId === "short.mf4")!;

    // Bind a plot panel to both channels and an enum panel to the mcap one.
    st.setPlotBinding("plot-1", [mcapCh.id, mf4Ch.id]);
    st.setEnumBinding("enum-1", [mcapCh.id]);

    await useSession.getState().removeSource("short.mcap");

    const after = useSession.getState();
    // The mcap channel is pruned from the plot; the mf4 one survives.
    expect(after.plotBindings["plot-1"]).toEqual([mf4Ch.id]);
    // The enum binding pointed only at the gone channel → pruned to empty.
    expect(after.enumBindings["enum-1"]).toEqual([]);
  });

  it("removeSource is a no-op for an unknown id", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mcap")]);
    await useSession.getState().removeSource("does-not-exist");
    expect(useSession.getState().sources).toHaveLength(1);
    expect(worker.closeLog).toEqual([]);
  });

  it("removeSource clamps an out-of-range cursor into the surviving range", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    // mcap is [1000, 2000]; mp4 is [10_000, 20_000]; union → [1000, 20_000].
    await useSession.getState().openFiles([
      file("short.mcap"),
      file("clip.mp4"),
      file("clip.mp4.timestamps"),
    ]);
    // Park the cursor inside the mp4 tail, which only the mp4 source covers.
    useSession.getState().setCursor(18_000n);
    expect(useSession.getState().cursorNs).toBe(18_000n);

    await useSession.getState().removeSource("clip.mp4");

    const s = useSession.getState();
    expect(s.globalRange).toEqual({ startNs: 1_000n, endNs: 2_000n });
    // Cursor was beyond the new end → clamped down to it.
    expect(s.cursorNs).toBe(2_000n);
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

  // Seek-vs-tick seam (commit 2ea2c39 / merge #74). The video pipeline
  // subscribes to `seekEpoch` rather than `cursorNs` so a 60 Hz playback
  // tick (advanceCursor) does not look like a user scrub. setCursor must
  // bump the counter; advanceCursor must leave it alone. Get either side
  // wrong and either: (a) every play tick tears down the decoder
  // (advanceCursor bumps), or (b) a scrub during play stops updating the
  // canvas (setCursor doesn't bump).

  it("seekEpoch starts at 0", () => {
    expect(useSession.getState().seekEpoch).toBe(0);
  });

  it("setCursor bumps seekEpoch on every call", async () => {
    await loadMf4();
    const before = useSession.getState().seekEpoch;
    useSession.getState().setCursor(1_000n);
    expect(useSession.getState().seekEpoch).toBe(before + 1);
    useSession.getState().setCursor(1_500n);
    expect(useSession.getState().seekEpoch).toBe(before + 2);
    // Same target counts as a fresh seek — the worker may have torn down
    // the decoder, so the panel needs to re-issue.
    useSession.getState().setCursor(1_500n);
    expect(useSession.getState().seekEpoch).toBe(before + 3);
  });

  it("setCursor bumps seekEpoch even when clamping to end-of-session", async () => {
    await loadMf4();
    const before = useSession.getState().seekEpoch;
    useSession.getState().setCursor(999_999n);
    const s = useSession.getState();
    expect(s.cursorNs).toBe(3_000n);
    expect(s.playing).toBe(false);
    expect(s.seekEpoch).toBe(before + 1);
  });

  it("setCursor does NOT bump seekEpoch when there is no session", () => {
    // No globalRange → setCursor returns early before touching state.
    const before = useSession.getState().seekEpoch;
    useSession.getState().setCursor(123n);
    expect(useSession.getState().seekEpoch).toBe(before);
  });

  it("advanceCursor moves the cursor without bumping seekEpoch", async () => {
    await loadMf4();
    const before = useSession.getState().seekEpoch;
    useSession.getState().advanceCursor(1_500n);
    const s = useSession.getState();
    expect(s.cursorNs).toBe(1_500n);
    // Critical: a playback rAF tick must NOT look like a scrub. If this
    // bumps, the videoDecode worker reseeks on every frame and the
    // canvas freezes mid-play.
    expect(s.seekEpoch).toBe(before);
  });

  it("advanceCursor clamps to endNs and pauses, still without bumping seekEpoch", async () => {
    await loadMf4();
    useSession.getState().play();
    const before = useSession.getState().seekEpoch;
    useSession.getState().advanceCursor(999_999n);
    const s = useSession.getState();
    expect(s.cursorNs).toBe(3_000n);
    expect(s.playing).toBe(false);
    expect(s.seekEpoch).toBe(before);
  });

  it("advanceCursor clamps below the session start without bumping seekEpoch", async () => {
    await loadMf4();
    const before = useSession.getState().seekEpoch;
    useSession.getState().advanceCursor(-1n);
    const s = useSession.getState();
    expect(s.cursorNs).toBe(500n);
    expect(s.seekEpoch).toBe(before);
  });

  it("advanceCursor is a no-op without a session", () => {
    const before = useSession.getState().seekEpoch;
    useSession.getState().advanceCursor(123n);
    const s = useSession.getState();
    expect(s.cursorNs).toBe(0n);
    expect(s.seekEpoch).toBe(before);
  });

  it("play() from end-of-session bumps seekEpoch (rewinds the cursor)", async () => {
    await loadMf4();
    useSession.getState().setCursor(3_000n);
    const before = useSession.getState().seekEpoch;
    useSession.getState().play();
    const s = useSession.getState();
    expect(s.cursorNs).toBe(500n);
    expect(s.playing).toBe(true);
    // Rewind is a real seek — the decoder was open at endNs and now has
    // to reopen at startNs. Without the bump, the video pipeline misses
    // the rewind and keeps emitting nothing past the prior cursor.
    expect(s.seekEpoch).toBe(before + 1);
  });

  it("play() mid-session does NOT bump seekEpoch", async () => {
    await loadMf4();
    useSession.getState().setCursor(1_500n);
    const before = useSession.getState().seekEpoch;
    useSession.getState().play();
    expect(useSession.getState().playing).toBe(true);
    // Same cursor → no seek; the decoder was idle and should resume from
    // its current position.
    expect(useSession.getState().seekEpoch).toBe(before);
  });

  it("pause() does not bump seekEpoch", async () => {
    await loadMf4();
    useSession.getState().play();
    const before = useSession.getState().seekEpoch;
    useSession.getState().pause();
    expect(useSession.getState().seekEpoch).toBe(before);
  });

  it("clear resets seekEpoch back to 0", async () => {
    await loadMf4();
    useSession.getState().setCursor(1_000n);
    useSession.getState().setCursor(1_500n);
    expect(useSession.getState().seekEpoch).toBeGreaterThan(0);
    await useSession.getState().clear();
    expect(useSession.getState().seekEpoch).toBe(0);
  });
});

describe("fetchChannelRange", () => {
  it("routes mcap channels to mcapFetchRange", async () => {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mcap")]);
    const mcapSource = useSession.getState().sources[0];
    // Look up the qualified channel id; the fetch routes by nativeId
    // ("/a") to the worker.
    const channelId = mcapSource.channels[0].id;
    const bytes = await useSession
      .getState()
      .fetchChannelRange(channelId, 100n, 200n, false);
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
    const channelId = mf4Source.channels[0].id;
    const bytes = await useSession
      .getState()
      .fetchChannelRange(channelId, 500n, 3_000n, true);
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
    const mp4Source = useSession.getState().sources[0];
    const channelId = mp4Source.channels[0].id;
    await expect(
      useSession.getState().fetchChannelRange(channelId, 0n, 1n, false),
    ).rejects.toThrow(/channel kind not plottable/);
  });

  it("qualifies channel ids so two MF4s with the same native id do not collide", async () => {
    // Real-world repro: drop the same MF4 twice. The wasm summary returns
    // identical `{group}/{channel}` ids, but the session-level channel
    // ids must differ so plot bindings, video bindings, and the
    // `channelMap` in PlotPanel keep them apart.
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("short.mf4"), file("short.mf4")]);
    const sources = useSession.getState().sources;
    expect(sources).toHaveLength(2);
    expect(sources[0].id).not.toBe(sources[1].id);
    expect(sources[0].channels[0].nativeId).toBe(sources[1].channels[0].nativeId);
    expect(sources[0].channels[0].id).not.toBe(sources[1].channels[0].id);

    // Routes still hit the right wasm handle with the correct nativeId
    // for each source.
    await useSession
      .getState()
      .fetchChannelRange(sources[1].channels[0].id, 500n, 3_000n, false);
    expect(worker.openLog).toContain(
      `mf4FetchRange:${sources[1].handle}:0/1:500:3000:false`,
    );
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
    const ids = Array.from(
      { length: MAX_PLOT_SERIES + 2 },
      (_, i) => `/ch/${i}`,
    );
    for (const id of ids) store.addPlotChannel("plot-1", id);
    const bound = useSession.getState().plotBindings["plot-1"];
    expect(bound).toHaveLength(MAX_PLOT_SERIES);
    expect(bound).toEqual(ids.slice(0, MAX_PLOT_SERIES));
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
    // A leading duplicate (deduped) plus more distinct ids than the cap so
    // the cap actually trims the tail.
    const distinct = Array.from(
      { length: MAX_PLOT_SERIES + 3 },
      (_, i) => `/c${i}`,
    );
    useSession.getState().setPlotBinding("plot-1", [distinct[0], ...distinct]);
    expect(useSession.getState().plotBindings["plot-1"]).toEqual(
      distinct.slice(0, MAX_PLOT_SERIES),
    );
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
    useSession.getState().setVideoHudOn("video-1", true);
    useSession.getState().setSceneBinding("scene-1", "/cloud");
    useSession.getState().setMapBinding("map-1", {
      latChannelId: "/gps/lat",
      lonChannelId: "/gps/lon",
    });
    useSession.getState().addTableChannel("table-1", "/a");
    useSession.getState().setEnumBinding("enum-1", ["/state"]);
    useSession.getState().setPlotGapThreshold("plot-1", 1.5);

    await useSession.getState().clear();
    const s = useSession.getState();
    expect(s.videoBindings).toEqual({});
    expect(s.plotBindings).toEqual({});
    expect(s.videoHudOn).toEqual({});
    expect(s.sceneBindings).toEqual({});
    expect(s.mapBindings).toEqual({});
    expect(s.tableBindings).toEqual({});
    expect(s.enumBindings).toEqual({});
    expect(s.plotPanelSettings).toEqual({});
    // layout survives
    expect(s.layoutJson).toBe(model);
  });

  it("setPlotGapThreshold writes a per-panel finite positive value", () => {
    useSession.getState().setPlotGapThreshold("plot-1", 1.5);
    expect(useSession.getState().plotPanelSettings).toEqual({
      "plot-1": { gapThresholdSec: 1.5 },
    });
    useSession.getState().setPlotGapThreshold("plot-2", 0.25);
    expect(useSession.getState().plotPanelSettings).toEqual({
      "plot-1": { gapThresholdSec: 1.5 },
      "plot-2": { gapThresholdSec: 0.25 },
    });
  });

  it("setPlotGapThreshold normalises null / NaN / non-positive to null", () => {
    const store = useSession.getState();
    // Seed something to clear back to null.
    store.setPlotGapThreshold("plot-1", 1);
    expect(useSession.getState().plotPanelSettings["plot-1"]).toEqual({
      gapThresholdSec: 1,
    });

    store.setPlotGapThreshold("plot-1", null);
    expect(
      useSession.getState().plotPanelSettings["plot-1"].gapThresholdSec,
    ).toBeNull();

    store.setPlotGapThreshold("plot-1", 2);
    store.setPlotGapThreshold("plot-1", Number.NaN);
    expect(
      useSession.getState().plotPanelSettings["plot-1"].gapThresholdSec,
    ).toBeNull();

    store.setPlotGapThreshold("plot-1", 2);
    store.setPlotGapThreshold("plot-1", 0);
    expect(
      useSession.getState().plotPanelSettings["plot-1"].gapThresholdSec,
    ).toBeNull();

    store.setPlotGapThreshold("plot-1", 2);
    store.setPlotGapThreshold("plot-1", -1);
    expect(
      useSession.getState().plotPanelSettings["plot-1"].gapThresholdSec,
    ).toBeNull();

    store.setPlotGapThreshold("plot-1", 2);
    store.setPlotGapThreshold("plot-1", Number.POSITIVE_INFINITY);
    expect(
      useSession.getState().plotPanelSettings["plot-1"].gapThresholdSec,
    ).toBeNull();
  });

  it("setPlotGapThreshold no-ops when the value is unchanged", () => {
    useSession.getState().setPlotGapThreshold("plot-1", 1);
    const before = useSession.getState().plotPanelSettings;
    useSession.getState().setPlotGapThreshold("plot-1", 1);
    // Object identity preserved on no-op so the persist subscriber
    // doesn't re-stringify and write.
    expect(useSession.getState().plotPanelSettings).toBe(before);
  });

  it("setPlotChannelAxis assigns, clamps, and clears per-channel", () => {
    // Axis 0 is the default; assigning a non-zero axis records it.
    useSession.getState().setPlotChannelAxis("plot-1", "/speed", 1);
    expect(useSession.getState().plotPanelSettings["plot-1"]).toEqual({
      gapThresholdSec: null,
      axisAssignments: { "/speed": 1 },
    });
    // Out-of-range clamps to MAX_PLOT_Y_AXES - 1 (3).
    useSession.getState().setPlotChannelAxis("plot-1", "/rpm", 99);
    expect(
      useSession.getState().plotPanelSettings["plot-1"].axisAssignments,
    ).toEqual({ "/speed": 1, "/rpm": 3 });
    // Assigning back to axis 0 deletes the entry (0 is the default).
    useSession.getState().setPlotChannelAxis("plot-1", "/speed", 0);
    expect(
      useSession.getState().plotPanelSettings["plot-1"].axisAssignments,
    ).toEqual({ "/rpm": 3 });
    // No-op when unchanged: identity preserved.
    const before = useSession.getState().plotPanelSettings;
    useSession.getState().setPlotChannelAxis("plot-1", "/rpm", 3);
    expect(useSession.getState().plotPanelSettings).toBe(before);
  });

  it("setPlotStackAxes toggles, clears, and preserves sibling settings", () => {
    const store = useSession.getState();
    // Enabling records the flag alongside the default gapThreshold.
    store.setPlotStackAxes("plot-1", true);
    expect(useSession.getState().plotPanelSettings["plot-1"]).toEqual({
      gapThresholdSec: null,
      stackAxes: true,
    });
    // A sibling setting (axis assignment) coexists without clobbering it.
    store.setPlotChannelAxis("plot-1", "/rpm", 2);
    expect(useSession.getState().plotPanelSettings["plot-1"]).toEqual({
      gapThresholdSec: null,
      stackAxes: true,
      axisAssignments: { "/rpm": 2 },
    });
    // Disabling deletes the flag (minimal payload) but keeps the sibling.
    store.setPlotStackAxes("plot-1", false);
    expect(useSession.getState().plotPanelSettings["plot-1"]).toEqual({
      gapThresholdSec: null,
      axisAssignments: { "/rpm": 2 },
    });
    // No-op when unchanged: identity preserved so persist doesn't re-write.
    const before = useSession.getState().plotPanelSettings;
    store.setPlotStackAxes("plot-1", false);
    expect(useSession.getState().plotPanelSettings).toBe(before);
  });

  it("setPlotZoomX / setPlotZoomY store, coexist, and prune to no-zoom", () => {
    const store = useSession.getState();
    const xWin = { startNs: 1_000n, endNs: 9_000n };
    store.setPlotZoomX("plot-1", xWin);
    expect(useSession.getState().plotZoom["plot-1"]).toEqual({
      x: xWin,
      y: {},
    });
    // A y-axis window coexists with the x window.
    store.setPlotZoomY("plot-1", 1, { min: -2, max: 2 });
    expect(useSession.getState().plotZoom["plot-1"]).toEqual({
      x: xWin,
      y: { 1: { min: -2, max: 2 } },
    });
    // Clearing x leaves the panel zoomed (y still present).
    store.setPlotZoomX("plot-1", null);
    expect(useSession.getState().plotZoom["plot-1"]).toEqual({
      x: null,
      y: { 1: { min: -2, max: 2 } },
    });
    // Clearing the last y window prunes the panel entry entirely.
    store.setPlotZoomY("plot-1", 1, null);
    expect("plot-1" in useSession.getState().plotZoom).toBe(false);
  });

  it("setPlotZoomY no-ops cleanly on an unzoomed panel", () => {
    const before = useSession.getState().plotZoom;
    useSession.getState().setPlotZoomY("plot-1", 0, null);
    // Clearing a window that was never set leaves the map identity intact.
    expect(useSession.getState().plotZoom).toBe(before);
  });

  it("resetPlotZoom clears every override for a panel", () => {
    const store = useSession.getState();
    store.setPlotZoomX("plot-1", { startNs: 1n, endNs: 2n });
    store.setPlotZoomY("plot-1", 0, { min: 0, max: 1 });
    store.setPlotZoomY("plot-2", 0, { min: 0, max: 1 });
    store.resetPlotZoom("plot-1");
    expect("plot-1" in useSession.getState().plotZoom).toBe(false);
    // Other panels are untouched.
    expect("plot-2" in useSession.getState().plotZoom).toBe(true);
    // Reset on an unzoomed panel is a no-op (identity preserved).
    const before = useSession.getState().plotZoom;
    store.resetPlotZoom("plot-1");
    expect(useSession.getState().plotZoom).toBe(before);
  });

  it("setChannelUnit overrides globally and reverts on null", () => {
    useSession.getState().setChannelUnit("/speed", "km/h");
    expect(useSession.getState().unitOverrides).toEqual({ "/speed": "km/h" });
    // Empty string is a valid override meaning "explicitly no unit".
    useSession.getState().setChannelUnit("/speed", "");
    expect(useSession.getState().unitOverrides["/speed"]).toBe("");
    // No-op when unchanged: identity preserved.
    const before = useSession.getState().unitOverrides;
    useSession.getState().setChannelUnit("/speed", "");
    expect(useSession.getState().unitOverrides).toBe(before);
    // null reverts to the file-inferred unit (deletes the entry).
    useSession.getState().setChannelUnit("/speed", null);
    expect("/speed" in useSession.getState().unitOverrides).toBe(false);
  });

  it("setPlotChannelTransform stores and clears per-channel (P7)", () => {
    useSession
      .getState()
      .setPlotChannelTransform("plot-1", "/speed", {
        kind: "scale",
        mul: 3.6,
        add: 0,
      });
    expect(
      useSession.getState().plotPanelSettings["plot-1"].transforms,
    ).toEqual({ "/speed": { kind: "scale", mul: 3.6, add: 0 } });
    // A second channel coexists.
    useSession
      .getState()
      .setPlotChannelTransform("plot-1", "/accel", { kind: "abs" });
    expect(
      useSession.getState().plotPanelSettings["plot-1"].transforms,
    ).toEqual({
      "/speed": { kind: "scale", mul: 3.6, add: 0 },
      "/accel": { kind: "abs" },
    });
    // "none" deletes the entry rather than storing a no-op transform.
    useSession
      .getState()
      .setPlotChannelTransform("plot-1", "/speed", { kind: "none" });
    expect(
      useSession.getState().plotPanelSettings["plot-1"].transforms,
    ).toEqual({ "/accel": { kind: "abs" } });
  });

  it("setHoverNs publishes and clears the shared hover (P3)", () => {
    expect(useSession.getState().hoverNs).toBeNull();
    useSession.getState().setHoverNs(123_456n);
    expect(useSession.getState().hoverNs).toBe(123_456n);
    useSession.getState().setHoverNs(null);
    expect(useSession.getState().hoverNs).toBeNull();
  });

  it("setVideoHudOn sets per-panel without touching siblings", () => {
    useSession.getState().setVideoHudOn("video-1", true);
    expect(useSession.getState().videoHudOn).toEqual({ "video-1": true });
    useSession.getState().setVideoHudOn("video-2", true);
    expect(useSession.getState().videoHudOn).toEqual({
      "video-1": true,
      "video-2": true,
    });
    useSession.getState().setVideoHudOn("video-1", false);
    expect(useSession.getState().videoHudOn).toEqual({
      "video-1": false,
      "video-2": true,
    });
  });

  it("setVideoHudOn is a no-op when the bit already matches", () => {
    useSession.getState().setVideoHudOn("video-1", true);
    const before = useSession.getState().videoHudOn;
    useSession.getState().setVideoHudOn("video-1", true);
    expect(useSession.getState().videoHudOn).toBe(before);
  });

  it("toggleVideoHudOn flips the bit, defaulting absent panels to true", () => {
    useSession.getState().toggleVideoHudOn("video-1");
    expect(useSession.getState().videoHudOn["video-1"]).toBe(true);
    useSession.getState().toggleVideoHudOn("video-1");
    expect(useSession.getState().videoHudOn["video-1"]).toBe(false);
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

  it("saveCurrentLayoutAs / restoreNamedLayout round-trip Phase 6 bindings", () => {
    useSession.getState().setSceneBinding("scene-1", "/cloud");
    useSession.getState().setMapBinding("map-1", {
      latChannelId: "/gps/lat",
      lonChannelId: "/gps/lon",
    });
    useSession.getState().addTableChannel("table-1", "/a");
    useSession.getState().setEnumBinding("enum-1", ["/state"]);

    const id = useSession.getState().saveCurrentLayoutAs("phase6");

    // Drift live state away.
    useSession.getState().setSceneBinding("scene-1", null);
    useSession.getState().setMapBinding("map-1", null);
    useSession.getState().removeTableChannel("table-1", "/a");
    useSession.getState().setEnumBinding("enum-1", []);

    useSession.getState().restoreNamedLayout(id);
    const s = useSession.getState();
    expect(s.sceneBindings).toEqual({ "scene-1": "/cloud" });
    expect(s.mapBindings).toEqual({
      "map-1": { latChannelId: "/gps/lat", lonChannelId: "/gps/lon" },
    });
    expect(s.tableBindings).toEqual({ "table-1": ["/a"] });
    expect(s.enumBindings).toEqual({ "enum-1": ["/state"] });
  });

  it("saveCurrentLayoutAs snapshots plotPanelSettings (Phase 8)", () => {
    // Phase-8 added the per-panel settings map to the named-layout
    // schema. The snapshot must include the live values at save time
    // and must not be perturbed by post-save mutations to live state
    // — otherwise restoring later would replay the user's drift, not
    // their saved state.
    useSession.getState().setPlotGapThreshold("plot-1", 1.5);
    const id = useSession.getState().saveCurrentLayoutAs("snap");

    // Mutate live; the snapshot must not see the change.
    useSession.getState().setPlotGapThreshold("plot-1", 9);
    useSession.getState().setPlotGapThreshold("plot-2", 0.5);

    const entry = useSession
      .getState()
      .namedLayouts.find((l) => l.id === id)!;
    expect(entry.plotPanelSettings).toEqual({
      "plot-1": { gapThresholdSec: 1.5 },
    });
  });

  it("restoreNamedLayout restores plotPanelSettings (Phase 8)", () => {
    useSession.getState().setPlotGapThreshold("plot-1", 2.5);
    useSession.getState().setPlotGapThreshold("plot-2", 0.25);
    const id = useSession.getState().saveCurrentLayoutAs("phase8");

    // Drift live state away.
    useSession.getState().setPlotGapThreshold("plot-1", null);
    useSession.getState().setPlotGapThreshold("plot-2", null);
    expect(useSession.getState().plotPanelSettings).toEqual({
      "plot-1": { gapThresholdSec: null },
      "plot-2": { gapThresholdSec: null },
    });

    useSession.getState().restoreNamedLayout(id);
    expect(useSession.getState().plotPanelSettings).toEqual({
      "plot-1": { gapThresholdSec: 2.5 },
      "plot-2": { gapThresholdSec: 0.25 },
    });
  });

  it("saveCurrentLayoutAs deep-copies Phase 6 binding maps", () => {
    useSession.getState().setMapBinding("map-1", {
      latChannelId: "/lat",
      lonChannelId: "/lon",
    });
    useSession.getState().addTableChannel("table-1", "/a");
    const id = useSession.getState().saveCurrentLayoutAs("snap");

    // Mutate live; the snapshot must not see the change.
    useSession.getState().setMapBinding("map-1", {
      latChannelId: "/changed",
      lonChannelId: "/changed",
    });
    useSession.getState().addTableChannel("table-1", "/b");

    const entry = useSession
      .getState()
      .namedLayouts.find((l) => l.id === id)!;
    expect(entry.mapBindings).toEqual({
      "map-1": { latChannelId: "/lat", lonChannelId: "/lon" },
    });
    expect(entry.tableBindings).toEqual({ "table-1": ["/a"] });
  });
});

describe("Phase 6 panel bindings", () => {
  it("setSceneBinding sets and clears", () => {
    useSession.getState().setSceneBinding("scene-1", "/cloud");
    expect(useSession.getState().sceneBindings).toEqual({
      "scene-1": "/cloud",
    });
    useSession.getState().setSceneBinding("scene-1", null);
    expect(useSession.getState().sceneBindings).toEqual({ "scene-1": null });
  });

  it("setSceneBinding is a no-op when the channel id matches", () => {
    useSession.getState().setSceneBinding("scene-1", "/cloud");
    const before = useSession.getState().sceneBindings;
    useSession.getState().setSceneBinding("scene-1", "/cloud");
    expect(useSession.getState().sceneBindings).toBe(before);
  });

  it("setMapBinding round-trips lat/lon and clears via null", () => {
    useSession.getState().setMapBinding("map-1", {
      latChannelId: "/lat",
      lonChannelId: "/lon",
    });
    expect(useSession.getState().mapBindings).toEqual({
      "map-1": { latChannelId: "/lat", lonChannelId: "/lon" },
    });
    useSession.getState().setMapBinding("map-1", null);
    expect(useSession.getState().mapBindings["map-1"]).toBeNull();
  });

  it("setMapBinding deep-equal short-circuits when lat/lon are unchanged", () => {
    useSession.getState().setMapBinding("map-1", {
      latChannelId: "/lat",
      lonChannelId: "/lon",
    });
    const before = useSession.getState().mapBindings;
    useSession.getState().setMapBinding("map-1", {
      latChannelId: "/lat",
      lonChannelId: "/lon",
    });
    expect(useSession.getState().mapBindings).toBe(before);
  });

  it("addTableChannel dedupes and caps at MAX_PLOT_SERIES", () => {
    const ids = Array.from(
      { length: MAX_PLOT_SERIES + 2 },
      (_, i) => `/c${i}`,
    );
    for (const id of ids) useSession.getState().addTableChannel("table-1", id);
    expect(useSession.getState().tableBindings["table-1"]).toEqual(
      ids.slice(0, MAX_PLOT_SERIES),
    );
    // Duplicate add is a no-op.
    useSession.getState().addTableChannel("table-1", "/c0");
    expect(useSession.getState().tableBindings["table-1"]).toEqual(
      ids.slice(0, MAX_PLOT_SERIES),
    );
  });

  it("removeTableChannel filters out by id", () => {
    useSession.getState().setTableBinding("table-1", ["/a", "/b"]);
    useSession.getState().removeTableChannel("table-1", "/a");
    expect(useSession.getState().tableBindings["table-1"]).toEqual(["/b"]);
    // Removing absent id is a no-op.
    const before = useSession.getState().tableBindings;
    useSession.getState().removeTableChannel("table-1", "/ghost");
    expect(useSession.getState().tableBindings).toBe(before);
  });

  it("setTableBinding dedupes and caps wholesale replace", () => {
    useSession
      .getState()
      .setTableBinding("table-1", ["/a", "/a", "/b", "/c"]);
    expect(useSession.getState().tableBindings["table-1"]).toEqual([
      "/a",
      "/b",
      "/c",
    ]);
  });

  it("setEnumBinding dedupes and caps wholesale replace", () => {
    useSession
      .getState()
      .setEnumBinding("enum-1", ["/a", "/a", "/b", "/c"]);
    expect(useSession.getState().enumBindings["enum-1"]).toEqual([
      "/a",
      "/b",
      "/c",
    ]);
  });

  it("addEnumChannel appends and dedupes; removeEnumChannel filters", () => {
    useSession.getState().addEnumChannel("enum-1", "/a");
    useSession.getState().addEnumChannel("enum-1", "/b");
    // Duplicate add is a no-op.
    useSession.getState().addEnumChannel("enum-1", "/a");
    expect(useSession.getState().enumBindings["enum-1"]).toEqual(["/a", "/b"]);
    useSession.getState().removeEnumChannel("enum-1", "/a");
    expect(useSession.getState().enumBindings["enum-1"]).toEqual(["/b"]);
    // Removing an absent id is a no-op (same reference back).
    const before = useSession.getState().enumBindings;
    useSession.getState().removeEnumChannel("enum-1", "/ghost");
    expect(useSession.getState().enumBindings).toBe(before);
  });
});

describe("bookmarks (Phase 8)", () => {
  async function loadMf4(): Promise<void> {
    const worker = makeFakeWorker(defaultSummaries());
    useSession.getState().setWorker(worker);
    await useSession.getState().openFiles([file("seed.mf4")]);
  }

  it("addBookmarkAtCursor returns null when no fixture is loaded", () => {
    expect(useSession.getState().globalRange).toBeNull();
    const id = useSession.getState().addBookmarkAtCursor();
    expect(id).toBeNull();
    expect(useSession.getState().bookmarks).toEqual([]);
  });

  it("addBookmarkAtCursor stamps cursorNs, default label, and a stored color", async () => {
    await loadMf4();
    useSession.getState().setCursor(1_234n);
    const id = useSession.getState().addBookmarkAtCursor();
    expect(id).not.toBeNull();
    const bms = useSession.getState().bookmarks;
    expect(bms).toHaveLength(1);
    expect(bms[0].id).toBe(id);
    expect(bms[0].ns).toBe(1_234n);
    // Default label uses formatRelative against the globalRange start
    // (500n → 1234n is 734ns rounded down to 0ms in formatDuration).
    expect(bms[0].label).toMatch(/^bookmark @ /);
    // Color is a non-empty string from the palette.
    expect(typeof bms[0].color).toBe("string");
    expect(bms[0].color.length).toBeGreaterThan(0);
    expect(bms[0].createdAt).toBeGreaterThan(0);
  });

  it("addBookmarkAtCursor honours a custom label and trims whitespace", async () => {
    await loadMf4();
    useSession.getState().setCursor(1_000n);
    useSession.getState().addBookmarkAtCursor("  hard brake  ");
    expect(useSession.getState().bookmarks[0].label).toBe("hard brake");
  });

  it("addBookmarkAtCursor falls back to default when label trims to empty", async () => {
    await loadMf4();
    useSession.getState().addBookmarkAtCursor("   ");
    expect(useSession.getState().bookmarks[0].label).toMatch(/^bookmark @ /);
  });

  it("addBookmark seeds with an explicit ns (test seam)", () => {
    const id = useSession.getState().addBookmark(42n, "x");
    const bms = useSession.getState().bookmarks;
    expect(bms).toHaveLength(1);
    expect(bms[0].id).toBe(id);
    expect(bms[0].ns).toBe(42n);
    expect(bms[0].label).toBe("x");
  });

  it("addBookmark preserves insertion order (no implicit sort in storage)", () => {
    useSession.getState().addBookmark(2_000n, "second-by-ns");
    useSession.getState().addBookmark(1_000n, "first-by-ns");
    const bms = useSession.getState().bookmarks;
    expect(bms.map((b) => b.label)).toEqual(["second-by-ns", "first-by-ns"]);
  });

  it("removeBookmark drops the entry; unknown id is a no-op", () => {
    const id = useSession.getState().addBookmark(1n);
    useSession.getState().removeBookmark("ghost-id");
    expect(useSession.getState().bookmarks).toHaveLength(1);
    useSession.getState().removeBookmark(id);
    expect(useSession.getState().bookmarks).toHaveLength(0);
  });

  it("renameBookmark updates the label in-place", () => {
    const id = useSession.getState().addBookmark(1n, "old");
    useSession.getState().renameBookmark(id, "new");
    expect(useSession.getState().bookmarks[0].label).toBe("new");
  });

  it("renameBookmark trims and rejects empty labels", () => {
    const id = useSession.getState().addBookmark(1n, "keep");
    useSession.getState().renameBookmark(id, "   ");
    expect(useSession.getState().bookmarks[0].label).toBe("keep");
    useSession.getState().renameBookmark(id, "  trimmed  ");
    expect(useSession.getState().bookmarks[0].label).toBe("trimmed");
  });

  it("renameBookmark is a no-op for an unknown id", () => {
    const before = useSession.getState().bookmarks;
    useSession.getState().renameBookmark("ghost-id", "x");
    expect(useSession.getState().bookmarks).toBe(before);
  });

  it("clear() preserves bookmarks (matches namedLayouts posture)", async () => {
    await loadMf4();
    useSession.getState().setCursor(1_000n);
    const id = useSession.getState().addBookmarkAtCursor("survives");
    expect(id).not.toBeNull();
    await useSession.getState().clear();
    const bms = useSession.getState().bookmarks;
    expect(bms).toHaveLength(1);
    expect(bms[0].label).toBe("survives");
  });

  it("renameBookmark only touches the targeted entry's reference", () => {
    const a = useSession.getState().addBookmark(1n, "a");
    const b = useSession.getState().addBookmark(2n, "b");
    const before = useSession.getState().bookmarks;
    useSession.getState().renameBookmark(a, "A");
    const after = useSession.getState().bookmarks;
    expect(after).not.toBe(before);
    // Untouched entry is the same object reference.
    expect(after.find((x) => x.id === b)).toBe(
      before.find((x) => x.id === b),
    );
  });
});

describe("ui shell (drawer width)", () => {
  it("defaults drawerWidth to 220", () => {
    expect(useSession.getState().drawerWidth).toBe(220);
  });

  it("setDrawerWidth updates within range", () => {
    useSession.getState().setDrawerWidth(360);
    expect(useSession.getState().drawerWidth).toBe(360);
    // Restore the default so later tests start clean.
    useSession.getState().setDrawerWidth(220);
  });

  it("setDrawerWidth clamps below the min and above the max", () => {
    useSession.getState().setDrawerWidth(10);
    expect(useSession.getState().drawerWidth).toBe(220);
    useSession.getState().setDrawerWidth(99999);
    expect(useSession.getState().drawerWidth).toBe(560);
    useSession.getState().setDrawerWidth(220);
  });

  it("setDrawerWidth rounds fractional pixels", () => {
    useSession.getState().setDrawerWidth(301.7);
    expect(useSession.getState().drawerWidth).toBe(302);
    useSession.getState().setDrawerWidth(220);
  });
});
