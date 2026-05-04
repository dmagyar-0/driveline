import { describe, expect, it } from "vitest";
import {
  attachNamedLayoutsPersistence,
  loadNamedLayoutsFromStorage,
  NAMED_LAYOUTS_STORAGE_KEY,
  saveNamedLayoutsToStorage,
  type NamedLayout,
  type NamedLayoutsSlice,
  type PersistedNamedLayouts,
} from "./namedLayouts";
import type { useSession } from "../store";

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

const SAMPLE_LAYOUT: NamedLayout = {
  id: "uuid-default",
  name: "default",
  layoutJson: { layout: { type: "row", weight: 100, children: [] } },
  videoBindings: { "video-1": "/cam/front" },
  plotBindings: { "plot-1": ["/vehicle/speed"] },
  sceneBindings: { "scene-1": null },
  mapBindings: {
    "map-1": { latChannelId: "/gps/lat", lonChannelId: "/gps/lon" },
  },
  tableBindings: { "table-1": ["/vehicle/speed"] },
  enumBindings: { "enum-1": "/state/gear" },
  plotPanelSettings: { "plot-1": { gapThresholdSec: 1.5 } },
  createdAt: 1_700_000_000_000,
};

const SAMPLE: PersistedNamedLayouts = {
  version: 2,
  layouts: [SAMPLE_LAYOUT],
  activeNamedLayoutId: "uuid-default",
};

describe("namedLayouts persist", () => {
  it("round-trips save → load", () => {
    const s = makeStorage();
    saveNamedLayoutsToStorage(SAMPLE, s);
    expect(loadNamedLayoutsFromStorage(s)).toEqual(SAMPLE);
  });

  it("returns null when nothing is stored", () => {
    expect(loadNamedLayoutsFromStorage(makeStorage())).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const s = makeStorage();
    s.setItem(NAMED_LAYOUTS_STORAGE_KEY, "not json {");
    expect(loadNamedLayoutsFromStorage(s)).toBeNull();
  });

  it("returns null when version mismatches", () => {
    const s = makeStorage();
    s.setItem(
      NAMED_LAYOUTS_STORAGE_KEY,
      JSON.stringify({ ...SAMPLE, version: 3 }),
    );
    expect(loadNamedLayoutsFromStorage(s)).toBeNull();
  });

  it("returns null for legacy v1 payloads (Phase 6 schema bump)", () => {
    const s = makeStorage();
    s.setItem(
      NAMED_LAYOUTS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        layouts: [
          {
            id: "x",
            name: "x",
            layoutJson: null,
            videoBindings: {},
            plotBindings: {},
            createdAt: 0,
          },
        ],
        activeNamedLayoutId: null,
      }),
    );
    expect(loadNamedLayoutsFromStorage(s)).toBeNull();
  });

  it("returns null when layouts is not an array", () => {
    const s = makeStorage();
    s.setItem(
      NAMED_LAYOUTS_STORAGE_KEY,
      JSON.stringify({ version: 2, layouts: {}, activeNamedLayoutId: null }),
    );
    expect(loadNamedLayoutsFromStorage(s)).toBeNull();
  });

  it("returns null when an entry is missing required fields", () => {
    const s = makeStorage();
    s.setItem(
      NAMED_LAYOUTS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        layouts: [{ id: "x", name: "x" }], // missing bindings, createdAt
        activeNamedLayoutId: null,
      }),
    );
    expect(loadNamedLayoutsFromStorage(s)).toBeNull();
  });

  it("returns null when video bindings have wrong shape", () => {
    const s = makeStorage();
    s.setItem(
      NAMED_LAYOUTS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        layouts: [
          {
            id: "x",
            name: "x",
            layoutJson: null,
            videoBindings: { "video-1": 123 },
            plotBindings: {},
            sceneBindings: {},
            mapBindings: {},
            tableBindings: {},
            enumBindings: {},
            createdAt: 0,
          },
        ],
        activeNamedLayoutId: null,
      }),
    );
    expect(loadNamedLayoutsFromStorage(s)).toBeNull();
  });

  it("returns null when a Phase 6 binding map is missing", () => {
    const s = makeStorage();
    s.setItem(
      NAMED_LAYOUTS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        layouts: [
          {
            id: "x",
            name: "x",
            layoutJson: null,
            videoBindings: {},
            plotBindings: {},
            sceneBindings: {},
            mapBindings: {},
            tableBindings: {},
            // enumBindings missing
            createdAt: 0,
          },
        ],
        activeNamedLayoutId: null,
      }),
    );
    expect(loadNamedLayoutsFromStorage(s)).toBeNull();
  });

  it("nulls a stale activeNamedLayoutId rather than rejecting the slice", () => {
    const s = makeStorage();
    saveNamedLayoutsToStorage(
      { ...SAMPLE, activeNamedLayoutId: "ghost-id" },
      s,
    );
    const loaded = loadNamedLayoutsFromStorage(s);
    expect(loaded?.layouts).toEqual(SAMPLE.layouts);
    expect(loaded?.activeNamedLayoutId).toBeNull();
  });

  it("accepts an explicitly null layoutJson on a saved entry", () => {
    const s = makeStorage();
    const payload: PersistedNamedLayouts = {
      version: 2,
      layouts: [{ ...SAMPLE_LAYOUT, layoutJson: null }],
      activeNamedLayoutId: SAMPLE_LAYOUT.id,
    };
    saveNamedLayoutsToStorage(payload, s);
    expect(loadNamedLayoutsFromStorage(s)).toEqual(payload);
  });

  it("no-ops when storage is undefined", () => {
    expect(() => saveNamedLayoutsToStorage(SAMPLE, undefined)).not.toThrow();
    expect(loadNamedLayoutsFromStorage(undefined)).toBeNull();
  });

  it("accepts an empty layouts array", () => {
    const s = makeStorage();
    const empty: PersistedNamedLayouts = {
      version: 2,
      layouts: [],
      activeNamedLayoutId: null,
    };
    saveNamedLayoutsToStorage(empty, s);
    expect(loadNamedLayoutsFromStorage(s)).toEqual(empty);
  });

  it("treats a missing plotPanelSettings as empty (Phase 8 backwards compat)", () => {
    // Layouts saved before the per-panel settings field existed must
    // still load without dropping the user's saved layout.
    const s = makeStorage();
    s.setItem(
      NAMED_LAYOUTS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        layouts: [
          {
            id: "x",
            name: "x",
            layoutJson: null,
            videoBindings: {},
            plotBindings: {},
            sceneBindings: {},
            mapBindings: {},
            tableBindings: {},
            enumBindings: {},
            // plotPanelSettings intentionally absent
            createdAt: 0,
          },
        ],
        activeNamedLayoutId: null,
      }),
    );
    const loaded = loadNamedLayoutsFromStorage(s);
    expect(loaded?.layouts[0].plotPanelSettings).toEqual({});
  });
});

interface FakeStore {
  getState: () => NamedLayoutsSlice;
  subscribe: (cb: (s: NamedLayoutsSlice) => void) => () => void;
  push: (next: NamedLayoutsSlice) => void;
  listenerCount: () => number;
}

function makeFakeStore(initial: NamedLayoutsSlice): FakeStore {
  let state = initial;
  const listeners = new Set<(s: NamedLayoutsSlice) => void>();
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

describe("attachNamedLayoutsPersistence", () => {
  const initial: NamedLayoutsSlice = {
    namedLayouts: [],
    activeNamedLayoutId: null,
  };

  it("writes when namedLayouts ref changes", () => {
    const s = makeStorage();
    const store = makeFakeStore(initial);
    const stop = attachNamedLayoutsPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(loadNamedLayoutsFromStorage(s)).toBeNull();
    store.push({
      namedLayouts: [SAMPLE_LAYOUT],
      activeNamedLayoutId: SAMPLE_LAYOUT.id,
    });
    expect(loadNamedLayoutsFromStorage(s)).toEqual({
      version: 2,
      layouts: [SAMPLE_LAYOUT],
      activeNamedLayoutId: SAMPLE_LAYOUT.id,
    });
    stop();
  });

  it("writes when activeNamedLayoutId changes alone", () => {
    const s = makeStorage();
    const store = makeFakeStore({
      namedLayouts: [SAMPLE_LAYOUT],
      activeNamedLayoutId: null,
    });
    const stop = attachNamedLayoutsPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({
      namedLayouts: [SAMPLE_LAYOUT],
      activeNamedLayoutId: SAMPLE_LAYOUT.id,
    });
    expect(loadNamedLayoutsFromStorage(s)?.activeNamedLayoutId).toBe(
      SAMPLE_LAYOUT.id,
    );
    stop();
  });

  it("skips the write when nothing in the slice changed", () => {
    const s = makeStorage();
    const store = makeFakeStore(initial);
    const stop = attachNamedLayoutsPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push(initial);
    expect(loadNamedLayoutsFromStorage(s)).toBeNull();
    stop();
  });

  it("unsubscribes on the returned dispose handle", () => {
    const s = makeStorage();
    const store = makeFakeStore(initial);
    const stop = attachNamedLayoutsPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(store.listenerCount()).toBe(1);
    stop();
    expect(store.listenerCount()).toBe(0);
    store.push({
      namedLayouts: [SAMPLE_LAYOUT],
      activeNamedLayoutId: null,
    });
    expect(loadNamedLayoutsFromStorage(s)).toBeNull();
  });

  it("is a no-op when storage is undefined", () => {
    const store = makeFakeStore(initial);
    const stop = attachNamedLayoutsPersistence(
      store as unknown as typeof useSession,
      undefined,
    );
    expect(store.listenerCount()).toBe(0);
    expect(() => stop()).not.toThrow();
  });
});
