#!/usr/bin/env python3
"""Generate `sample.acme` — a synthetic *unknown* binary log format used to
exercise the Format Agent / RecipeReader path (docs/12-format-agent.md).

This stands in for a proprietary DAQ dump: a small fixed header followed by
fixed-size little-endian records at 100 Hz. It is intentionally NOT one of
Driveline's known formats, so dropping it triggers the unknown-format flow.

Layout (little-endian throughout):

  Header (32 bytes):
    0   8s   magic            b"ACMELOG\\x01"
    8   I    record_size      (= 32)
    12  I    record_count
    16  Q    start_epoch_us   (absolute microseconds, UTC)
    24  8x   reserved

  Record (32 bytes):
    0   Q    t_us             absolute microseconds since Unix epoch (UTC)
    8   f    speed_mps        vehicle speed (m/s)
    12  f    steering_deg     steering wheel angle (deg)
    16  i    rpm              engine RPM
    20  B    gear             0=P 1=R 2=N 3=D
    21  B    brake            0/1
    22  h    accel_x_mg       longitudinal accel (milli-g)
    24  i    lat_1e7          latitude  * 1e7 (deg)
    28  i    lon_1e7          longitude * 1e7 (deg)
"""

import math
import struct
import sys
from pathlib import Path

MAGIC = b"ACMELOG\x01"
RECORD_SIZE = 32
HZ = 100
DURATION_S = 30
START_EPOCH_US = 1_704_067_200_000_000  # 2024-01-01T00:00:00Z, in microseconds

# A gentle GPS track near San Francisco; lat/lon stored as fixed-point 1e-7 deg.
BASE_LAT = 37.7749
BASE_LON = -122.4194


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("sample.acme")
    n = HZ * DURATION_S
    dt_us = 1_000_000 // HZ

    records = bytearray()
    for i in range(n):
        t_us = START_EPOCH_US + i * dt_us
        ph = i / HZ
        speed = 12.0 + 8.0 * math.sin(ph * 0.4)            # ~4..20 m/s
        steering = 25.0 * math.sin(ph * 0.9)               # +/- 25 deg
        rpm = int(1200 + 220.0 * speed)                    # roughly speed-coupled
        gear = 3 if speed > 3.0 else 1                     # D while moving, R at rest
        brake = 1 if math.sin(ph * 1.3) < -0.85 else 0     # occasional braking
        accel_mg = int(800.0 * math.cos(ph * 0.4))         # milli-g
        lat = BASE_LAT + 0.0008 * math.sin(ph * 0.2)
        lon = BASE_LON + 0.0008 * math.cos(ph * 0.2)
        records += struct.pack(
            "<QffiBBhii",
            t_us,
            speed,
            steering,
            rpm,
            gear,
            brake,
            accel_mg,
            int(round(lat * 1e7)),
            int(round(lon * 1e7)),
        )

    assert len(records) == n * RECORD_SIZE, (len(records), n * RECORD_SIZE)
    header = struct.pack("<8sIIQ8x", MAGIC, RECORD_SIZE, n, START_EPOCH_US)
    out_path.write_bytes(header + records)
    print(f"wrote {out_path} ({len(header) + len(records)} bytes, {n} records)")


if __name__ == "__main__":
    main()
