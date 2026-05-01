// Coverage for `readMp4HeaderBytes`: the box-walking helper that lets the
// store hand wasm just `ftyp + moov` instead of the entire (possibly
// multi-GB) mp4 file. The tests build synthetic top-level box structures
// — the byte content of `moov` itself doesn't matter here, only that the
// walker correctly skips `mdat` without allocating its body.

import { describe, expect, it, vi } from "vitest";
import { readMp4HeaderBytes } from "./mp4HeaderSlice";

/** Build a top-level mp4 box: 4-byte BE size + 4-char type + payload. */
function box(type: string, payload: Uint8Array): Uint8Array {
  if (type.length !== 4) throw new Error("box type must be 4 chars");
  const total = 8 + payload.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

/** Build a largesize-encoded box (size=1, then 8-byte largesize). */
function largeBox(type: string, payload: Uint8Array): Uint8Array {
  const total = 16 + payload.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  view.setBigUint64(8, BigInt(total), false);
  out.set(payload, 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const p of parts) {
    out.set(p, cursor);
    cursor += p.length;
  }
  return out;
}

/**
 * `File` wrapper that records every `slice()` call so tests can assert
 * the walker never reads `mdat` bytes. The underlying `Blob.slice` is
 * still honoured — we just observe the `(start, end)` ranges.
 */
function instrumentedFile(bytes: Uint8Array): {
  file: File;
  reads: Array<[number, number]>;
} {
  // Cast: `Uint8Array<ArrayBufferLike>` widens through the function
  // boundary; the `BlobPart` typedef wants `ArrayBufferView<ArrayBuffer>`
  // specifically, but every Uint8Array buffer is one at runtime.
  const file = new File([bytes as BlobPart], "test.mp4");
  const reads: Array<[number, number]> = [];
  const orig = file.slice.bind(file);
  vi.spyOn(file, "slice").mockImplementation((start = 0, end = bytes.length) => {
    reads.push([Number(start), Number(end)]);
    return orig(start, end);
  });
  return { file, reads };
}

describe("readMp4HeaderBytes", () => {
  it("extracts ftyp + moov from a [ftyp][mdat][moov] file", async () => {
    const ftyp = box("ftyp", new Uint8Array([1, 2, 3, 4]));
    // 1 MiB of "mdat" payload — must never appear in any read range.
    const mdatPayload = new Uint8Array(1024 * 1024);
    mdatPayload.fill(0xab);
    const mdat = box("mdat", mdatPayload);
    const moov = box("moov", new Uint8Array([0x10, 0x20, 0x30]));
    const { file, reads } = instrumentedFile(concat(ftyp, mdat, moov));

    const out = await readMp4HeaderBytes(file);
    expect(Array.from(out)).toEqual([...ftyp, ...moov]);

    // No read should cover the interior of the mdat payload. The mdat
    // header itself sits at [ftyp.length, ftyp.length + 8) and is the
    // 16-byte probe read; nothing else should touch it.
    const mdatStart = ftyp.length;
    const mdatEnd = mdatStart + mdat.length;
    for (const [lo, hi] of reads) {
      const overlaps = lo < mdatEnd && hi > mdatStart + 16;
      expect(overlaps).toBe(false);
    }
  });

  it("works with [ftyp][moov][mdat] (moov-at-front) layouts", async () => {
    const ftyp = box("ftyp", new Uint8Array([0xaa]));
    const moov = box("moov", new Uint8Array([0xbb, 0xcc]));
    const mdat = box("mdat", new Uint8Array(4096));
    const { file } = instrumentedFile(concat(ftyp, moov, mdat));

    const out = await readMp4HeaderBytes(file);
    expect(Array.from(out)).toEqual([...ftyp, ...moov]);
  });

  it("skips free / wide / skip filler boxes", async () => {
    const ftyp = box("ftyp", new Uint8Array([0x01]));
    const wide = box("wide", new Uint8Array());
    const free = box("free", new Uint8Array(64));
    const skip = box("skip", new Uint8Array(32));
    const moov = box("moov", new Uint8Array([0x42]));
    const { file } = instrumentedFile(concat(ftyp, wide, free, skip, moov));

    const out = await readMp4HeaderBytes(file);
    expect(Array.from(out)).toEqual([...ftyp, ...moov]);
  });

  it("handles a 64-bit largesize mdat between ftyp and moov", async () => {
    const ftyp = box("ftyp", new Uint8Array([0x01, 0x02]));
    // largeBox uses size=1 + 8-byte largesize. Body kept small for the
    // test, but the parser must accept the encoding regardless.
    const mdatBig = largeBox("mdat", new Uint8Array(2048));
    const moov = box("moov", new Uint8Array([0x99]));
    const { file } = instrumentedFile(concat(ftyp, mdatBig, moov));

    const out = await readMp4HeaderBytes(file);
    expect(Array.from(out)).toEqual([...ftyp, ...moov]);
  });

  it("throws when ftyp is missing", async () => {
    const moov = box("moov", new Uint8Array([0x11]));
    const { file } = instrumentedFile(moov);
    await expect(readMp4HeaderBytes(file)).rejects.toThrow(/ftyp/);
  });

  it("throws when moov is missing", async () => {
    const ftyp = box("ftyp", new Uint8Array([0x22]));
    const mdat = box("mdat", new Uint8Array(16));
    const { file } = instrumentedFile(concat(ftyp, mdat));
    await expect(readMp4HeaderBytes(file)).rejects.toThrow(/moov/);
  });

  it("throws on a truncated box header", async () => {
    // Only 4 bytes — not enough for an 8-byte box header.
    const { file } = instrumentedFile(new Uint8Array([0, 0, 0, 8]));
    await expect(readMp4HeaderBytes(file)).rejects.toThrow(/truncated/);
  });

  it("throws when a declared box size escapes the file", async () => {
    // ftyp size says 32 bytes but only 16 are present.
    const malformed = new Uint8Array(16);
    const view = new DataView(malformed.buffer);
    view.setUint32(0, 32, false);
    malformed.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
    const { file } = instrumentedFile(malformed);
    await expect(readMp4HeaderBytes(file)).rejects.toThrow(/past EOF/);
  });
});
