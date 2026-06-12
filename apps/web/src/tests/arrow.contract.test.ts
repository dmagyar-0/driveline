import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  tableFromIPC,
  DataType,
  Timestamp,
  TimeUnit,
  Float64,
} from "apache-arrow";

const fixturePath = resolve(
  __dirname,
  "../../../../test-fixtures/arrow_scalar.ipc",
);

describe("Arrow IPC contract fixture (Rust ↔ JS)", () => {
  const bytes = readFileSync(fixturePath);
  const table = tableFromIPC(bytes);

  it("has two fields named ts and value", () => {
    expect(table.schema.fields.length).toBe(2);
    expect(table.schema.fields[0].name).toBe("ts");
    expect(table.schema.fields[1].name).toBe("value");
  });

  it("ts is Timestamp(ns, UTC)", () => {
    const ts = table.schema.fields[0].type as Timestamp;
    expect(DataType.isTimestamp(ts)).toBe(true);
    expect(ts.unit).toBe(TimeUnit.NANOSECOND);
    expect(ts.timezone).toBe("UTC");
  });

  it("value is Float64", () => {
    const v = table.schema.fields[1].type as Float64;
    expect(DataType.isFloat(v)).toBe(true);
    expect(v.precision).toBe(2); // SINGLE=0, DOUBLE=2, HALF=1
  });

  it("contains 3 rows with expected raw nanosecond timestamps", () => {
    expect(table.numRows).toBe(3);

    // apache-arrow's `.get(i)` on a Timestamp column returns ms-since-epoch
    // via JS Date semantics and loses sub-ms precision. The raw backing
    // buffer keeps nanoseconds intact — that is what Driveline panels read.
    const tsCol = table.getChild("ts")!;
    const raw = tsCol.data[0].values as BigInt64Array;
    expect(raw.length).toBe(3);
    expect(raw[0]).toBe(1_000_000_000n);
    expect(raw[1]).toBe(1_010_000_000n);
    expect(raw[2]).toBe(1_020_000_000n);

    const valueCol = table.getChild("value")!;
    let sum = 0;
    for (let i = 0; i < valueCol.length; i++) sum += Number(valueCol.get(i));
    expect(sum).toBeCloseTo(6.0, 9);
  });
});
