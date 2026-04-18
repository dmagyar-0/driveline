import { describe, expect, it } from "vitest";
import { bucketFiles } from "./bucket";

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

  it("pairs a .mp4 with its .mp4.ts.bin sidecar", () => {
    const r = bucketFiles([f("short.mp4"), f("short.mp4.ts.bin")]);
    expect(r.mp4Pairs).toHaveLength(1);
    expect(r.mp4Pairs[0].mp4.name).toBe("short.mp4");
    expect(r.mp4Pairs[0].ts.name).toBe("short.mp4.ts.bin");
    expect(r.errors).toHaveLength(0);
  });

  it("reports a missing sidecar as an error", () => {
    const r = bucketFiles([f("drive.mp4")]);
    expect(r.mp4Pairs).toHaveLength(0);
    expect(r.errors).toEqual([
      { name: "drive.mp4", reason: "missing sidecar drive.mp4.ts.bin" },
    ]);
  });

  it("reports an orphan sidecar as an error", () => {
    const r = bucketFiles([f("drive.mp4.ts.bin")]);
    expect(r.mp4Pairs).toHaveLength(0);
    expect(r.errors).toEqual([
      { name: "drive.mp4.ts.bin", reason: "orphan sidecar; no drive.mp4 in drop" },
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
      f("short.mp4.ts.bin"),
    ]);
    expect(r.mcap).toHaveLength(1);
    expect(r.mf4).toHaveLength(1);
    expect(r.mp4Pairs).toHaveLength(1);
    expect(r.errors).toHaveLength(0);
  });
});
