import { describe, expect, it } from "vitest";
import {
  draftFromSchema,
  draftToBasis,
  basisToJson,
  isDraftValid,
  nsPerUnit,
  parseEpochOffsetNs,
  previewStartNs,
  previewStartLabel,
  type BasisDraft,
  type RawTabularSchema,
} from "./tabularImport";

const SCHEMA: RawTabularSchema = {
  columns: [
    { name: "t", dtype: "f64", is_numeric: true },
    { name: "speed", dtype: "f64", is_numeric: true },
    { name: "gear", dtype: "str", is_numeric: false },
  ],
  // A large epoch offset (~1.7e18 ns) that exceeds Number.MAX_SAFE_INTEGER —
  // this is exactly the precision-loss trap the feature must avoid.
  suggested: {
    time_column: "t",
    unit: "Seconds",
    mode: "Relative",
    epoch_offset_ns: 1_700_000_000_123_456_789n,
  },
};

describe("nsPerUnit", () => {
  it("maps each unit to its ns factor as bigint", () => {
    expect(nsPerUnit("Nanos")).toBe(1n);
    expect(nsPerUnit("Micros")).toBe(1_000n);
    expect(nsPerUnit("Millis")).toBe(1_000_000n);
    expect(nsPerUnit("Seconds")).toBe(1_000_000_000n);
  });
});

describe("draftFromSchema", () => {
  it("derives the draft from the suggested basis, offset as a decimal string", () => {
    const d = draftFromSchema(SCHEMA);
    expect(d).toEqual({
      timeColumn: "t",
      unit: "Seconds",
      mode: "Relative",
      epochOffsetNs: "1700000000123456789",
    });
  });

  it("preserves a large epoch offset without precision loss", () => {
    const d = draftFromSchema(SCHEMA);
    // Round-tripping the string back to bigint must equal the original.
    expect(BigInt(d.epochOffsetNs)).toBe(1_700_000_000_123_456_789n);
  });

  it("accepts a plain-number offset from the wire (small values)", () => {
    const d = draftFromSchema({
      columns: SCHEMA.columns,
      suggested: {
        time_column: "t",
        unit: "Millis",
        mode: "Absolute",
        epoch_offset_ns: 0,
      },
    });
    expect(d.epochOffsetNs).toBe("0");
    expect(d.mode).toBe("Absolute");
  });
});

describe("parseEpochOffsetNs", () => {
  it("parses a large decimal string to bigint exactly", () => {
    expect(parseEpochOffsetNs("1700000000123456789")).toBe(
      1_700_000_000_123_456_789n,
    );
  });
  it("treats empty / sign-only input as zero", () => {
    expect(parseEpochOffsetNs("")).toBe(0n);
    expect(parseEpochOffsetNs("  ")).toBe(0n);
    expect(parseEpochOffsetNs("-")).toBe(0n);
  });
  it("accepts a negative offset", () => {
    expect(parseEpochOffsetNs("-500")).toBe(-500n);
  });
  it("rejects non-integer / junk input", () => {
    expect(parseEpochOffsetNs("1.5")).toBeNull();
    expect(parseEpochOffsetNs("12abc")).toBeNull();
    expect(parseEpochOffsetNs("1e9")).toBeNull();
  });
});

describe("isDraftValid", () => {
  const base: BasisDraft = {
    timeColumn: "t",
    unit: "Seconds",
    mode: "Relative",
    epochOffsetNs: "0",
  };
  it("is valid with a column and a parseable offset", () => {
    expect(isDraftValid(base)).toBe(true);
  });
  it("is invalid without a time column", () => {
    expect(isDraftValid({ ...base, timeColumn: "" })).toBe(false);
  });
  it("is invalid with a non-integer offset", () => {
    expect(isDraftValid({ ...base, epochOffsetNs: "1.5" })).toBe(false);
  });
});

describe("draftToBasis / basisToJson", () => {
  it("builds the snake_case basis the reader expects", () => {
    const basis = draftToBasis(draftFromSchema(SCHEMA));
    expect(basis).toEqual({
      time_column: "t",
      unit: "Seconds",
      mode: "Relative",
      epoch_offset_ns: Number(1_700_000_000_123_456_789n),
    });
  });

  it("returns null for an invalid draft", () => {
    expect(
      draftToBasis({
        timeColumn: "",
        unit: "Seconds",
        mode: "Relative",
        epochOffsetNs: "0",
      }),
    ).toBeNull();
  });

  it("serialises to JSON with PascalCase enum values", () => {
    const json = basisToJson(draftToBasis(draftFromSchema(SCHEMA))!);
    const parsed = JSON.parse(json);
    expect(parsed.unit).toBe("Seconds");
    expect(parsed.mode).toBe("Relative");
    expect(parsed.time_column).toBe("t");
  });
});

describe("previewStartNs / previewStartLabel", () => {
  it("relative mode anchors the start at the epoch offset", () => {
    const d: BasisDraft = {
      timeColumn: "t",
      unit: "Seconds",
      mode: "Relative",
      epochOffsetNs: "1700000000000000000",
    };
    expect(previewStartNs(d)).toBe(1_700_000_000_000_000_000n);
    // 2023-11-14T22:13:20 UTC
    expect(previewStartLabel(d)).toContain("2023-11-14");
    expect(previewStartLabel(d)).toContain("UTC");
  });

  it("absolute mode defers the start to load time", () => {
    const d: BasisDraft = {
      timeColumn: "t",
      unit: "Seconds",
      mode: "Absolute",
      epochOffsetNs: "0",
    };
    expect(previewStartNs(d)).toBeNull();
    expect(previewStartLabel(d)).toMatch(/Absolute/i);
  });

  it("flags an unparseable offset in relative mode", () => {
    const d: BasisDraft = {
      timeColumn: "t",
      unit: "Seconds",
      mode: "Relative",
      epochOffsetNs: "xyz",
    };
    expect(previewStartNs(d)).toBeNull();
    expect(previewStartLabel(d)).toMatch(/valid epoch offset/i);
  });
});
