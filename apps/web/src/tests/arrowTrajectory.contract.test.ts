import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  tableFromIPC,
  DataType,
  Timestamp,
  TimeUnit,
  List,
  Float32,
  Int32,
} from "apache-arrow";
import { decodeTrajectories } from "../panels/trajectoriesFromArrow";

const fixturePath = resolve(
  __dirname,
  "../../../../test-fixtures/arrow_trajectory.ipc",
);

describe("Arrow IPC trajectory contract fixture (Rust ↔ JS)", () => {
  const bytes = readFileSync(fixturePath);
  const table = tableFromIPC(bytes);

  it("has the four trajectory columns in order", () => {
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      "ts",
      "points",
      "path_lengths",
      "confidences",
    ]);
  });

  it("ts is Timestamp(ns, UTC)", () => {
    const ts = table.schema.fields[0].type as Timestamp;
    expect(DataType.isTimestamp(ts)).toBe(true);
    expect(ts.unit).toBe(TimeUnit.NANOSECOND);
    expect(ts.timezone).toBe("UTC");
  });

  it("points / confidences are List<Float32>", () => {
    for (const name of ["points", "confidences"]) {
      const field = table.schema.fields.find((f) => f.name === name)!;
      expect(DataType.isList(field.type)).toBe(true);
      const child = (field.type as List).children[0];
      expect(DataType.isFloat(child.type)).toBe(true);
      // apache-arrow Precision enum: HALF=0, SINGLE=1, DOUBLE=2.
      expect((child.type as Float32).precision).toBe(1);
    }
  });

  it("path_lengths is List<Int32>", () => {
    const field = table.schema.fields.find((f) => f.name === "path_lengths")!;
    expect(DataType.isList(field.type)).toBe(true);
    const child = (field.type as List).children[0];
    expect(DataType.isInt(child.type)).toBe(true);
    expect((child.type as Int32).bitWidth).toBe(32);
  });

  it("decodeTrajectories splits the two candidate paths with sane values", () => {
    const res = decodeTrajectories(new Uint8Array(bytes));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // One frame, two candidate paths (lengths [3, 2]).
    expect(res.paths.length).toBe(2);
    expect(res.tsNs).not.toBeNull();

    expect(res.paths[0].points.length).toBe(3);
    expect(res.paths[1].points.length).toBe(2);
    expect(res.paths[0].confidence).toBeCloseTo(0.9, 5);
    expect(res.paths[1].confidence).toBeCloseTo(0.1, 5);

    for (const path of res.paths) {
      expect(path.confidence).toBeGreaterThanOrEqual(0);
      expect(path.confidence).toBeLessThanOrEqual(1);
      for (const pt of path.points) {
        expect(pt).toHaveLength(3);
        for (const c of pt) expect(Number.isFinite(c)).toBe(true);
      }
    }
    // First waypoint of the primary path is the ego origin.
    expect(res.paths[0].points[0]).toEqual([0, 0, 0]);
  });

  it("decodeTrajectories is zero-copy resilient: re-decoding is stable", () => {
    const a = decodeTrajectories(new Uint8Array(bytes));
    const b = decodeTrajectories(new Uint8Array(bytes));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.paths.length).toBe(b.paths.length);
  });

  it("decodeTrajectories is resilient to an empty buffer (no throw)", () => {
    // An empty/zero-row buffer decodes to an empty frame rather than throwing,
    // mirroring the box decoder's `EMPTY_FRAME` behaviour.
    const res = decodeTrajectories(new Uint8Array(0));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.paths.length).toBe(0);
  });
});
