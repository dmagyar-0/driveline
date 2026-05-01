// AVCDecoderConfigurationRecord (`avcC`) helpers used by the lazy mp4 path
// in `videoDecodeOps.ts`. The worker drives `VideoDecoder` in AVC (length-
// prefixed) mode for mp4 sources: feed raw mp4 sample bytes straight to
// `decode()` and let the decoder pull SPS/PPS out of the synthesised
// `description` here. That keeps us out of the Annex-B ordering minefield
// that broke ffmpeg-encoded mp4s carrying a leading AUD.
//
// Pure functions, no I/O, no shared state — covered by `mp4AnnexB.test.ts`.

const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;

/**
 * Synthesise an AVCDecoderConfigurationRecord (the `avcC` payload, ISO/IEC
 * 14496-15 §5.3.3.1.2) from the SPS+PPS NAL bytes returned by the wasm
 * sidecar reader. The result becomes `VideoDecoderConfig.description`.
 *
 * Assumes a single SPS and single PPS (the universal case for the mp4s
 * Driveline ingests; matches what `Mp4SidecarReader` exposes) and a 4-byte
 * NAL length prefix (`lengthSizeMinusOne = 3`, the ffmpeg/x264 default).
 */
export function buildAvccDescription(
  sps: Uint8Array,
  pps: Uint8Array,
): Uint8Array {
  if (sps.length < 4) {
    throw new Error(
      `buildAvccDescription: SPS too short (${sps.length} bytes; need ≥4 for profile/level)`,
    );
  }
  if (pps.length === 0) {
    throw new Error("buildAvccDescription: PPS is empty");
  }
  // SPS layout: [0]=NAL header (0x67), [1]=profile_idc, [2]=constraint flags,
  // [3]=level_idc. Mirrors the bytes the avcC box encodes in its first four
  // header fields — we just copy them across.
  const total = 6 + 2 + sps.length + 1 + 2 + pps.length;
  const out = new Uint8Array(total);
  let pos = 0;
  out[pos++] = 0x01; // configurationVersion
  out[pos++] = sps[1]; // AVCProfileIndication
  out[pos++] = sps[2]; // profile_compatibility
  out[pos++] = sps[3]; // AVCLevelIndication
  out[pos++] = 0xfc | 0x03; // reserved (6 bits) | lengthSizeMinusOne = 3 (4-byte length)
  out[pos++] = 0xe0 | 0x01; // reserved (3 bits) | numOfSequenceParameterSets = 1
  out[pos++] = (sps.length >> 8) & 0xff;
  out[pos++] = sps.length & 0xff;
  out.set(sps, pos);
  pos += sps.length;
  out[pos++] = 0x01; // numOfPictureParameterSets = 1
  out[pos++] = (pps.length >> 8) & 0xff;
  out[pos++] = pps.length & 0xff;
  out.set(pps, pos);
  return out;
}

/**
 * Drop in-band SPS (NAL type 7) and PPS (NAL type 8) NAL units from a
 * 4-byte length-prefixed AVCC sample. Returns the same bytes when the
 * sample carries no parameter sets (the common ffmpeg case), or a fresh
 * buffer with the param-set NALs filtered out otherwise.
 *
 * Why: x264 with `repeat-headers=1` (and some broadcast-style encoders)
 * embeds SPS/PPS at the head of every keyframe sample, BEFORE the AUD.
 * Feeding that to `VideoDecoder` in AVC mode confuses Chrome's H.264
 * parser — the leading SPS/PPS look like the tail of a phantom previous
 * access unit, and when the AUD arrives the parser starts a fresh AU
 * with no parameter sets, so the slice silently fails to decode.
 * Symptom: priming chunks emit a few frames, then the decoder stops
 * producing output, the panel queue drains, and lag grows unbounded
 * until the user seeks. The avcC `description` already carries SPS/PPS,
 * so removing the redundant in-band copies is safe and the standard
 * fix for this pattern.
 *
 * Assumes the 4-byte NAL length prefix that `buildAvccDescription`
 * writes (`lengthSizeMinusOne = 3`, the ffmpeg/x264 default — see the
 * note in `buildAvccDescription`). Truncated samples are returned
 * verbatim; the decoder will surface a malformed-frame error rather
 * than silently swallowing them.
 */
export function stripInlineParameterSets(sample: Uint8Array): Uint8Array {
  let needsStrip = false;
  let i = 0;
  while (i + 4 <= sample.length) {
    const nalLen =
      ((sample[i] << 24) >>> 0) |
      (sample[i + 1] << 16) |
      (sample[i + 2] << 8) |
      sample[i + 3];
    const headerPos = i + 4;
    if (nalLen === 0 || headerPos >= sample.length) break;
    const end = headerPos + nalLen;
    if (end > sample.length) break;
    const nalType = sample[headerPos] & 0x1f;
    if (nalType === NAL_TYPE_SPS || nalType === NAL_TYPE_PPS) {
      needsStrip = true;
      break;
    }
    i = end;
  }
  if (!needsStrip) return sample;
  // Second pass: copy keep-list NAL units into a fresh buffer.
  const keep: Uint8Array[] = [];
  let total = 0;
  i = 0;
  while (i + 4 <= sample.length) {
    const nalLen =
      ((sample[i] << 24) >>> 0) |
      (sample[i + 1] << 16) |
      (sample[i + 2] << 8) |
      sample[i + 3];
    const headerPos = i + 4;
    if (nalLen === 0 || headerPos >= sample.length) break;
    const end = headerPos + nalLen;
    if (end > sample.length) break;
    const nalType = sample[headerPos] & 0x1f;
    if (nalType !== NAL_TYPE_SPS && nalType !== NAL_TYPE_PPS) {
      const unit = sample.subarray(i, end);
      keep.push(unit);
      total += unit.length;
    }
    i = end;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const u of keep) {
    out.set(u, pos);
    pos += u.length;
  }
  return out;
}
