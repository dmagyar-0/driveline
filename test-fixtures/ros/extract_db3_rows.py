#!/usr/bin/env python3
"""Extract a compact subsample of rows from a rosbag2 SQLite (.db3) bag.

`data-core`'s `Ros2Db3Reader` is constructed from *already-extracted* rows
(the real app extracts them in JS via sql.js, since SQLite cannot be parsed on
the wasm32 target). Rust cannot read SQLite either, so for the native test we
dump a small JSON snapshot of the relevant rows here and `include_str!` it in
`crates/data-core/tests/ros2_db3_reader.rs`.

Usage (regenerate the committed fixture):

    /tmp/rosfix/venv/bin/python \
        test-fixtures/ros/extract_db3_rows.py \
        test-fixtures/ros/synth_imu.db3 \
        test-fixtures/ros/synth_imu_rows.json

Only stdlib (`sqlite3`, `base64`, `json`) is used, so any Python 3 works; the
venv at /tmp/rosfix is only needed if you want to regenerate the .db3 itself.

Output JSON shape (kept < 100 KB by subsampling):

    {
      "topics": [[name, type], ...],          # indexed 0..T
      "rows":   [[topic_idx, ts_ns, blob_b64], ...]   # time-sorted
    }
"""

import base64
import json
import sqlite3
import sys

# Keep ~1 in N messages per topic so the committed fixture stays small while
# still covering both topics and several samples each.
SUBSAMPLE = {
    "/imu/data": 5,      # 100 msgs -> 20
    "/temperature": 1,   # 10 msgs -> 10
}
DEFAULT_STRIDE = 5


def main() -> int:
    db_path = sys.argv[1] if len(sys.argv) > 1 else "synth_imu.db3"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "synth_imu_rows.json"

    con = sqlite3.connect(db_path)
    cur = con.cursor()

    # topics, ordered by id, mapped to a dense 0..T index.
    topic_rows = list(cur.execute("SELECT id, name, type FROM topics ORDER BY id"))
    id_to_idx = {tid: i for i, (tid, _name, _type) in enumerate(topic_rows)}
    topics = [[name, ttype] for (_tid, name, ttype) in topic_rows]
    idx_to_name = {i: topics[i][0] for i in range(len(topics))}

    # Per-topic running counter so we can stride within each topic.
    per_topic_seen: dict[int, int] = {}
    rows = []
    for topic_id, ts_ns, data in cur.execute(
        "SELECT topic_id, timestamp, data FROM messages ORDER BY timestamp, id"
    ):
        idx = id_to_idx[topic_id]
        n = per_topic_seen.get(idx, 0)
        per_topic_seen[idx] = n + 1
        stride = SUBSAMPLE.get(idx_to_name[idx], DEFAULT_STRIDE)
        if n % stride != 0:
            continue
        rows.append([idx, int(ts_ns), base64.b64encode(data).decode("ascii")])

    out = {"topics": topics, "rows": rows}
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {out_path}: {len(topics)} topics, {len(rows)} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
