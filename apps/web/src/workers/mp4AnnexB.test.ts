// Unit coverage for the `avcC` description synthesiser used by the mp4
// videoDecode path. The reference layout matches ISO/IEC 14496-15 §5.3.3.1.2
// (AVCDecoderConfigurationRecord); a regression here surfaces in the worker
// as `VideoDecoderConfig.description` being rejected and the decoder falling
// back to "key frame required" the moment the first sample arrives.

import { describe, expect, it } from "vitest";
import { buildAvccDescription } from "./mp4AnnexB";

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
      buildAvccDescription(new Uint8Array([0x67, 0x64, 0x00]), new Uint8Array([0x68])),
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
