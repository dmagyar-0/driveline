// Contract test for the point-cloud Arrow decoder. The Rust core
// (`pointcloud.rs`) emits one row per spin with `positions: List<Float32>`
// and `intensities: List<Float32>`; this builds that exact shape with
// apache-arrow and asserts `decodePointCloud` reads back the geometry. The
// producer side is covered by the Rust `pointcloud::tests`.

import { describe, it, expect } from "vitest";
import {
  Field,
  Float32,
  List,
  Table,
  Vector,
  makeData,
  tableToIPC,
} from "apache-arrow";
import { decodePointCloud } from "./pointCloudFromArrow";

// Build a genuine List<Float32> column, one list per spin row.
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

function ipc(cols: Record<string, Vector>): Uint8Array {
  return tableToIPC(new Table(cols), "file");
}

describe("decodePointCloud", () => {
  it("decodes a single spin's positions and intensities", () => {
    const res = decodePointCloud(
      ipc({
        positions: listF32([[1, 2, 3, 4, 5, 6]]),
        intensities: listF32([[0.25, 0.75]]),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.count).toBe(2);
    expect(Array.from(res.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(res.intensities)).toEqual([0.25, 0.75]);
  });

  it("decodes the last (newest) row when several spins are present", () => {
    const res = decodePointCloud(
      ipc({
        positions: listF32([
          [0, 0, 0],
          [9, 8, 7, 6, 5, 4],
        ]),
        intensities: listF32([[0.1], [0.5, 0.9]]),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.count).toBe(2);
    expect(Array.from(res.positions)).toEqual([9, 8, 7, 6, 5, 4]);
  });

  it("errors when a column is missing", () => {
    const res = decodePointCloud(ipc({ positions: listF32([[1, 2, 3]]) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing-column");
  });

  it("flags a positions/intensities length mismatch", () => {
    const res = decodePointCloud(
      ipc({
        positions: listF32([[1, 2, 3, 4, 5, 6]]), // 2 points
        intensities: listF32([[0.1, 0.2, 0.3]]), // 3 points
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("dtype");
  });
});
