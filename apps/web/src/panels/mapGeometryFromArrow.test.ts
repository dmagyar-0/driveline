// Contract test for the map-geometry Arrow decoder. The Rust core
// (`map_geometry.rs`) emits one row per frame (here always one, ts=0) with
// `points: List<Float32>`, `path_lengths: List<Int32>`, and `types:
// List<Utf8>`; this builds that exact shape with apache-arrow and asserts
// `decodeMapGeometry` reads back the polylines and their feature types. The
// producer side is covered by the Rust `map_geometry::tests`.

import { describe, it, expect } from "vitest";
import {
  Field,
  Float32,
  Int32,
  List,
  Table,
  TimeUnit,
  Timestamp,
  Utf8,
  Vector,
  makeData,
  tableToIPC,
} from "apache-arrow";
import { decodeMapGeometry } from "./mapGeometryFromArrow";

// Build a genuine List<Float32> column, one list per frame row.
function listF32(rows: number[][]): Vector {
  const flat: number[] = [];
  const offsets = new Int32Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) {
    flat.push(...rows[i]);
    offsets[i + 1] = offsets[i] + rows[i].length;
  }
  const child = makeData({
    type: new Float32(),
    data: Float32Array.from(flat),
  });
  const data = makeData({
    type: new List(new Field("item", new Float32(), true)),
    length: rows.length,
    valueOffsets: offsets,
    child,
  });
  return new Vector([data]);
}

// Build a genuine List<Int32> column, one list per frame row.
function listI32(rows: number[][]): Vector {
  const flat: number[] = [];
  const offsets = new Int32Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) {
    flat.push(...rows[i]);
    offsets[i + 1] = offsets[i] + rows[i].length;
  }
  const child = makeData({
    type: new Int32(),
    data: Int32Array.from(flat),
  });
  const data = makeData({
    type: new List(new Field("item", new Int32(), true)),
    length: rows.length,
    valueOffsets: offsets,
    child,
  });
  return new Vector([data]);
}

// Build a genuine List<Utf8> column, one list of strings per frame row.
function listUtf8(rows: string[][]): Vector {
  // Flatten to one Utf8 child holding every string across every row.
  const strings: string[] = [];
  const listOffsets = new Int32Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) {
    strings.push(...rows[i]);
    listOffsets[i + 1] = listOffsets[i] + rows[i].length;
  }
  const enc = new TextEncoder();
  const valueOffsets = new Int32Array(strings.length + 1);
  const bytes: number[] = [];
  for (let i = 0; i < strings.length; i++) {
    const b = enc.encode(strings[i]);
    bytes.push(...b);
    valueOffsets[i + 1] = valueOffsets[i] + b.length;
  }
  const utf8 = makeData({
    type: new Utf8(),
    length: strings.length,
    valueOffsets,
    data: Uint8Array.from(bytes),
  });
  const data = makeData({
    type: new List(new Field("item", new Utf8(), true)),
    length: rows.length,
    valueOffsets: listOffsets,
    child: utf8,
  });
  return new Vector([data]);
}

function tsCol(values: bigint[]): Vector {
  const data = makeData({
    type: new Timestamp(TimeUnit.NANOSECOND, "UTC"),
    length: values.length,
    data: BigInt64Array.from(values),
  });
  return new Vector([data]);
}

function ipc(cols: Record<string, Vector>): Uint8Array {
  return tableToIPC(new Table(cols), "file");
}

describe("decodeMapGeometry", () => {
  it("splits polylines by path_lengths and reads feature types", () => {
    const res = decodeMapGeometry(
      ipc({
        ts: tsCol([0n]),
        // Two features: a 3-point centerline and a 2-point lane boundary.
        points: listF32([[0, 0, 0, 1, 1, 0, 2, 2, 0, 5, 0, 0, 5, 4, 0]]),
        path_lengths: listI32([[3, 2]]),
        types: listUtf8([["centerline", "lane_boundary"]]),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tsNs).toBe(0n);
    expect(res.features.length).toBe(2);

    expect(res.features[0].type).toBe("centerline");
    expect(res.features[0].points).toEqual([
      [0, 0, 0],
      [1, 1, 0],
      [2, 2, 0],
    ]);
    expect(res.features[1].type).toBe("lane_boundary");
    expect(res.features[1].points).toEqual([
      [5, 0, 0],
      [5, 4, 0],
    ]);
  });

  it("errors when a required column is missing", () => {
    const res = decodeMapGeometry(
      ipc({
        ts: tsCol([0n]),
        points: listF32([[0, 0, 0, 1, 1, 0]]),
        path_lengths: listI32([[2]]),
        // no `types` column
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing-column");
  });

  it("flags a path_lengths / points-buffer disagreement", () => {
    const res = decodeMapGeometry(
      ipc({
        ts: tsCol([0n]),
        points: listF32([[0, 0, 0, 1, 1, 0]]), // 2 points
        path_lengths: listI32([[3]]), // claims 3 points
        types: listUtf8([["road_edge"]]),
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("dtype");
  });

  it("is resilient to an empty buffer (no throw)", () => {
    const res = decodeMapGeometry(new Uint8Array(0));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.features.length).toBe(0);
  });

  it("decodes the last (newest) row when several frames are present", () => {
    const res = decodeMapGeometry(
      ipc({
        ts: tsCol([0n, 0n]),
        points: listF32([
          [0, 0, 0, 1, 0, 0],
          [9, 9, 0, 8, 8, 0, 7, 7, 0],
        ]),
        path_lengths: listI32([[2], [3]]),
        types: listUtf8([["other"], ["stop_line"]]),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.features.length).toBe(1);
    expect(res.features[0].type).toBe("stop_line");
    expect(res.features[0].points.length).toBe(3);
  });
});
