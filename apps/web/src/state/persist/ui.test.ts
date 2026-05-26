import { describe, expect, it } from "vitest";
import {
  attachUiPersistence,
  loadUiFromStorage,
  saveUiToStorage,
  UI_STORAGE_KEY,
  type PersistedUi,
  type RailTab,
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
  version: 2,
  activeRailTab: "channels",
  railCollapsed: false,
  timeMode: "relative",
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
      JSON.stringify({ ...SAMPLE, version: 99 }),
    );
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("accepts a v1 payload and defaults timeMode to relative", () => {
    const s = makeStorage();
    s.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeRailTab: "channels",
        railCollapsed: true,
      }),
    );
    expect(loadUiFromStorage(s)).toEqual({
      version: 2,
      activeRailTab: "channels",
      railCollapsed: true,
      timeMode: "relative",
    });
  });

  it("rejects an unknown timeMode in a v2 payload", () => {
    const s = makeStorage();
    // Unknown timeMode falls back to default rather than nulling the
    // entire payload; this is consistent with how v1 → v2 upgrades the
    // missing field. The whole record loads with `timeMode: "relative"`.
    s.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        activeRailTab: null,
        railCollapsed: false,
        timeMode: "unix-epoch",
      }),
    );
    expect(loadUiFromStorage(s)?.timeMode).toBe("relative");
  });

  it("returns null when activeRailTab is an unknown string", () => {
    const s = makeStorage();
    s.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeRailTab: "totally-not-a-tab",
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
        railCollapsed: "false",
      }),
    );
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("returns null when payload is an array rather than an object", () => {
    const s = makeStorage();
    s.setItem(UI_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("returns null when payload is null", () => {
    const s = makeStorage();
    s.setItem(UI_STORAGE_KEY, "null");
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("accepts a null activeRailTab", () => {
    const s = makeStorage();
    const p: PersistedUi = {
      version: 2,
      activeRailTab: null,
      railCollapsed: true,
      timeMode: "absolute",
    };
    saveUiToStorage(p, s);
    expect(loadUiFromStorage(s)).toEqual(p);
  });

  it.each(["sources", "channels", "layout", "panel", "events"] as RailTab[])(
    "round-trips %s as a known rail tab",
    (tab) => {
      const s = makeStorage();
      const p: PersistedUi = {
        version: 2,
        activeRailTab: tab,
        railCollapsed: false,
        timeMode: "relative",
      };
      saveUiToStorage(p, s);
      expect(loadUiFromStorage(s)?.activeRailTab).toBe(tab);
    },
  );

  it("no-ops when storage is undefined", () => {
    expect(() => saveUiToStorage(SAMPLE, undefined)).not.toThrow();
    expect(loadUiFromStorage(undefined)).toBeNull();
  });

  it("survives a getItem that throws (e.g. SecurityError)", () => {
    const throwing: Storage = {
      get length() {
        return 0;
      },
      clear: () => {},
      getItem: () => {
        throw new Error("blocked");
      },
      key: () => null,
      removeItem: () => {},
      setItem: () => {},
    } as Storage;
    expect(loadUiFromStorage(throwing)).toBeNull();
  });

  it("survives a setItem that throws (quota / private mode)", () => {
    const throwing: Storage = {
      get length() {
        return 0;
      },
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new Error("quota");
      },
    } as Storage;
    expect(() => saveUiToStorage(SAMPLE, throwing)).not.toThrow();
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
  const initial: UiSlice = {
    activeRailTab: null,
    railCollapsed: false,
    timeMode: "relative",
  };

  it("writes when activeRailTab changes", () => {
    const s = makeStorage();
    const store = makeFakeStore(initial);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(loadUiFromStorage(s)).toBeNull();
    store.push({ ...initial, activeRailTab: "channels" });
    expect(loadUiFromStorage(s)).toEqual({
      version: 2,
      activeRailTab: "channels",
      railCollapsed: false,
      timeMode: "relative",
    });
    stop();
  });

  it("writes when railCollapsed changes", () => {
    const s = makeStorage();
    const store = makeFakeStore(initial);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({ ...initial, railCollapsed: true });
    expect(loadUiFromStorage(s)).toEqual({
      version: 2,
      activeRailTab: null,
      railCollapsed: true,
      timeMode: "relative",
    });
    stop();
  });

  it("writes when timeMode changes", () => {
    const s = makeStorage();
    const store = makeFakeStore(initial);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({ ...initial, timeMode: "absolute" });
    expect(loadUiFromStorage(s)?.timeMode).toBe("absolute");
    stop();
  });

  it("skips the write when neither tracked field changes", () => {
    const s = makeStorage();
    const store = makeFakeStore({
      activeRailTab: "layout",
      railCollapsed: false,
      timeMode: "relative",
    });
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      s,
    );
    // Push the same values again; persistence layer must not write.
    store.push({
      activeRailTab: "layout",
      railCollapsed: false,
      timeMode: "relative",
    });
    expect(loadUiFromStorage(s)).toBeNull();
    stop();
  });

  it("unsubscribes on the returned dispose handle", () => {
    const s = makeStorage();
    const store = makeFakeStore(initial);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(store.listenerCount()).toBe(1);
    stop();
    expect(store.listenerCount()).toBe(0);
    store.push({ ...initial, activeRailTab: "events" });
    expect(loadUiFromStorage(s)).toBeNull();
  });

  it("is a no-op when storage is undefined", () => {
    const store = makeFakeStore(initial);
    const stop = attachUiPersistence(
      store as unknown as typeof useSession,
      undefined,
    );
    expect(store.listenerCount()).toBe(0);
    expect(() => stop()).not.toThrow();
  });
});
