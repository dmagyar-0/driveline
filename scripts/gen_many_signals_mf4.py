#!/usr/bin/env python3
"""Generate an MF4 with a large number of scalar channels.

Used to stress the Channels drawer windowing (perf work on the
`channels-tab-performance` branch). Not a committed fixture — it lands
in `sample-data/` only so the Vite dev server can serve it under
`/sample-data/<name>` for the Playwright verification spec.

Channels are grouped into batches that share a small timebase so the
file stays a few MB and generation is fast; per-channel sample count is
deliberately tiny because the drawer cost we care about scales with the
*number of channels*, not samples.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from asammdf import MDF, Signal

UNITS = ["m/s", "rad/s", "m/s^2", "deg", "V", "A", "degC", "Pa", "%", ""]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=12000)
    ap.add_argument("--per-group", type=int, default=250)
    ap.add_argument("--samples", type=int, default=16)
    ap.add_argument("--out", default="sample-data/many-signals.mf4")
    args = ap.parse_args()

    t = np.arange(0, args.samples, dtype=np.float64) * 0.1  # 10 Hz timebase

    mdf = MDF(version="4.10")
    mdf.header.start_time = datetime(2024, 1, 1, tzinfo=timezone.utc)

    made = 0
    while made < args.count:
        n = min(args.per_group, args.count - made)
        sigs = []
        for j in range(n):
            idx = made + j
            # Cheap distinct waveform per channel so plots aren't flat.
            samples = np.sin(t * (1 + (idx % 7) * 0.3) + idx * 0.01)
            sigs.append(
                Signal(
                    samples=samples.astype(np.float64),
                    timestamps=t,
                    name=f"sig_{idx:05d}",
                    unit=UNITS[idx % len(UNITS)],
                )
            )
        mdf.append(sigs, comment=f"batch {made // args.per_group}")
        made += n

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    mdf.save(str(out), overwrite=True)
    print(f"wrote {out} — {made} channels, {out.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
