// Phase 1 · UI shell persistence tests.
//
// Mirrors the structure of `layout/persist.test.ts`: in-memory `Storage`
// stub plus a hand-rolled fake store so the persist module is exercised
// in isolation from the real Zustand store and from `localStorage`.

import { describe, expect, it } from "vitest";
import {
  attachUiPersistence,
  loadUiFromStorage,
  saveUiToStorage,
  UI_STORAGE_KEY,
  type PersistedUi,
  type UiSlice,
} from "./ui";
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

const SAMPLE: PersistedUi = {
  version: 1,
  activeRailTab: "channels",
  railCollapsed: false,
};

describe("ui persist", () => {
  it("round-trips save → load", () => {
    const s = makeStorage();
    saveUiToStorage(SAMPLE, s);
    expect(loadUiFromStorage(s)).toEqual(SAMPLE);
  });

  it("returns null when nothing is stored", () => {
    expect(loadUiFromStorage(makeStorage())).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const s = makeStorage();
    s.setItem(UI_STORAGE_KEY, "not json {");
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("returns null when version mismatches", () => {
    const s = makeStorage();
    s.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({ ...SAMPLE, version: 2 }),
    );
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("returns null when activeRailTab is not a known tab id", () => {
    const s = makeStorage();
    s.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeRailTab: "not-a-real-tab",
        railCollapsed: false,
      }),
    );
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("returns null when railCollapsed is not a boolean", () => {
    const s = makeStorage();
    s.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeRailTab: null,
        railCollapsed: "yes",
      }),
    );
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("accepts an explicitly null activeRailTab", () => {
    const s = makeStorage();
    const payload: PersistedUi = {
      version: 1,
      activeRailTab: null,
      railCollapsed: true,
    };
    saveUiToStorage(payload, s);
    expect(loadUiFromStorage(s)).toEqual(payload);
  });

  it("accepts every documented RailTab id", () => {
    const s = makeStorage();
    for (const tab of ["sources", "channels", "layout", "panel", "events"] as const) {
      const payload: PersistedUi = {
        version: 1,
        activeRailTab: tab,
        railCollapsed: false,
      };
      saveUiToStorage(payload, s);
      expect(loadUiFromStorage(s)?.activeRailTab).toBe(tab);
    }
  });

  it("rejects payloads where the top-level value is not a plain object", () => {
    const s = makeStorage();
    s.setItem(UI_STORAGE_KEY, JSON.stringify(["activeRailTab", "channels"]));
    expect(loadUiFromStorage(s)).toBeNull();
    s.setItem(UI_STORAGE_KEY, JSON.stringify("a string"));
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("no-ops when storage is undefined", () => {
    expect(() => saveUiToStorage(SAMPLE, undefined)).not.toThrow();
    expect(loadUiFromStorage(undefined)).toBeNull();
  });
});

interface FakeStore {
  getState: () => UiSlice;
  subscribe: (cb: (s: UiSlice) => void) => () => void;
  push: (next: UiSlice) => void;
  listenerCount: () => number;
}

function makeFakeStore(initial: UiSlice): FakeStore {
  let state = initial;
  const listeners = new Set<(s: UiSlice) => void>();
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

describe("attachUiPersistence", () => {
  const initialSlice: UiSlice = {
    activeRailTab: null,
    railCollapsed: false,
  };

  it("writes the current slice when activeRailTab changes", () => {
    const s = makeStorage();
    const store = makeFakeStore(initialSlice);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(loadUiFromStorage(s)).toBeNull();

    store.push({ activeRailTab: "sources", railCollapsed: false });
    const loaded = loadUiFromStorage(s);
    expect(loaded?.activeRailTab).toBe("sources");
    expect(loaded?.railCollapsed).toBe(false);
    stop();
  });

  it("writes the current slice when railCollapsed changes", () => {
    const s = makeStorage();
    const store = makeFakeStore(initialSlice);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      s,
    );

    store.push({ activeRailTab: null, railCollapsed: true });
    expect(loadUiFromStorage(s)?.railCollapsed).toBe(true);
    stop();
  });

  it("skips the write when both tracked fields are equal to the snapshot", () => {
    const s = makeStorage();
    const store = makeFakeStore(initialSlice);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      s,
    );
    // Push the same values back through — the adapter seeds `last` with
    // the initial state, so this should early-return without writing.
    store.push({ activeRailTab: null, railCollapsed: false });
    expect(loadUiFromStorage(s)).toBeNull();
    stop();
  });

  it("unsubscribes on the returned dispose handle", () => {
    const s = makeStorage();
    const store = makeFakeStore(initialSlice);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(store.listenerCount()).toBe(1);
    stop();
    expect(store.listenerCount()).toBe(0);
    // Further mutations must not land in storage.
    store.push({ activeRailTab: "events", railCollapsed: true });
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("is a no-op when storage is undefined", () => {
    const store = makeFakeStore(initialSlice);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      undefined,
    );
    expect(store.listenerCount()).toBe(0);
    store.push({ activeRailTab: "panel", railCollapsed: true });
    expect(() => stop()).not.toThrow();
  });

  it("treats activeRailTab and railCollapsed independently", () => {
    const s = makeStorage();
    const store = makeFakeStore(initialSlice);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      s,
    );
    // Only railCollapsed flipped — the adapter must still write because
    // the second field changed.
    store.push({ activeRailTab: null, railCollapsed: true });
    expect(loadUiFromStorage(s)).toEqual({
      version: 1,
      activeRailTab: null,
      railCollapsed: true,
    });
    // Only activeRailTab flipped — must also write.
    store.push({ activeRailTab: "layout", railCollapsed: true });
    expect(loadUiFromStorage(s)).toEqual({
      version: 1,
      activeRailTab: "layout",
      railCollapsed: true,
    });
    stop();
  });
});
