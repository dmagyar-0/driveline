import { describe, expect, it } from "vitest";
import {
  attachLayoutPersistence,
  LAYOUT_STORAGE_KEY,
  loadLayoutFromStorage,
  saveLayoutToStorage,
  type LayoutSlice,
  type PersistedLayout,
} from "./persist";
import type { useSession } from "../state/store";

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
  version: 3,
  layoutJson: {
    layout: { type: "row", weight: 100, children: [] },
  },
  videoBindings: { "video-1": "/cam/front", "video-2": null },
  plotBindings: { "plot-1": ["/vehicle/speed", "/vehicle/rpm"] },
  videoHudOn: { "video-1": true },
  sceneBindings: { "scene-1": "/cloud/front", "scene-2": null },
  mapBindings: {
    "map-1": { latChannelId: "/gps/lat", lonChannelId: "/gps/lon" },
    "map-2": null,
  },
  tableBindings: {
    "table-1": ["/vehicle/speed", "/vehicle/rpm"],
  },
  valueBindings: {
    "value-1": ["/vehicle/speed"],
  },
  enumBindings: { "enum-1": ["/state/gear"], "enum-2": [] },
  plotPanelSettings: {
    "plot-1": {
      gapThresholdSec: 1.5,
      axisAssignments: { "/vehicle/rpm": 1 },
      stackAxes: true,
    },
    "plot-2": { gapThresholdSec: null },
  },
  unitOverrides: { "/vehicle/speed": "km/h", "/vehicle/rpm": "" },
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
    s.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ ...SAMPLE, version: 4 }));
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null for legacy v1 payloads (Phase 5 schema bump)", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        layoutJson: null,
        videoBindings: {},
        plotBindings: {},
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null for legacy v2 payloads (Phase 6 schema bump)", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        layoutJson: null,
        videoBindings: {},
        plotBindings: {},
        videoHudOn: {},
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null when bindings have wrong shape", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        ...SAMPLE,
        videoBindings: { "video-1": 123 },
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null for plot bindings containing non-strings", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        ...SAMPLE,
        plotBindings: { "plot-1": ["ok", 42] },
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null for non-boolean videoHudOn values", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        ...SAMPLE,
        videoHudOn: { "video-1": "yes" },
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null when any v3 binding map is missing", () => {
    const s = makeStorage();
    const { sceneBindings: _scene, ...partial } = SAMPLE;
    void _scene;
    s.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(partial));
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null when mapBindings is missing required fields", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        ...SAMPLE,
        mapBindings: { "map-1": { latChannelId: "/gps/lat" } },
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null when tableBindings entries contain non-strings", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        ...SAMPLE,
        tableBindings: { "table-1": [42] },
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
      version: 3,
      layoutJson: null,
      videoBindings: {},
      plotBindings: {},
      videoHudOn: {},
      sceneBindings: {},
      mapBindings: {},
      tableBindings: {},
      valueBindings: {},
      enumBindings: {},
      plotPanelSettings: {},
      unitOverrides: {},
    };
    saveLayoutToStorage(payload, s);
    expect(loadLayoutFromStorage(s)).toEqual(payload);
  });

  it("treats a missing unitOverrides as an empty map (backwards compat)", () => {
    const s = makeStorage();
    // A payload written before unitOverrides existed must still load, with
    // the field defaulting to an empty map.
    s.setItem(
      "driveline.layout.v3",
      JSON.stringify({
        version: 3,
        layoutJson: null,
        videoBindings: {},
        plotBindings: {},
        videoHudOn: {},
        sceneBindings: {},
        mapBindings: {},
        tableBindings: {},
        valueBindings: {},
        enumBindings: {},
        plotPanelSettings: {},
        // unitOverrides intentionally absent
      }),
    );
    expect(loadLayoutFromStorage(s)?.unitOverrides).toEqual({});
  });

  it("treats a missing plotPanelSettings as an empty map (Phase 8 backwards compat)", () => {
    // A v3 payload written before the Phase 8 field existed must still
    // load — otherwise users lose every saved layout on first run with
    // the new build.
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        layoutJson: null,
        videoBindings: {},
        plotBindings: {},
        videoHudOn: {},
        sceneBindings: {},
        mapBindings: {},
        tableBindings: {},
        enumBindings: {},
        // plotPanelSettings intentionally absent
      }),
    );
    const loaded = loadLayoutFromStorage(s);
    expect(loaded?.plotPanelSettings).toEqual({});
  });

  it("migrates legacy single-channel enumBindings to arrays on read", () => {
    // The enum panel used to bind one channel-or-null per panel. A v3
    // layout written then must still load, coercing the legacy shape to
    // the multi-channel list rather than dropping the whole layout.
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        ...SAMPLE,
        enumBindings: { "enum-1": "/state/gear", "enum-2": null, "enum-3": "" },
      }),
    );
    expect(loadLayoutFromStorage(s)?.enumBindings).toEqual({
      "enum-1": ["/state/gear"],
      "enum-2": [],
      "enum-3": [],
    });
  });

  it("returns null when an enumBindings value is neither string, null, nor array", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...SAMPLE, enumBindings: { "enum-1": 7 } }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null when plotPanelSettings has a non-finite threshold", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        ...SAMPLE,
        plotPanelSettings: {
          "plot-1": { gapThresholdSec: "not a number" },
        },
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null when plotPanelSettings.stackAxes is not a boolean", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        ...SAMPLE,
        plotPanelSettings: {
          "plot-1": { gapThresholdSec: null, stackAxes: "yes" },
        },
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });
});

interface FakeStore {
  getState: () => LayoutSlice;
  subscribe: (cb: (s: LayoutSlice) => void) => () => void;
  push: (next: LayoutSlice) => void;
  listenerCount: () => number;
}

function makeFakeStore(initial: LayoutSlice): FakeStore {
  let state = initial;
  const listeners = new Set<(s: LayoutSlice) => void>();
  return {
    getState: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    push(next) {
      state = next;
      for (const cb of listeners) cb(state);
    },
    listenerCount: () => listeners.size,
  };
}

const EMPTY_SLICE: LayoutSlice = {
  layoutJson: null,
  videoBindings: {},
  plotBindings: {},
  videoHudOn: {},
  sceneBindings: {},
  mapBindings: {},
  tableBindings: {},
  valueBindings: {},
  enumBindings: {},
  plotPanelSettings: {},
  unitOverrides: {},
};

describe("attachLayoutPersistence", () => {
  it("writes the current slice when any tracked ref changes", () => {
    const s = makeStorage();
    const store = makeFakeStore(EMPTY_SLICE);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(loadLayoutFromStorage(s)).toBeNull();

    const nextLayout = { layout: { type: "row", weight: 100, children: [] } };
    store.push({
      ...EMPTY_SLICE,
      layoutJson: nextLayout,
    });
    const loaded = loadLayoutFromStorage(s);
    expect(loaded?.layoutJson).toEqual(nextLayout);
    stop();
  });

  it("skips the write when the tracked refs are all identical", () => {
    const s = makeStorage();
    const store = makeFakeStore(EMPTY_SLICE);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push(EMPTY_SLICE);
    expect(loadLayoutFromStorage(s)).toBeNull();
    stop();
  });

  it("unsubscribes on the returned dispose handle", () => {
    const s = makeStorage();
    const store = makeFakeStore(EMPTY_SLICE);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(store.listenerCount()).toBe(1);
    stop();
    expect(store.listenerCount()).toBe(0);
    store.push({
      ...EMPTY_SLICE,
      plotBindings: { "plot-1": ["x"] },
    });
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("writes when plotBindings is a new object, even with equal contents", () => {
    const s = makeStorage();
    const store = makeFakeStore(EMPTY_SLICE);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({
      ...EMPTY_SLICE,
      plotBindings: {},
    });
    const loaded = loadLayoutFromStorage(s);
    expect(loaded).not.toBeNull();
    expect(loaded?.plotBindings).toEqual({});
    stop();
  });

  it("writes when videoHudOn is a new object", () => {
    const s = makeStorage();
    const store = makeFakeStore(EMPTY_SLICE);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({
      ...EMPTY_SLICE,
      videoHudOn: { "video-1": true },
    });
    const loaded = loadLayoutFromStorage(s);
    expect(loaded?.videoHudOn).toEqual({ "video-1": true });
    stop();
  });

  it("writes when any Phase 6 binding map changes ref", () => {
    const s = makeStorage();
    const store = makeFakeStore(EMPTY_SLICE);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({
      ...EMPTY_SLICE,
      mapBindings: {
        "map-1": { latChannelId: "/gps/lat", lonChannelId: "/gps/lon" },
      },
    });
    const loaded = loadLayoutFromStorage(s);
    expect(loaded?.mapBindings["map-1"]).toEqual({
      latChannelId: "/gps/lat",
      lonChannelId: "/gps/lon",
    });
    stop();
  });

  it("writes when plotPanelSettings changes ref (Phase 8)", () => {
    const s = makeStorage();
    const store = makeFakeStore(EMPTY_SLICE);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({
      ...EMPTY_SLICE,
      plotPanelSettings: { "plot-1": { gapThresholdSec: 2 } },
    });
    const loaded = loadLayoutFromStorage(s);
    expect(loaded?.plotPanelSettings).toEqual({
      "plot-1": { gapThresholdSec: 2 },
    });
    stop();
  });

  it("writes when unitOverrides changes ref", () => {
    const s = makeStorage();
    const store = makeFakeStore(EMPTY_SLICE);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({
      ...EMPTY_SLICE,
      unitOverrides: { "/vehicle/speed": "km/h" },
    });
    expect(loadLayoutFromStorage(s)?.unitOverrides).toEqual({
      "/vehicle/speed": "km/h",
    });
    stop();
  });

  it("is a no-op when storage is undefined", () => {
    const store = makeFakeStore(EMPTY_SLICE);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      undefined,
    );
    expect(store.listenerCount()).toBe(0);
    store.push({
      ...EMPTY_SLICE,
      videoBindings: { "video-1": "/c" },
    });
    expect(() => stop()).not.toThrow();
  });
});
