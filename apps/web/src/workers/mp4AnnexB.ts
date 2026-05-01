// AVCDecoderConfigurationRecord (`avcC`) helpers used by the lazy mp4 path
// in `videoDecodeOps.ts`. The worker drives `VideoDecoder` in AVC (length-
// prefixed) mode for mp4 sources: feed raw mp4 sample bytes straight to
// `decode()` and let the decoder pull SPS/PPS out of the synthesised
// `description` here. That keeps us out of the Annex-B ordering minefield
// that broke ffmpeg-encoded mp4s carrying a leading AUD.
//
// Pure functions, no I/O, no shared state — covered by `mp4AnnexB.test.ts`.

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
