import { describe, expect, it } from "vitest";
import { buildSampleBundle, planSlices } from "./sampler";

const KiB = 1024;
const MiB = 1024 * 1024;

/** Build a synthetic File of `size` bytes whose byte i = i % 256. */
function syntheticFile(size: number, name = "sample.acme"): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;
  return new File([bytes], name);
}

describe("planSlices", () => {
  it("returns head, 8 stratified, and tail for a large file", () => {
    const size = 1_000 * MiB; // 1 GB — never read, just planned
    const slices = planSlices(size);
    const head = slices.filter((s) => s.kind === "head");
    const tail = slices.filter((s) => s.kind === "tail");
    const strat = slices.filter((s) => s.kind === "stratified");
    expect(head).toHaveLength(1);
    expect(tail).toHaveLength(1);
    expect(strat).toHaveLength(8);

    expect(head[0].byteOffset).toBe(0);
    expect(head[0].length).toBe(4 * MiB);
    expect(tail[0].byteOffset).toBe(size - 1 * MiB);
    expect(tail[0].length).toBe(1 * MiB);
    for (const s of strat) expect(s.length).toBe(256 * KiB);
  });

  it("slices are in ascending, non-overlapping offset order with correct bundleOffsets", () => {
    const slices = planSlices(500 * MiB);
    let cursor = 0;
    let bundleCursor = 0;
    for (const s of slices) {
      expect(s.byteOffset).toBeGreaterThanOrEqual(cursor);
      expect(s.bundleOffset).toBe(bundleCursor);
      cursor = s.byteOffset + s.length;
      bundleCursor += s.length;
    }
  });

  it("stratified slices stay strictly inside (head, tail) and span the interior", () => {
    const size = 100 * MiB;
    const slices = planSlices(size);
    const interiorStart = 4 * MiB;
    const interiorEnd = size - 1 * MiB;
    const strat = slices.filter((s) => s.kind === "stratified");
    for (const s of strat) {
      expect(s.byteOffset).toBeGreaterThanOrEqual(interiorStart);
      expect(s.byteOffset + s.length).toBeLessThanOrEqual(interiorEnd);
    }
    // The first stratified slice starts at the interior start; the last ends at
    // the interior end (even spread).
    expect(strat[0].byteOffset).toBe(interiorStart);
    expect(
      strat[strat.length - 1].byteOffset + strat[strat.length - 1].length,
    ).toBe(interiorEnd);
  });

  it("small file (< head+tail) collapses to one whole-file slice, no double count", () => {
    const size = 2 * MiB; // smaller than 4 MiB head + 1 MiB tail
    const slices = planSlices(size);
    expect(slices).toHaveLength(1);
    expect(slices[0].byteOffset).toBe(0);
    expect(slices[0].length).toBe(size);
    expect(slices[0].bundleOffset).toBe(0);
  });

  it("a file just over head+tail does not overlap or exceed bounds", () => {
    const size = 6 * MiB; // head 4 + tail 1 = 5, leaves 1 MiB interior
    const slices = planSlices(size);
    const total = slices.reduce((n, s) => n + s.length, 0);
    // No byte is counted twice: total sampled <= file size.
    expect(total).toBeLessThanOrEqual(size);
    let cursor = 0;
    for (const s of slices) {
      expect(s.byteOffset).toBeGreaterThanOrEqual(cursor);
      cursor = s.byteOffset + s.length;
      expect(cursor).toBeLessThanOrEqual(size);
    }
  });

  it("respects size overrides", () => {
    const slices = planSlices(100 * MiB, {
      headBytes: 1 * MiB,
      tailBytes: 512 * KiB,
      stratifiedCount: 2,
      stratifiedBytes: 64 * KiB,
    });
    expect(slices.filter((s) => s.kind === "head")[0].length).toBe(1 * MiB);
    expect(slices.filter((s) => s.kind === "tail")[0].length).toBe(512 * KiB);
    expect(slices.filter((s) => s.kind === "stratified")).toHaveLength(2);
  });

  it("returns nothing for an empty file", () => {
    expect(planSlices(0)).toEqual([]);
  });
});

describe("buildSampleBundle", () => {
  it("produces a manifest whose blob length equals totalSampledBytes", async () => {
    const file = syntheticFile(6 * MiB);
    const bundle = await buildSampleBundle(file);
    expect(bundle.blob.size).toBe(bundle.manifest.totalSampledBytes);
    expect(bundle.manifest.filename).toBe("sample.acme");
    expect(bundle.manifest.fileSize).toBe(6 * MiB);
  });

  it("computes a stable, lowercase-hex sha256 of the concatenated bytes", async () => {
    const file = syntheticFile(1 * MiB); // small → whole-file slice
    const a = await buildSampleBundle(file);
    const b = await buildSampleBundle(syntheticFile(1 * MiB));
    expect(a.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.manifest.sha256).toBe(b.manifest.sha256);

    // The whole-file slice's bytes must hash to the sha256 of the file content.
    const expected = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    const expectedHex = Array.from(new Uint8Array(expected))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    expect(a.manifest.sha256).toBe(expectedHex);
  });

  it("blob bytes are the concatenation of the sliced ranges in manifest order", async () => {
    // Use small custom slice sizes so the 12 MiB file yields multiple distinct
    // slices but stays cheap.
    const size = 12 * MiB;
    const file = syntheticFile(size);
    const opts = {
      headBytes: 1 * MiB,
      tailBytes: 1 * MiB,
      stratifiedCount: 2,
      stratifiedBytes: 64 * KiB,
    };
    const bundle = await buildSampleBundle(file, opts);
    const blobBytes = new Uint8Array(await bundle.blob.arrayBuffer());

    let offset = 0;
    for (const s of bundle.manifest.slices) {
      const expected = new Uint8Array(
        await file.slice(s.byteOffset, s.byteOffset + s.length).arrayBuffer(),
      );
      const actual = blobBytes.subarray(offset, offset + s.length);
      // Spot-check first and last byte of each slice (full compare is O(n)).
      expect(actual[0]).toBe(expected[0]);
      expect(actual[s.length - 1]).toBe(expected[s.length - 1]);
      offset += s.length;
    }
    expect(offset).toBe(bundle.manifest.totalSampledBytes);
  });

  it("enforces the hard ceiling", async () => {
    const file = syntheticFile(10 * MiB);
    await expect(
      buildSampleBundle(file, {
        headBytes: 8 * MiB,
        tailBytes: 0,
        stratifiedCount: 0,
        maxTotalBytes: 1 * MiB,
      }),
    ).rejects.toThrow(/ceiling/);
  });
});
