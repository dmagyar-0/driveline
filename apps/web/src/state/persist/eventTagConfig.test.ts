import { describe, expect, it } from "vitest";
import {
  attachEventTagConfigPersistence,
  DEFAULT_EVENT_TAG_CONFIG,
  EVENT_TAG_CONFIG_STORAGE_KEY,
  loadEventTagConfigFromStorage,
  parseEventTagConfig,
  saveEventTagConfigToStorage,
  serializeEventTagConfig,
  type EventTagConfig,
  type EventTagConfigSlice,
} from "./eventTagConfig";
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

const SAMPLE: EventTagConfig = {
  attributes: [
    {
      id: "weather",
      name: "Weather",
      type: "select",
      options: ["Clear", "Rain"],
    },
    { id: "note", name: "Note", type: "text", options: [] },
  ],
};

describe("eventTagConfig persist", () => {
  it("round-trips save → load", () => {
    const s = makeStorage();
    saveEventTagConfigToStorage(SAMPLE, s);
    expect(loadEventTagConfigFromStorage(s)).toEqual(SAMPLE);
  });

  it("stores the schema version in the payload", () => {
    const s = makeStorage();
    saveEventTagConfigToStorage(SAMPLE, s);
    const raw = JSON.parse(s.getItem(EVENT_TAG_CONFIG_STORAGE_KEY) ?? "null");
    expect(raw.version).toBe(1);
  });

  it("returns null when nothing is stored", () => {
    expect(loadEventTagConfigFromStorage(makeStorage())).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const s = makeStorage();
    s.setItem(EVENT_TAG_CONFIG_STORAGE_KEY, "nope {");
    expect(loadEventTagConfigFromStorage(s)).toBeNull();
  });

  it("returns null on a version mismatch", () => {
    const s = makeStorage();
    s.setItem(
      EVENT_TAG_CONFIG_STORAGE_KEY,
      JSON.stringify({ version: 99, attributes: [] }),
    );
    expect(loadEventTagConfigFromStorage(s)).toBeNull();
  });

  it("returns null for an invalid attribute type", () => {
    const s = makeStorage();
    s.setItem(
      EVENT_TAG_CONFIG_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        attributes: [{ id: "x", name: "X", type: "radio", options: [] }],
      }),
    );
    expect(loadEventTagConfigFromStorage(s)).toBeNull();
  });

  it("returns null for non-string options", () => {
    const s = makeStorage();
    s.setItem(
      EVENT_TAG_CONFIG_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        attributes: [{ id: "x", name: "X", type: "select", options: [1, 2] }],
      }),
    );
    expect(loadEventTagConfigFromStorage(s)).toBeNull();
  });

  it("returns null on duplicate attribute ids", () => {
    const s = makeStorage();
    s.setItem(
      EVENT_TAG_CONFIG_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        attributes: [
          { id: "x", name: "X", type: "text", options: [] },
          { id: "x", name: "Y", type: "text", options: [] },
        ],
      }),
    );
    expect(loadEventTagConfigFromStorage(s)).toBeNull();
  });

  it("no-ops when storage is undefined", () => {
    expect(() => saveEventTagConfigToStorage(SAMPLE, undefined)).not.toThrow();
    expect(loadEventTagConfigFromStorage(undefined)).toBeNull();
  });

  it("ships a non-empty default taxonomy", () => {
    expect(DEFAULT_EVENT_TAG_CONFIG.attributes.length).toBeGreaterThan(0);
    expect(DEFAULT_EVENT_TAG_CONFIG.attributes.map((a) => a.id)).toContain(
      "weather",
    );
  });
});

describe("parseEventTagConfig (import)", () => {
  it("parses the exported wrapper shape", () => {
    const text = serializeEventTagConfig(SAMPLE);
    expect(parseEventTagConfig(text)).toEqual(SAMPLE);
  });

  it("accepts a bare attributes array", () => {
    const text = JSON.stringify([
      { id: "w", name: "W", type: "select", options: ["a"] },
    ]);
    expect(parseEventTagConfig(text)).toEqual({
      attributes: [{ id: "w", name: "W", type: "select", options: ["a"] }],
    });
  });

  it("derives ids from names and defaults type/options", () => {
    const text = JSON.stringify({ attributes: [{ name: "Road Type" }] });
    expect(parseEventTagConfig(text)).toEqual({
      attributes: [
        { id: "road_type", name: "Road Type", type: "select", options: [] },
      ],
    });
  });

  it("de-duplicates colliding derived ids", () => {
    const text = JSON.stringify({
      attributes: [{ name: "Weather" }, { name: "Weather" }],
    });
    const parsed = parseEventTagConfig(text);
    const ids = parsed?.attributes.map((a) => a.id);
    expect(ids).toEqual(["weather", "weather_2"]);
  });

  it("returns null for unrecoverable JSON", () => {
    expect(parseEventTagConfig("not json")).toBeNull();
    expect(parseEventTagConfig(JSON.stringify({ foo: 1 }))).toBeNull();
  });
});

interface FakeStore {
  getState: () => EventTagConfigSlice;
  subscribe: (cb: (s: EventTagConfigSlice) => void) => () => void;
  push: (next: EventTagConfigSlice) => void;
  listenerCount: () => number;
}

function makeFakeStore(initial: EventTagConfigSlice): FakeStore {
  let state = initial;
  const listeners = new Set<(s: EventTagConfigSlice) => void>();
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

describe("attachEventTagConfigPersistence", () => {
  it("writes when the config ref changes", () => {
    const s = makeStorage();
    const store = makeFakeStore({ eventTagConfig: { attributes: [] } });
    const stop = attachEventTagConfigPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({ eventTagConfig: SAMPLE });
    expect(loadEventTagConfigFromStorage(s)).toEqual(SAMPLE);
    stop();
  });

  it("skips the write when the ref is unchanged and unsubscribes", () => {
    const s = makeStorage();
    const store = makeFakeStore({ eventTagConfig: SAMPLE });
    const stop = attachEventTagConfigPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({ eventTagConfig: SAMPLE });
    expect(loadEventTagConfigFromStorage(s)).toBeNull();
    expect(store.listenerCount()).toBe(1);
    stop();
    expect(store.listenerCount()).toBe(0);
  });
});
