// JS-side counterparts to the Rust unit tests in
// `crates/data-core/src/mp4_sidecar.rs::tests::avcc_to_annexb_*`.

import { describe, expect, it } from "vitest";
import {
  annexBHasSps,
  avccToAnnexB,
  buildFirstAnnexBChunk,
} from "./mp4AnnexB";

describe("avccToAnnexB", () => {
  it("drops zero-length NAL units", () => {
    const input = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, // len=0, skipped
      0x00, 0x00, 0x00, 0x01, 0x05, // len=1, NAL=0x05
    ]);
    expect(Array.from(avccToAnnexB(input))).toEqual([
      0x00, 0x00, 0x00, 0x01, 0x05,
    ]);
  });

  it("walks multiple NALs and tolerates truncation", () => {
    const ok = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x05, // len=1
      0x00, 0x00, 0x00, 0x02, 0xaa, 0xbb, // len=2
    ]);
    expect(Array.from(avccToAnnexB(ok))).toEqual([
      0x00, 0x00, 0x00, 0x01, 0x05, 0x00, 0x00, 0x00, 0x01, 0xaa, 0xbb,
    ]);

    const truncated = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x05,
      0x00, 0x00, 0x00, 0x63, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
    ]);
    expect(Array.from(avccToAnnexB(truncated))).toEqual([
      0x00, 0x00, 0x00, 0x01, 0x05,
    ]);
  });
});

describe("annexBHasSps", () => {
  it("returns true when an SPS NAL (type 7) is present", () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e,
    ]);
    expect(annexBHasSps(data)).toBe(true);
  });

  it("returns false when no SPS is present", () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x05, 0xff, 0xee,
    ]);
    expect(annexBHasSps(data)).toBe(false);
  });

  it("recognises 3-byte start codes", () => {
    const data = new Uint8Array([0x00, 0x00, 0x01, 0x67, 0x42, 0x00]);
    expect(annexBHasSps(data)).toBe(true);
  });
});

describe("buildFirstAnnexBChunk", () => {
  it("prepends SPS+PPS to a body that lacks an inline SPS", () => {
    const sps = new Uint8Array([0x67, 0x42]);
    const pps = new Uint8Array([0x68, 0xeb]);
    const body = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x05]);
    const out = buildFirstAnnexBChunk(body, sps, pps);
    expect(annexBHasSps(out)).toBe(true);
    // Body must still appear at the tail.
    expect(Array.from(out.slice(out.length - body.length))).toEqual(
      Array.from(body),
    );
  });

  it("leaves the body unchanged when an inline SPS is already present", () => {
    const sps = new Uint8Array([0x67, 0x42]);
    const pps = new Uint8Array([0x68, 0xeb]);
    const body = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e,
      0x00, 0x00, 0x00, 0x01, 0x05,
    ]);
    const out = buildFirstAnnexBChunk(body, sps, pps);
    expect(out).toBe(body);
  });
});
