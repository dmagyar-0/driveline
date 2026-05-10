#!/usr/bin/env python3
"""Patch a standard AVCC MP4 in-place to a non-standard 'Annex-B MP4'.

The output is bit-identical to the input *except* that every 4-byte NAL
length prefix inside the `mdat` box is overwritten with the H.264 Annex-B
start code `00 00 00 01`. Sample sizes therefore do not change, so all
moov tables (`stsz`/`stsc`/`stco`/`co64`/`stss`) remain valid. The file is
not spec-compliant — it is intentionally crafted to exercise the
videoDecoder path that was removed in commit e2f63a0.

Usage:
    python3 scripts/video/make_annexb_mp4.py IN.mp4 OUT.mp4
"""
import struct
import sys


def find_box(data: bytes, want: bytes) -> tuple[int, int]:
    """Return (header_end_offset, content_end_offset) for the first
    top-level box whose 4-char type matches `want`.
    """
    cursor = 0
    n = len(data)
    while cursor + 8 <= n:
        size32 = struct.unpack(">I", data[cursor:cursor + 4])[0]
        kind = data[cursor + 4:cursor + 8]
        if size32 == 1:
            large = struct.unpack(">Q", data[cursor + 8:cursor + 16])[0]
            header_len = 16
            total = large
        elif size32 == 0:
            header_len = 8
            total = n - cursor
        else:
            header_len = 8
            total = size32
        if kind == want:
            return cursor + header_len, cursor + total
        cursor += total
    raise SystemExit(f"box {want!r} not found")


def patch_mdat(data: bytearray, start: int, end: int) -> int:
    """Walk `data[start:end]` as a stream of length-prefixed NAL units and
    overwrite each 4-byte length with the Annex-B start code 00 00 00 01.
    Returns the number of NAL units patched.
    """
    cursor = start
    count = 0
    while cursor + 4 <= end:
        nal_len = struct.unpack(">I", bytes(data[cursor:cursor + 4]))[0]
        if nal_len == 0:
            raise SystemExit(f"zero-length NAL at offset {cursor}")
        if cursor + 4 + nal_len > end:
            raise SystemExit(
                f"NAL of length {nal_len} at {cursor} runs past mdat end {end}"
            )
        # Overwrite the length prefix with an Annex-B start code.
        data[cursor:cursor + 4] = b"\x00\x00\x00\x01"
        cursor += 4 + nal_len
        count += 1
    if cursor != end:
        raise SystemExit(
            f"mdat parse stopped at {cursor}, expected end {end} (truncated NAL)"
        )
    return count


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    src, dst = argv[1], argv[2]
    with open(src, "rb") as f:
        data = bytearray(f.read())
    mdat_start, mdat_end = find_box(bytes(data), b"mdat")
    nals = patch_mdat(data, mdat_start, mdat_end)
    with open(dst, "wb") as f:
        f.write(data)
    print(f"patched {nals} NAL units in mdat[{mdat_start}:{mdat_end}] → {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
