// JS port of the AVCC → Annex-B helpers that used to live in
// `crates/data-core/src/mp4_sidecar.rs`. Moved here as part of the
// lazy-load refactor: encoded mp4 sample bytes now flow through the JS
// `Mp4SampleCache`, not the WASM reader, so the framing helpers come along.
//
// These are pure functions — no I/O, no shared state — and are unit-tested
// in `mp4AnnexB.test.ts`.

const ANNEX_B_START_CODE_4 = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

/**
 * Convert a sample body in 4-byte big-endian length-prefixed AVCC NAL
 * format to Annex-B (4-byte start code + NAL bytes per unit).
 *
 * Malformed or truncated inputs return whatever start codes + NAL bytes
 * were successfully walked before the break — the decoder will either
 * surface the bad frame as an `EncodingError` (expected) or skip it.
 * Mirrors the Rust `avcc_to_annexb` (formerly in `mp4_sidecar.rs`).
 */
export function avccToAnnexB(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i + 4 <= bytes.length) {
    const nalLen =
      ((bytes[i] << 24) >>> 0) |
      (bytes[i + 1] << 16) |
      (bytes[i + 2] << 8) |
      bytes[i + 3];
    i += 4;
    if (nalLen === 0) continue;
    const end = i + nalLen;
    if (end > bytes.length) break;
    out.push(0x00, 0x00, 0x00, 0x01);
    for (let k = i; k < end; k++) out.push(bytes[k]);
    i = end;
  }
  return new Uint8Array(out);
}

/**
 * Concatenate Annex-B framed bytes: an optional SPS+PPS prepend (start
 * codes already added) followed by the sample's Annex-B body. Used to
 * synthesise the first chunk emitted to the WebCodecs decoder per
 * session — the H.264 codec config is derived from inline SPS, so the
 * extradata must precede the first key frame.
 *
 * Skips the prepend when `body` already contains an inline SPS (x264
 * `repeat-headers=1`): the redundant SPS/PPS BEFORE the sample's AUD
 * violates the Annex-B ordering WebCodecs expects and causes
 * `DataError: key frame required`.
 */
export function buildFirstAnnexBChunk(
  body: Uint8Array,
  sps: Uint8Array,
  pps: Uint8Array,
): Uint8Array {
  if (annexBHasSps(body)) return body;
  const total =
    ANNEX_B_START_CODE_4.length +
    sps.length +
    ANNEX_B_START_CODE_4.length +
    pps.length +
    body.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  out.set(ANNEX_B_START_CODE_4, cursor);
  cursor += ANNEX_B_START_CODE_4.length;
  out.set(sps, cursor);
  cursor += sps.length;
  out.set(ANNEX_B_START_CODE_4, cursor);
  cursor += ANNEX_B_START_CODE_4.length;
  out.set(pps, cursor);
  cursor += pps.length;
  out.set(body, cursor);
  return out;
}

/**
 * True when `annexB` contains a NAL of type 7 (SPS). Scans for either
 * 3- or 4-byte start codes and inspects the first NAL byte of each.
 * Mirrors the Rust `annex_b_has_sps`.
 */
export function annexBHasSps(annexB: Uint8Array): boolean {
  let i = 0;
  while (i + 3 < annexB.length) {
    const is4 =
      annexB[i] === 0 &&
      annexB[i + 1] === 0 &&
      annexB[i + 2] === 0 &&
      annexB[i + 3] === 1;
    const is3 =
      annexB[i] === 0 &&
      annexB[i + 1] === 0 &&
      annexB[i + 2] === 1;
    if (!is4 && !is3) {
      i += 1;
      continue;
    }
    const nalStart = i + (is4 ? 4 : 3);
    if (nalStart >= annexB.length) return false;
    if ((annexB[nalStart] & 0x1f) === 7) return true;
    i = nalStart + 1;
  }
  return false;
}
