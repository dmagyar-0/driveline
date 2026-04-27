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
  version: 2,
  layoutJson: {
    layout: { type: "row", weight: 100, children: [] },
  },
  videoBindings: { "video-1": "/cam/front", "video-2": null },
  plotBindings: { "plot-1": ["/vehicle/speed", "/vehicle/rpm"] },
  videoHudOn: { "video-1": true },
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
      JSON.stringify({ ...SAMPLE, version: 3 }),
    );
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

  it("returns null when bindings have wrong shape", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        layoutJson: null,
        videoBindings: { "video-1": 123 },
        plotBindings: {},
        videoHudOn: {},
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null for plot bindings containing non-strings", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        layoutJson: null,
        videoBindings: {},
        plotBindings: { "plot-1": ["ok", 42] },
        videoHudOn: {},
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null for non-boolean videoHudOn values", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        layoutJson: null,
        videoBindings: {},
        plotBindings: {},
        videoHudOn: { "video-1": "yes" },
      }),
    );
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("returns null when videoHudOn is missing entirely", () => {
    const s = makeStorage();
    s.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        layoutJson: null,
        videoBindings: {},
        plotBindings: {},
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
      version: 2,
      layoutJson: null,
      videoBindings: {},
      plotBindings: {},
      videoHudOn: {},
    };
    saveLayoutToStorage(payload, s);
    expect(loadLayoutFromStorage(s)).toEqual(payload);
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

describe("attachLayoutPersistence", () => {
  const initialSlice: LayoutSlice = {
    layoutJson: null,
    videoBindings: {},
    plotBindings: {},
    videoHudOn: {},
  };

  it("writes the current slice when any of the three tracked refs change", () => {
    const s = makeStorage();
    const store = makeFakeStore(initialSlice);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    // No write yet — zustand only fires subscribe on mutation.
    expect(loadLayoutFromStorage(s)).toBeNull();

    // Change layoutJson: a new reference must trigger a write.
    const nextLayout = { layout: { type: "row", weight: 100, children: [] } };
    store.push({
      ...initialSlice,
      layoutJson: nextLayout,
    });
    const loaded = loadLayoutFromStorage(s);
    expect(loaded?.layoutJson).toEqual(nextLayout);
    stop();
  });

  it("skips the write when the tracked refs are all identical to the snapshot", () => {
    const s = makeStorage();
    const store = makeFakeStore(initialSlice);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    // Push the *same* refs back through — attachLayoutPersistence
    // seeds `last` with the initial state, so this should early-return.
    store.push(initialSlice);
    expect(loadLayoutFromStorage(s)).toBeNull();
    stop();
  });

  it("unsubscribes on the returned dispose handle", () => {
    const s = makeStorage();
    const store = makeFakeStore(initialSlice);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(store.listenerCount()).toBe(1);
    stop();
    expect(store.listenerCount()).toBe(0);
    // Further mutations must not land in storage.
    store.push({
      ...initialSlice,
      plotBindings: { "plot-1": ["x"] },
    });
    expect(loadLayoutFromStorage(s)).toBeNull();
  });

  it("writes when plotBindings is a new object, even with equal contents", () => {
    const s = makeStorage();
    const store = makeFakeStore(initialSlice);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    // A fresh `{}` is reference-distinct from the initial `{}`, so
    // the persist layer conservatively flushes. This documents that
    // the adapter is reference-based, not deep-equal.
    store.push({
      layoutJson: null,
      videoBindings: {},
      plotBindings: {},
      videoHudOn: {},
    });
    const loaded = loadLayoutFromStorage(s);
    expect(loaded).not.toBeNull();
    expect(loaded?.plotBindings).toEqual({});
    stop();
  });

  it("writes when videoHudOn is a new object", () => {
    const s = makeStorage();
    const store = makeFakeStore(initialSlice);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({
      ...initialSlice,
      videoHudOn: { "video-1": true },
    });
    const loaded = loadLayoutFromStorage(s);
    expect(loaded?.videoHudOn).toEqual({ "video-1": true });
    stop();
  });

  it("is a no-op when storage is undefined", () => {
    const store = makeFakeStore(initialSlice);
    const stop = attachLayoutPersistence(
      store as unknown as typeof useSession,
      undefined,
    );
    // When storage is missing the adapter returns an inert dispose
    // and never subscribes — pushing does nothing and no error is
    // thrown on dispose.
    expect(store.listenerCount()).toBe(0);
    store.push({
      ...initialSlice,
      videoBindings: { "video-1": "/c" },
    });
    expect(() => stop()).not.toThrow();
  });
});
