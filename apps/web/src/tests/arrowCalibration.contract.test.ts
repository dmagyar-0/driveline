import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tableFromIPC, DataType, List, Float32, Int32 } from "apache-arrow";
import { decodeCalibration } from "../panels/calibrationFromArrow";

const fixturePath = resolve(
  __dirname,
  "../../../../test-fixtures/arrow_calibration.ipc",
);

describe("Arrow IPC calibration contract fixture (Rust ↔ JS)", () => {
  const bytes = readFileSync(fixturePath);
  const table = tableFromIPC(bytes);

  it("has the eight calibration columns in order", () => {
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      "name",
      "model",
      "intrinsics",
      "resolution",
      "distortion",
      "forward_poly",
      "translation",
      "quaternion",
    ]);
  });

  it("all eight fields are non-nullable", () => {
    for (const f of table.schema.fields) {
      expect(f.nullable).toBe(false);
    }
  });

  it("name and model are Utf8", () => {
    for (const name of ["name", "model"]) {
      const field = table.schema.fields.find((f) => f.name === name)!;
      expect(DataType.isUtf8(field.type)).toBe(true);
    }
  });

  it("intrinsics / distortion / forward_poly / translation / quaternion are List<Float32>", () => {
    for (const name of [
      "intrinsics",
      "distortion",
      "forward_poly",
      "translation",
      "quaternion",
    ]) {
      const field = table.schema.fields.find((f) => f.name === name)!;
      expect(DataType.isList(field.type)).toBe(true);
      const child = (field.type as List).children[0];
      expect(DataType.isFloat(child.type)).toBe(true);
      // apache-arrow Precision enum: HALF=0, SINGLE=1, DOUBLE=2.
      expect((child.type as Float32).precision).toBe(1);
    }
  });

  it("resolution is List<Int32>", () => {
    const field = table.schema.fields.find((f) => f.name === "resolution")!;
    expect(DataType.isList(field.type)).toBe(true);
    const child = (field.type as List).children[0];
    expect(DataType.isInt(child.type)).toBe(true);
    const intType = child.type as Int32;
    expect(intType.bitWidth).toBe(32);
    expect(intType.isSigned).toBe(true);
  });

  it("decodeCalibration yields one CAM_FRONT camera with sane values", () => {
    const res = decodeCalibration(new Uint8Array(bytes));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.cameras).toHaveLength(1);
    const cam = res.cameras[0];
    expect(cam.name).toBe("CAM_FRONT");
    expect(cam.model).toBe("pinhole");
    // Pinhole camera → empty forward polynomial.
    expect(cam.forwardPoly).toEqual([]);
    expect(cam.intrinsics.width).toBe(1600);
    expect(cam.intrinsics.height).toBe(900);
    // Distortion is [] or 5.
    expect([0, 5]).toContain(cam.distortion.length);
    // Unit quaternion.
    const [qx, qy, qz, qw] = cam.quaternion;
    expect(Math.hypot(qx, qy, qz, qw)).toBeCloseTo(1, 4);
    // Finite intrinsics.
    for (const v of [
      cam.intrinsics.fx,
      cam.intrinsics.fy,
      cam.intrinsics.cx,
      cam.intrinsics.cy,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
