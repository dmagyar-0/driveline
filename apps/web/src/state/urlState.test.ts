import { describe, it, expect } from "vitest";
import { encodeViewState, decodeViewState, type ViewState } from "./urlState";

function sample(): ViewState {
  return {
    layoutJson: { global: {}, layout: { type: "row", children: [] } },
    bindings: {
      plot: { "plot-1": ["6|/speed|src.mcap", "5|/rpm|src.mcap"] },
      video: { "video-1": "1|1/video|cam.mp4", "video-2": null },
      map: {
        "map-1": { latChannelId: "3|lat|g.mf4", lonChannelId: "3|lon|g.mf4" },
        "map-2": null,
      },
      table: { "table-1": ["3|lat|g.mf4"] },
      value: { "value-1": ["3|lon|g.mf4"] },
      enum: { "enum-1": ["5|/gear|src.mcap"] },
      scene: { "scene-1": "4|pose|g.mf4" },
    },
    // A realistic ns timestamp well beyond Number.MAX_SAFE_INTEGER limits
    // would still round-trip because it's a decimal string, not a Number.
    cursorNs: "1717243800123456789",
    timeMode: "absolute",
  };
}

describe("urlState encode/decode", () => {
  it("round-trips a full view state losslessly (incl. bigint cursor + nested bindings)", () => {
    const state = sample();
    const encoded = encodeViewState(state);
    // base64url: no +, /, or = padding.
    expect(encoded).not.toMatch(/[+/=]/);

    const decoded = decodeViewState(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded).toEqual(state);

    // The cursor survives as an exact decimal string and parses to the same
    // bigint (the rule we must never violate: no Number() on the timestamp).
    expect(BigInt(decoded!.cursorNs)).toBe(1717243800123456789n);
  });

  it("preserves a 64-bit cursor that would lose precision as a Number", () => {
    const state = sample();
    state.cursorNs = "9007199254740993"; // MAX_SAFE_INTEGER + 2
    const decoded = decodeViewState(encodeViewState(state));
    expect(decoded!.cursorNs).toBe("9007199254740993");
    expect(BigInt(decoded!.cursorNs)).toBe(9007199254740993n);
  });

  it("returns null on malformed input", () => {
    expect(decodeViewState("not-valid-base64!!!@@@")).toBeNull();
    // Valid base64url but not JSON.
    expect(decodeViewState(encodeBare("this is not json"))).toBeNull();
    // Valid JSON but not an object (a bare array / scalar).
    expect(decodeViewState(encodeBare("42"))).toBeNull();
    expect(decodeViewState("")).toBeNull();
  });

  it("tolerates missing fields with safe defaults", () => {
    // Only a layout, nothing else.
    const encoded = encodeBare(JSON.stringify({ layoutJson: { a: 1 } }));
    const decoded = decodeViewState(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.layoutJson).toEqual({ a: 1 });
    expect(decoded!.bindings.plot).toEqual({});
    expect(decoded!.bindings.video).toEqual({});
    expect(decoded!.cursorNs).toBe("0");
    expect(decoded!.timeMode).toBe("relative");
  });

  it("normalises an invalid cursorNs to '0' so apply can't throw", () => {
    const encoded = encodeBare(JSON.stringify({ cursorNs: "not-a-number" }));
    const decoded = decodeViewState(encoded);
    expect(decoded!.cursorNs).toBe("0");
  });
});

// Mirror urlState's base64url encoding for crafting raw test blobs.
function encodeBare(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
