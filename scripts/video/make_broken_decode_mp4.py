#!/usr/bin/env python3
"""Patch a standard AVCC MP4 to create a 'broken-decode' fixture for tests.

The output is structurally identical to the input — same boxes, same
sample sizes, same `avcC`, same `stsz`/`stsc`/`stco`/`stss`. The only
difference: every NAL payload byte inside `mdat` is XOR'd with 0xFF.
The 4-byte length prefixes are left intact so the AVCC parser walks
the samples without complaint. The decoder configures successfully
from the (untouched) `avcC`, but every `decode()` call errors out
because the NAL bodies are garbage. `frameIndex` stays at 0 while
the worker remains alive — exactly the "decoder is alive but
producing nothing" state the cursor-gating tests need.

Usage:
    python3 scripts/video/make_broken_decode_mp4.py IN.mp4 OUT.mp4
"""
import struct
import sys


def find_box(data: bytes, want: bytes) -> tuple[int, int]:
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


def corrupt_mdat(data: bytearray, start: int, end: int) -> int:
    """Walk `data[start:end]` as length-prefixed AVCC NAL units and XOR
    every payload byte with 0xFF. Length prefixes are preserved.
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
        payload_start = cursor + 4
        payload_end = payload_start + nal_len
        for i in range(payload_start, payload_end):
            data[i] ^= 0xFF
        cursor = payload_end
        count += 1
    if cursor != end:
        raise SystemExit(
            f"mdat parse stopped at {cursor}, expected end {end}"
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
    nals = corrupt_mdat(data, mdat_start, mdat_end)
    with open(dst, "wb") as f:
        f.write(data)
    print(
        f"corrupted {nals} NAL payloads in mdat[{mdat_start}:{mdat_end}] → {dst}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
