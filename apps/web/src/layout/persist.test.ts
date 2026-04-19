import { describe, expect, it } from "vitest";
import {
  LAYOUT_STORAGE_KEY,
  loadLayoutFromStorage,
  saveLayoutToStorage,
  type PersistedLayout,
} from "./persist";

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, v);
    },
  } as Storage;
}

const SAMPLE: PersistedLayout = {
  version: 1,
  layoutJson: {
    layout: { type: "row", weight: 100, children: [] },
  },
  videoBindings: { "video-1": "/cam/front", "video-2": null },
  plotBindings: { "plot-1": ["/vehicle/speed", "/vehicle/rpm"] },
};

describe("layout persist", () => {
  it("round-trips save → load", () => {
    const s = makeStorage();
    saveLayoutToStorage(SAMPLE, s);
    const loaded = loadLayoutFromStorage(s);
    expect(loaded).toEqual(SAMPLE);
  });

  it("returns null when nothing is stored", () => {
    expect(loadLayoutFromStorage(makeStorage())).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const s = makeStorage();
    s.setItem(LAYOUT_STORAGE_KEY, "not json {");
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null when version mismatches", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...SAMPLE, version: 2 }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null when bindings have wrong shape", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        layoutJson: null,
        videoBindings: { "video-1": 123 },
        plotBindings: {},
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null for plot bindings containing non-strings", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        layoutJson: null,
        videoBindings: {},
        plotBindings: { "plot-1": ["ok", 42] },
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("no-ops when storage is undefined", () => {
    expect(() => saveLayoutToStorage(SAMPLE, undefined)).not.toThrow();
    expect(loadLayoutFromStorage(undefined)).toBeNull();
  });

  it("accepts an explicitly null layoutJson", () => {
    const s = makeStorage();
    const payload: PersistedLayout = {
      version: 1,
      layoutJson: null,
      videoBindings: {},
      plotBindings: {},
    };
    saveLayoutToStorage(payload, s);
    expect(loadLayoutFromStorage(s)).toEqual(payload);
  });
});
