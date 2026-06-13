/**
 * Sample bundle builder for the Format Agent (docs/12 §4.3).
 *
 * Builds a `SampleBundle` from the local `File` WITHOUT reading it fully — only
 * `File.slice()` is used, so a 1.4 GB log costs ~9 MiB of reads. The model
 * receives the head (magic/schema blocks), the tail (indexes/footers), and a
 * handful of stratified interior slices (mid-file framing, chunk boundaries,
 * mode changes). The manifest records every slice's ABSOLUTE byte offset so the
 * model can reason about where in the real file a candidate framing lands.
 *
 * The consent dialog (later UI subagent) renders the manifest verbatim before
 * anything is uploaded.
 */

import type { SampleBundle, SampleManifest, SampleSlice } from "./types";

/** Sampler knobs. All sizes in bytes; sensible defaults from docs/12 §4.3. */
export interface SamplerOptions {
  /** Head slice size (default 4 MiB). */
  headBytes?: number;
  /** Tail slice size (default 1 MiB). */
  tailBytes?: number;
  /** Number of evenly-spaced interior slices (default 8). */
  stratifiedCount?: number;
  /** Size of each stratified slice (default 256 KiB). */
  stratifiedBytes?: number;
  /** Hard ceiling on total sampled bytes (default 64 MiB, docs/12 §4.3). */
  maxTotalBytes?: number;
}

const MiB = 1024 * 1024;
const KiB = 1024;

const DEFAULTS: Required<SamplerOptions> = {
  headBytes: 4 * MiB,
  tailBytes: 1 * MiB,
  stratifiedCount: 8,
  stratifiedBytes: 256 * KiB,
  maxTotalBytes: 64 * MiB,
};

/** A half-open byte interval `[start, end)` into the original file. */
interface Interval {
  start: number;
  end: number;
  kind: SampleSlice["kind"];
}

/**
 * Compute the (non-overlapping, in-order) intervals to sample. Handles small
 * files gracefully: if head+tail already covers the file, we return a single
 * whole-file slice rather than double-counting overlapping ranges.
 */
export function planSlices(
  fileSize: number,
  options?: SamplerOptions,
): SampleSlice[] {
  const opts = { ...DEFAULTS, ...options };
  if (fileSize <= 0) return [];

  const headBytes = Math.min(opts.headBytes, fileSize);
  const tailBytes = Math.min(opts.tailBytes, fileSize);

  // Small file: head and tail would overlap (or cover everything). Just take
  // the whole file once.
  if (headBytes + tailBytes >= fileSize) {
    return normalize([{ start: 0, end: fileSize, kind: "head" }], fileSize);
  }

  const intervals: Interval[] = [];
  intervals.push({ start: 0, end: headBytes, kind: "head" });

  // Stratified interior slices, evenly spaced across the gap between the head
  // and the tail. Place each slice's START at an even fraction of the interior
  // region so they don't cluster at one edge.
  const interiorStart = headBytes;
  const interiorEnd = fileSize - tailBytes;
  const interiorSpan = interiorEnd - interiorStart;
  const sliceBytes = Math.min(opts.stratifiedBytes, Math.max(0, interiorSpan));
  if (sliceBytes > 0 && opts.stratifiedCount > 0) {
    for (let i = 0; i < opts.stratifiedCount; i++) {
      // Spread starts over [interiorStart, interiorEnd - sliceBytes].
      const room = interiorSpan - sliceBytes;
      const frac =
        opts.stratifiedCount === 1 ? 0.5 : i / (opts.stratifiedCount - 1);
      const start = Math.floor(interiorStart + room * frac);
      intervals.push({ start, end: start + sliceBytes, kind: "stratified" });
    }
  }

  intervals.push({ start: fileSize - tailBytes, end: fileSize, kind: "tail" });

  return normalize(intervals, fileSize);
}

/**
 * Sort, clamp, and merge overlapping/adjacent intervals so no byte is sampled
 * twice and the total stays minimal. A merged slice keeps the kind of its
 * first contributing interval (head > stratified > tail by position).
 */
function normalize(intervals: Interval[], fileSize: number): SampleSlice[] {
  const clamped = intervals
    .map((iv) => ({
      start: Math.max(0, Math.min(iv.start, fileSize)),
      end: Math.max(0, Math.min(iv.end, fileSize)),
      kind: iv.kind,
    }))
    .filter((iv) => iv.end > iv.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Interval[] = [];
  for (const iv of clamped) {
    const last = merged[merged.length - 1];
    if (last && iv.start < last.end) {
      // Strict overlap only — extend the previous interval, keep its kind. We
      // do NOT merge merely-adjacent slices (start == end): a stratified slice
      // that ends exactly where the tail begins stays a distinct slice, so the
      // head/stratified/tail provenance is preserved while still never
      // sampling a byte twice.
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }

  // Assign bundle offsets in manifest order.
  let bundleOffset = 0;
  return merged.map((iv) => {
    const length = iv.end - iv.start;
    const slice: SampleSlice = {
      kind: iv.kind,
      byteOffset: iv.start,
      length,
      bundleOffset,
    };
    bundleOffset += length;
    return slice;
  });
}

/** Hex-encode a byte buffer (for the sha256 provenance string). */
function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Build the upload bundle from a local file. Reads only the planned slices via
 * `File.slice()`, concatenates them into one binary blob (in manifest order),
 * and computes a sha256 over the concatenation for provenance + Files-API
 * dedup. Never materialises the whole file.
 */
export async function buildSampleBundle(
  file: File,
  options?: SamplerOptions,
): Promise<SampleBundle> {
  const opts = { ...DEFAULTS, ...options };
  const slices = planSlices(file.size, options);

  // Defensive: enforce the hard ceiling even if odd options were passed.
  const total = slices.reduce((sum, s) => sum + s.length, 0);
  if (total > opts.maxTotalBytes) {
    throw new Error(
      `sample bundle ${total} bytes exceeds the ${opts.maxTotalBytes}-byte ceiling`,
    );
  }

  // Read each planned slice. `File.slice()` returns a Blob view; we only
  // arrayBuffer() the small planned ranges, never the whole file.
  const parts: ArrayBuffer[] = [];
  for (const s of slices) {
    const blobSlice = file.slice(s.byteOffset, s.byteOffset + s.length);
    parts.push(await blobSlice.arrayBuffer());
  }

  const blob = new Blob(parts, { type: "application/octet-stream" });
  const concatenated = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", concatenated);
  const sha256 = toHex(digest);

  const manifest: SampleManifest = {
    filename: file.name,
    fileSize: file.size,
    sha256,
    slices,
    totalSampledBytes: total,
  };

  return { manifest, blob };
}
