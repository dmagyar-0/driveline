// Unit coverage for the `avcC` description synthesiser used by the mp4
// videoDecode path. The reference layout matches ISO/IEC 14496-15 §5.3.3.1.2
// (AVCDecoderConfigurationRecord); a regression here surfaces in the worker
// as `VideoDecoderConfig.description` being rejected and the decoder falling
// back to "key frame required" the moment the first sample arrives.

import { describe, expect, it } from "vitest";
import { buildAvccDescription, stripInlineParameterSets } from "./mp4AnnexB";

function avccNal(
  nalHeader: number,
  payload: number[] = [0xaa, 0xbb],
): number[] {
  const len = 1 + payload.length;
  return [
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    nalHeader,
    ...payload,
  ];
}

describe("buildAvccDescription", () => {
  it("emits a well-formed avcC record from a single SPS/PPS pair", () => {
    // High @ L4.2 SPS prefix; first byte is the NAL header (0x67 = SPS).
    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x2a, 0xac, 0xd9]);
    const pps = new Uint8Array([0x68, 0xeb, 0xec, 0xb2, 0x2c]);
    const out = buildAvccDescription(sps, pps);
    // Header: configurationVersion=1, profile=0x64, compat=0x00, level=0x2A,
    // lengthSizeMinusOne=3 (top 6 bits set), numOfSPS=1 (top 3 bits set).
    expect(Array.from(out.slice(0, 6))).toEqual([
      0x01, 0x64, 0x00, 0x2a, 0xff, 0xe1,
    ]);
    // SPS: 2-byte BE length followed by the SPS bytes.
    expect(out[6]).toBe(0x00);
    expect(out[7]).toBe(sps.length);
    expect(Array.from(out.slice(8, 8 + sps.length))).toEqual(Array.from(sps));
    // numOfPPS=1, then PPS length + bytes.
    const ppsCountPos = 8 + sps.length;
    expect(out[ppsCountPos]).toBe(0x01);
    expect(out[ppsCountPos + 1]).toBe(0x00);
    expect(out[ppsCountPos + 2]).toBe(pps.length);
    expect(Array.from(out.slice(ppsCountPos + 3))).toEqual(Array.from(pps));
  });

  it("throws when the SPS is shorter than 4 bytes", () => {
    // profile/compat/level live at SPS[1..4]; anything shorter would silently
    // emit a config the decoder can't validate.
    expect(() =>
      buildAvccDescription(
        new Uint8Array([0x67, 0x64, 0x00]),
        new Uint8Array([0x68]),
      ),
    ).toThrow(/SPS too short/);
  });

  it("throws when the PPS is empty", () => {
    expect(() =>
      buildAvccDescription(
        new Uint8Array([0x67, 0x64, 0x00, 0x2a]),
        new Uint8Array(),
      ),
    ).toThrow(/PPS is empty/);
  });
});

describe("stripInlineParameterSets", () => {
  // NAL header bytes used below — low 5 bits = NAL type:
  // 0x09 = AUD, 0x65 = IDR slice, 0x67 = SPS, 0x68 = PPS, 0x06 = SEI.
  it("returns the same buffer when no SPS/PPS NAL is present (ffmpeg AUD-only sample)", () => {
    const sample = new Uint8Array([
      ...avccNal(0x09, [0x10]), // AUD
      ...avccNal(0x65, [0x88, 0x84, 0x21, 0xa0]), // IDR slice
    ]);
    // Identity guarantee: the worker's hot path expects a no-op for the
    // common case so we don't allocate per sample on every steady-state pull.
    expect(stripInlineParameterSets(sample)).toBe(sample);
  });

  it("drops in-band SPS/PPS that precede the AUD (x264 repeat-headers=1)", () => {
    // The order that broke the AVC-mode decoder: SPS, PPS, AUD, slice. The
    // strip pass should leave [AUD][slice], which is the canonical AVC mode
    // sample shape Chrome's parser expects.
    const aud = avccNal(0x09, [0x10]);
    const slice = avccNal(0x65, [0x88, 0x84, 0x21, 0xa0]);
    const sample = new Uint8Array([
      ...avccNal(0x67, [0x64, 0x00, 0x2a, 0xac, 0xd9]), // SPS
      ...avccNal(0x68, [0xeb, 0xec, 0xb2, 0x2c]), // PPS
      ...aud,
      ...slice,
    ]);
    const out = stripInlineParameterSets(sample);
    expect(Array.from(out)).toEqual([...aud, ...slice]);
  });

  it("preserves SEI and other non-parameter-set NALs", () => {
    const aud = avccNal(0x09, [0x10]);
    const sei = avccNal(0x06, [0x05, 0xff]);
    const slice = avccNal(0x65, [0x88]);
    const sample = new Uint8Array([
      ...avccNal(0x67, [0x64, 0x00, 0x2a, 0xac, 0xd9]),
      ...aud,
      ...sei,
      ...avccNal(0x68, [0xeb]),
      ...slice,
    ]);
    const out = stripInlineParameterSets(sample);
    expect(Array.from(out)).toEqual([...aud, ...sei, ...slice]);
  });

  it("returns the input unchanged for a truncated sample (decoder surfaces the error)", () => {
    // 4-byte length declares 100 bytes but only 3 follow — strip should bail
    // out of the scan and hand the malformed sample through verbatim so the
    // EncodingError comes from `VideoDecoder` rather than us silently
    // mangling the byte stream.
    const sample = new Uint8Array([0x00, 0x00, 0x00, 0x64, 0x65, 0xaa, 0xbb]);
    expect(stripInlineParameterSets(sample)).toBe(sample);
  });
});
