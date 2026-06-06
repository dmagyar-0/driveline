import { describe, expect, it } from "vitest";
import { bucketFiles, classifyUrl, urlBasename } from "./bucket";

function f(name: string): File {
  return new File([new Uint8Array(0)], name);
}

describe("bucketFiles", () => {
  it("buckets mcap and mf4 files by extension", () => {
    const r = bucketFiles([f("a.mcap"), f("b.mf4")]);
    expect(r.mcap.map((x) => x.name)).toEqual(["a.mcap"]);
    expect(r.mf4.map((x) => x.name)).toEqual(["b.mf4"]);
    expect(r.mp4Pairs).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
  });

  it("pairs a .mp4 with its .mp4.timestamps sidecar", () => {
    const r = bucketFiles([f("short.mp4"), f("short.mp4.timestamps")]);
    expect(r.mp4Pairs).toHaveLength(1);
    expect(r.mp4Pairs[0].mp4.name).toBe("short.mp4");
    expect(r.mp4Pairs[0].ts.name).toBe("short.mp4.timestamps");
    expect(r.errors).toHaveLength(0);
  });

  it("queues a sidecar-less mp4 for timestamp binding (not an error)", () => {
    // Feature 1: a `.mp4` with no sidecar in the batch is no longer a hard
    // error — it's deferred to the video-timestamp binding flow.
    const r = bucketFiles([f("drive.mp4")]);
    expect(r.mp4Pairs).toHaveLength(0);
    expect(r.videoNeedsTimestamps.map((x) => x.name)).toEqual(["drive.mp4"]);
    expect(r.errors).toHaveLength(0);
  });

  it("reports an orphan sidecar as an error", () => {
    const r = bucketFiles([f("drive.mp4.timestamps")]);
    expect(r.mp4Pairs).toHaveLength(0);
    expect(r.errors).toEqual([
      { name: "drive.mp4.timestamps", reason: "orphan sidecar; no drive.mp4 in drop" },
    ]);
  });

  it("reports unknown extensions as errors", () => {
    const r = bucketFiles([f("notes.txt")]);
    expect(r.errors).toEqual([
      { name: "notes.txt", reason: "unknown file type: notes.txt" },
    ]);
  });

  it("handles multiple sources in one drop", () => {
    const r = bucketFiles([
      f("short.mcap"),
      f("short.mf4"),
      f("short.mp4"),
      f("short.mp4.timestamps"),
    ]);
    expect(r.mcap).toHaveLength(1);
    expect(r.mf4).toHaveLength(1);
    expect(r.mp4Pairs).toHaveLength(1);
    expect(r.errors).toHaveLength(0);
  });

  it("matches extensions case-insensitively", () => {
    // macOS Finder and some archives upper-case extensions. The code
    // lower-cases the name for matching; uppercase drops must still
    // bucket rather than land in `errors`.
    const r = bucketFiles([f("LOG.MCAP"), f("SENSOR.MF4")]);
    expect(r.mcap.map((x) => x.name)).toEqual(["LOG.MCAP"]);
    expect(r.mf4.map((x) => x.name)).toEqual(["SENSOR.MF4"]);
    expect(r.errors).toHaveLength(0);
  });

  it("buckets .csv into tabular as csv", () => {
    const r = bucketFiles([f("signals.csv")]);
    expect(r.tabular).toEqual([
      { file: expect.any(File), format: "csv" },
    ]);
    expect(r.tabular[0].file.name).toBe("signals.csv");
    expect(r.errors).toHaveLength(0);
  });

  it("buckets .parquet and .pq into tabular as parquet", () => {
    const r = bucketFiles([f("a.parquet"), f("b.pq")]);
    expect(r.tabular.map((t) => [t.file.name, t.format])).toEqual([
      ["a.parquet", "parquet"],
      ["b.pq", "parquet"],
    ]);
    expect(r.errors).toHaveLength(0);
  });

  it("matches tabular extensions case-insensitively", () => {
    const r = bucketFiles([f("DATA.CSV"), f("RUN.PARQUET")]);
    expect(r.tabular.map((t) => t.format)).toEqual(["csv", "parquet"]);
    expect(r.errors).toHaveLength(0);
  });

  it("keeps tabular files separate from the other buckets in one drop", () => {
    const r = bucketFiles([
      f("log.mcap"),
      f("sensor.mf4"),
      f("signals.csv"),
      f("cols.parquet"),
    ]);
    expect(r.mcap).toHaveLength(1);
    expect(r.mf4).toHaveLength(1);
    expect(r.tabular).toHaveLength(2);
    expect(r.mp4Pairs).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
  });

  it("always returns a tabular array even when none are dropped", () => {
    expect(bucketFiles([f("a.mcap")]).tabular).toEqual([]);
  });

  it("pairs the matching mp4 and queues the unpaired one for binding", () => {
    // Two mp4s but only one sidecar — the paired one becomes a pair, the
    // other is queued for the video-timestamp binding flow (not an error).
    const r = bucketFiles([
      f("a.mp4"),
      f("b.mp4"),
      f("a.mp4.timestamps"),
    ]);
    expect(r.mp4Pairs).toHaveLength(1);
    expect(r.mp4Pairs[0].mp4.name).toBe("a.mp4");
    expect(r.videoNeedsTimestamps.map((x) => x.name)).toEqual(["b.mp4"]);
    expect(r.errors).toHaveLength(0);
  });

  it("keeps an orphan sidecar an error even with a sidecar-less mp4", () => {
    // The mp4 defers to binding; the unrelated sidecar still errors.
    const r = bucketFiles([f("cam.mp4"), f("other.mp4.timestamps")]);
    expect(r.videoNeedsTimestamps.map((x) => x.name)).toEqual(["cam.mp4"]);
    expect(r.errors).toEqual([
      {
        name: "other.mp4.timestamps",
        reason: "orphan sidecar; no other.mp4 in drop",
      },
    ]);
  });

  it("always returns a videoNeedsTimestamps array even when none are dropped", () => {
    expect(bucketFiles([f("a.mcap")]).videoNeedsTimestamps).toEqual([]);
  });
});

describe("urlBasename", () => {
  it("uses the last path segment", () => {
    expect(urlBasename("https://host.example/drives/2018-08-02.mf4")).toBe(
      "2018-08-02.mf4",
    );
  });

  it("ignores query strings and fragments", () => {
    expect(
      urlBasename("https://host.example/logs/run.mcap?token=abc#t=5"),
    ).toBe("run.mcap");
  });

  it("percent-decodes the segment", () => {
    expect(urlBasename("https://host.example/a%20b/my%20log.mf4")).toBe(
      "my log.mf4",
    );
  });

  it("falls back to the host when there is no path", () => {
    expect(urlBasename("https://host.example")).toBe("host.example");
  });

  it("returns the raw string for an unparseable input", () => {
    expect(urlBasename("not a url")).toBe("not a url");
  });
});

describe("classifyUrl", () => {
  it("classifies an .mcap URL", () => {
    expect(classifyUrl("https://host.example/run.mcap")).toEqual({
      kind: "mcap",
      name: "run.mcap",
    });
  });

  it("classifies an .mf4 URL case-insensitively", () => {
    expect(classifyUrl("https://host.example/SENSOR.MF4")).toEqual({
      kind: "mf4",
      name: "SENSOR.MF4",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(classifyUrl("  https://host.example/run.mcap  ").kind).toBe("mcap");
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => classifyUrl("ftp://host.example/run.mcap")).toThrow(
      /http/i,
    );
  });

  it("rejects an unsupported extension", () => {
    expect(() => classifyUrl("https://host.example/clip.mp4")).toThrow(
      /\.mcap or \.mf4/,
    );
  });
});
