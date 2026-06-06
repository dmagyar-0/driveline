// Pure helpers for deriving an mp4's per-frame timestamps from a tabular
// column (Feature 1 — sidecar-less mp4 alignment, the Alpamayo camera case).
//
// Instead of writing a new video reader, we reuse the tested mp4+sidecar
// open path: synthesize the `.mp4.timestamps` sidecar text from a tabular
// source's converted time column (one line per row, row index == frame
// index, in decode order) and feed it to the EXISTING `openMp4Sidecar`.
//
// The sidecar format is fixed by `docs/05-video-pipeline.md`: UTF-8, no
// header, one `<frame_index>\t<timestamp_ns>\n` line per mp4 sample, the
// line count MUST equal the mp4 sample count. Timestamps are nanoseconds in
// `bigint` and are stringified directly — NEVER narrowed through `Number`.

/**
 * Build the `.mp4.timestamps` sidecar text from a converted ns time column.
 * Row `i` becomes the line `${i}\t${ts[i]}\n`, so the array order is the
 * frame (decode) order. Values are stringified from `bigint` so full ns
 * precision (~1.7e18) survives — there is no `Number` narrowing here.
 */
export function synthesizeSidecarText(ts: BigInt64Array): string {
  let out = "";
  for (let i = 0; i < ts.length; i++) {
    out += `${i}\t${ts[i].toString()}\n`;
  }
  return out;
}

/** Encode the synthesized sidecar text to the `Uint8Array` `openMp4Sidecar`
 *  expects (UTF-8). */
export function synthesizeSidecarBytes(ts: BigInt64Array): Uint8Array {
  return new TextEncoder().encode(synthesizeSidecarText(ts));
}

/** Raised when a tabular time column's length does not equal the mp4's sample
 *  count, so the synthesized sidecar would be rejected by the reader anyway.
 *  Surfaced to the user as a clear "doesn't match" message before opening. */
export class SidecarCountMismatchError extends Error {
  constructor(
    readonly tabularRows: number,
    readonly sampleCount: number,
  ) {
    super(
      `time column has ${tabularRows} rows but the video has ${sampleCount} ` +
        `frames — pick a source whose row count matches the frame count`,
    );
    this.name = "SidecarCountMismatchError";
  }
}

/**
 * Synthesize the sidecar bytes for an mp4 with `sampleCount` samples from a
 * tabular time column, validating the count FIRST. Throws
 * `SidecarCountMismatchError` when `ts.length !== sampleCount` so the caller
 * can show a clear error and decline to open. On a match the bytes are exactly
 * what `synthesizeSidecarBytes` produces.
 */
export function synthesizeSidecarBytesChecked(
  ts: BigInt64Array,
  sampleCount: number,
): Uint8Array {
  if (ts.length !== sampleCount) {
    throw new SidecarCountMismatchError(ts.length, sampleCount);
  }
  return synthesizeSidecarBytes(ts);
}
