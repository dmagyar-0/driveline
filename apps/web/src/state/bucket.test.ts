import { describe, expect, it } from "vitest";
import {
  bucketFiles,
  classifyUrl,
  sniffAlpamayoLidar,
  sniffAlpamayoLidarBytes,
  sniffCalibrationBytes,
  sniffDrivelineMapBytes,
  urlBasename,
} from "./bucket";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

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

  it("routes an OpenDRIVE .xodr into the mapGeometry bucket", () => {
    const r = bucketFiles([f("intersection.xodr")]);
    expect(r.mapGeometry.map((x) => x.name)).toEqual(["intersection.xodr"]);
    expect(r.unknown).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
  });

  it("leaves a drivelineMap .json in unknown for the openFiles sniff", () => {
    // `bucketFiles` is synchronous and can't read bytes, so the `.json`
    // case is resolved later in `openFiles` via `sniffDrivelineMap`.
    const r = bucketFiles([f("map.json")]);
    expect(r.mapGeometry).toHaveLength(0);
    expect(r.unknown.map((x) => x.name)).toEqual(["map.json"]);
  });

  it("reports an orphan sidecar as an error", () => {
    const r = bucketFiles([f("drive.mp4.timestamps")]);
    expect(r.mp4Pairs).toHaveLength(0);
    expect(r.errors).toEqual([
      {
        name: "drive.mp4.timestamps",
        reason: "orphan sidecar; no drive.mp4 in drop",
      },
    ]);
  });

  it("buckets .bag files into the ros1 bucket", () => {
    const r = bucketFiles([f("drive.bag"), f("RUN.BAG")]);
    expect(r.ros1.map((x) => x.name)).toEqual(["drive.bag", "RUN.BAG"]);
    expect(r.errors).toHaveLength(0);
  });

  it("buckets .db3 files into the ros2db3 bucket", () => {
    const r = bucketFiles([f("drive.db3"), f("RUN.DB3")]);
    expect(r.ros2db3.map((x) => x.name)).toEqual(["drive.db3", "RUN.DB3"]);
    expect(r.errors).toHaveLength(0);
  });

  it("routes unknown extensions to the Format Agent flow, not errors", () => {
    const r = bucketFiles([f("telemetry.acme")]);
    expect(r.ros1).toHaveLength(0);
    expect(r.ros2db3).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
    expect(r.unknown.map((u) => u.name)).toEqual(["telemetry.acme"]);
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
    expect(r.tabular).toEqual([{ file: expect.any(File), format: "csv" }]);
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

  it("routes .lidar.parquet to the lidar bucket, not tabular", () => {
    const r = bucketFiles([f("spin.lidar.parquet"), f("cols.parquet")]);
    expect(r.lidar.map((l) => [l.file.name, l.format])).toEqual([
      ["spin.lidar.parquet", "parquet"],
    ]);
    // The plain `.parquet` still routes to tabular.
    expect(r.tabular.map((t) => t.file.name)).toEqual(["cols.parquet"]);
    expect(r.errors).toHaveLength(0);
  });

  it("buckets .pcd into the lidar bucket as pcd", () => {
    const r = bucketFiles([f("scan.pcd"), f("SCAN.PCD")]);
    expect(r.lidar.map((l) => [l.file.name, l.format])).toEqual([
      ["scan.pcd", "pcd"],
      ["SCAN.PCD", "pcd"],
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
    const r = bucketFiles([f("a.mp4"), f("b.mp4"), f("a.mp4.timestamps")]);
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

describe("sniffCalibrationBytes", () => {
  it("matches the driveline.calibration/v1 schema marker", () => {
    expect(
      sniffCalibrationBytes(
        bytes('{ "schema": "driveline.calibration/v1", "cameras": [] }'),
      ),
    ).toBe(true);
  });
  it("rejects an OpenLABEL JSON", () => {
    expect(sniffCalibrationBytes(bytes('{ "openlabel": { } }'))).toBe(false);
  });
  it("rejects an unrelated JSON", () => {
    expect(sniffCalibrationBytes(bytes('{ "foo": 1 }'))).toBe(false);
  });
});

describe("sniffDrivelineMapBytes", () => {
  it("matches a top-level drivelineMap key", () => {
    expect(
      sniffDrivelineMapBytes(
        bytes('{ "drivelineMap": { "version": 1, "features": [] } }'),
      ),
    ).toBe(true);
  });
  it("rejects an OpenLABEL JSON", () => {
    expect(sniffDrivelineMapBytes(bytes('{ "openlabel": { } }'))).toBe(false);
  });
  it("rejects a trajectory JSON", () => {
    expect(sniffDrivelineMapBytes(bytes('{ "trajectory": { } }'))).toBe(false);
  });
  it("rejects an unrelated JSON", () => {
    expect(sniffDrivelineMapBytes(bytes('{ "foo": 1 }'))).toBe(false);
  });
});

describe("sniffAlpamayoLidarBytes", () => {
  it("matches the draco_encoded_pointcloud column in footer bytes", () => {
    expect(
      sniffAlpamayoLidarBytes(
        bytes("schemaspin_start_timestampdraco_encoded_pointcloudmore"),
      ),
    ).toBe(true);
  });
  it("rejects a converted Driveline point-cloud footer", () => {
    expect(
      sniffAlpamayoLidarBytes(bytes("t_nspositionsintensitiespointcloud")),
    ).toBe(false);
  });
});

describe("sniffAlpamayoLidar", () => {
  // Build a minimal parquet-shaped buffer: [footer][footerLen u32 LE]["PAR1"].
  function fakeParquet(footer: Uint8Array): File {
    const len = footer.length;
    const trailer = new Uint8Array([
      len & 0xff,
      (len >> 8) & 0xff,
      (len >> 16) & 0xff,
      (len >> 24) & 0xff,
      0x50,
      0x41,
      0x52,
      0x31, // "PAR1"
    ]);
    const buf = new Uint8Array(footer.length + trailer.length);
    buf.set(footer, 0);
    buf.set(trailer, footer.length);
    return new File([buf], "clip.parquet");
  }

  it("locates the footer via the trailing length + magic and matches", async () => {
    const f = fakeParquet(bytes("schema…draco_encoded_pointcloud…"));
    expect(await sniffAlpamayoLidar(f)).toBe(true);
  });
  it("rejects a parquet whose footer lacks the Draco column", async () => {
    const f = fakeParquet(bytes("t_ns positions intensities"));
    expect(await sniffAlpamayoLidar(f)).toBe(false);
  });
  it("rejects a file without the PAR1 trailer", async () => {
    const f = new File(
      [new Uint8Array(bytes("draco_encoded_pointcloud but not parquet"))],
      "x",
    );
    expect(await sniffAlpamayoLidar(f)).toBe(false);
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
    expect(() => classifyUrl("ftp://host.example/run.mcap")).toThrow(/http/i);
  });

  it("rejects an unsupported extension", () => {
    expect(() => classifyUrl("https://host.example/clip.mp4")).toThrow(
      /\.mcap or \.mf4/,
    );
  });
});
