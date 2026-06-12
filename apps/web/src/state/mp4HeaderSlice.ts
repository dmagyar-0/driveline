// Read the `ftyp` + `moov` boxes from an mp4 `File` without ever pulling
// the (multi-GB) `mdat` payload into memory. This is the key fix for
// startup OOMs on large recordings: the previous flow called
// `File.arrayBuffer()` on the whole mp4 to hand bytes to the wasm
// parser, which allocated a contiguous gigabytes-sized buffer in the
// main thread before the lazy sample cache had a chance to take over.
//
// The wasm parser only inspects `ftyp` + `moov`; chunk offsets stored
// in `stco`/`co64` are never dereferenced during `open_pair` (verified
// in `crates/data-core/src/mp4_sidecar.rs` by
// `open_pair_accepts_header_only_buffer`). So we can walk the
// top-level box structure here, slice just those two boxes out of the
// source `File`, concatenate them, and feed the result to wasm.

const HEADER_PROBE_BYTES = 16;

/**
 * Read `ftyp` + `moov` from a source mp4 and return them concatenated.
 * Walks the top-level box structure via small `File.slice()` reads —
 * each `mdat` body is skipped without allocation. The returned buffer
 * is what the wasm `open_mp4_sidecar` parser actually needs; it's
 * typically a few MB even for multi-GB recordings.
 *
 * Throws if `ftyp` or `moov` are missing, or a box header is truncated
 * past the end of the file. The error message is suitable for surfacing
 * via the existing `lastOpenErrors` channel.
 */
export async function readMp4HeaderBytes(file: File): Promise<Uint8Array> {
  const total = file.size;
  let offset = 0;
  let ftyp: Uint8Array | null = null;
  let moov: Uint8Array | null = null;

  while (offset < total && (ftyp === null || moov === null)) {
    const probeEnd = Math.min(offset + HEADER_PROBE_BYTES, total);
    const probe = new Uint8Array(
      await file.slice(offset, probeEnd).arrayBuffer(),
    );
    if (probe.length < 8) {
      throw new Error(
        `mp4: truncated box header at offset ${offset} (need 8 bytes, have ${probe.length})`,
      );
    }
    const view = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
    const size32 = view.getUint32(0, false);
    const kind = String.fromCharCode(probe[4], probe[5], probe[6], probe[7]);

    let totalBoxBytes: number;
    if (size32 === 1) {
      if (probe.length < 16) {
        throw new Error(
          `mp4: truncated largesize header for box '${kind}' at offset ${offset}`,
        );
      }
      // ISO/IEC 14496-12 §4.2: 64-bit largesize follows the type field.
      // Practical mp4s stay well under 2^53; clamp to Number for the
      // slice() call below. A largesize > MAX_SAFE_INTEGER would mean
      // a single box ≥ 9 PB, which no recorder produces.
      const large = view.getBigUint64(8, false);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(
          `mp4: '${kind}' box largesize ${large} exceeds safe integer range`,
        );
      }
      totalBoxBytes = Number(large);
    } else if (size32 === 0) {
      // size==0 means "extends to EOF" — only valid on the last box.
      totalBoxBytes = total - offset;
    } else {
      totalBoxBytes = size32;
    }

    if (totalBoxBytes < 8) {
      throw new Error(
        `mp4: invalid box size ${totalBoxBytes} for '${kind}' at offset ${offset}`,
      );
    }
    const boxEnd = offset + totalBoxBytes;
    if (boxEnd > total) {
      throw new Error(
        `mp4: '${kind}' box at ${offset} extends past EOF (${boxEnd} > ${total})`,
      );
    }

    if (kind === "ftyp" && ftyp === null) {
      ftyp = new Uint8Array(await file.slice(offset, boxEnd).arrayBuffer());
    } else if (kind === "moov" && moov === null) {
      moov = new Uint8Array(await file.slice(offset, boxEnd).arrayBuffer());
    }
    // mdat / free / skip / wide / anything else: skipped without
    // reading. This is the whole point of the function.
    offset = boxEnd;
  }

  if (ftyp === null) {
    throw new Error("mp4: missing required 'ftyp' box");
  }
  if (moov === null) {
    throw new Error("mp4: missing required 'moov' box");
  }

  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  return out;
}
