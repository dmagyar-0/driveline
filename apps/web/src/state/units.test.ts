import { describe, expect, it } from "vitest";
import { channelLabel, effectiveUnit } from "./units";

const ch = (id: string, unit: string | null) => ({ id, name: "speed", unit });

describe("effectiveUnit", () => {
  it("falls back to the file-inferred unit when there is no override", () => {
    expect(effectiveUnit(ch("/a", "m/s"), {})).toBe("m/s");
  });

  it("returns null when neither override nor inferred unit resolves", () => {
    expect(effectiveUnit(ch("/a", null), {})).toBeNull();
    expect(effectiveUnit(ch("/a", "  "), {})).toBeNull();
  });

  it("prefers the override over the inferred unit", () => {
    expect(effectiveUnit(ch("/a", "m/s"), { "/a": "km/h" })).toBe("km/h");
  });

  it("treats an empty-string override as 'explicitly no unit'", () => {
    expect(effectiveUnit(ch("/a", "m/s"), { "/a": "" })).toBeNull();
    expect(effectiveUnit(ch("/a", "m/s"), { "/a": "   " })).toBeNull();
  });

  it("trims a non-empty override", () => {
    expect(effectiveUnit(ch("/a", null), { "/a": " rad " })).toBe("rad");
  });
});

describe("channelLabel", () => {
  it("appends the effective unit in parentheses", () => {
    expect(channelLabel(ch("/a", "m/s"), {})).toBe("speed (m/s)");
    expect(channelLabel(ch("/a", "m/s"), { "/a": "km/h" })).toBe(
      "speed (km/h)",
    );
  });

  it("renders the bare name when there is no effective unit", () => {
    expect(channelLabel(ch("/a", null), {})).toBe("speed");
    expect(channelLabel(ch("/a", "m/s"), { "/a": "" })).toBe("speed");
  });
});
