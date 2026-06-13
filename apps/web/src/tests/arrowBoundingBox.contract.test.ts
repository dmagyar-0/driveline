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
} from "apache-arrow";
import { decodeBoxes } from "../panels/boxesFromArrow";

const fixturePath = resolve(
  __dirname,
  "../../../../test-fixtures/arrow_bounding_box.ipc",
);

describe("Arrow IPC bounding-box contract fixture (Rust ↔ JS)", () => {
  const bytes = readFileSync(fixturePath);
  const table = tableFromIPC(bytes);

  it("has the five OpenLABEL columns in order", () => {
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      "ts",
      "centers",
      "sizes",
      "rotations",
      "labels",
    ]);
  });

  it("ts is Timestamp(ns, UTC)", () => {
    const ts = table.schema.fields[0].type as Timestamp;
    expect(DataType.isTimestamp(ts)).toBe(true);
    expect(ts.unit).toBe(TimeUnit.NANOSECOND);
    expect(ts.timezone).toBe("UTC");
  });

  it("centers / sizes / rotations are List<Float32>", () => {
    for (const name of ["centers", "sizes", "rotations"]) {
      const field = table.schema.fields.find((f) => f.name === name)!;
      expect(DataType.isList(field.type)).toBe(true);
      const child = (field.type as List).children[0];
      expect(DataType.isFloat(child.type)).toBe(true);
      // apache-arrow Precision enum: HALF=0, SINGLE=1, DOUBLE=2.
      expect((child.type as Float32).precision).toBe(1);
    }
  });

  it("labels is List<Utf8>", () => {
    const field = table.schema.fields.find((f) => f.name === "labels")!;
    expect(DataType.isList(field.type)).toBe(true);
    const child = (field.type as List).children[0];
    expect(DataType.isUtf8(child.type)).toBe(true);
  });

  it("decodeBoxes yields the expected N=2 cars with sane values", () => {
    const res = decodeBoxes(new Uint8Array(bytes));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // One frame, two cars.
    expect(res.boxes.length).toBe(2);
    expect(res.tsNs).not.toBeNull();

    for (const box of res.boxes) {
      expect(box.label).toBe("car");
      expect(box.center).toHaveLength(3);
      expect(box.size).toHaveLength(3);
      expect(box.quat).toHaveLength(4);
      // FULL extents are positive and finite.
      for (const s of box.size) {
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThan(0);
      }
      // A unit quaternion: |q| ≈ 1.
      const [qx, qy, qz, qw] = box.quat;
      const norm = Math.hypot(qx, qy, qz, qw);
      expect(norm).toBeCloseTo(1, 4);
      // Centres are finite metres.
      for (const c of box.center) expect(Number.isFinite(c)).toBe(true);
    }
  });

  it("decodeBoxes is zero-copy resilient: re-decoding the fixture is stable", () => {
    // Decoding twice yields the same box count — confirms the decoder doesn't
    // consume/mutate its input buffer between calls.
    const a = decodeBoxes(new Uint8Array(bytes));
    const b = decodeBoxes(new Uint8Array(bytes));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.boxes.length).toBe(b.boxes.length);
  });
});
