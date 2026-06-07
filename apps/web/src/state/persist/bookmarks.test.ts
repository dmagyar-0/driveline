import { describe, expect, it } from "vitest";
import {
  attachBookmarksPersistence,
  BOOKMARKS_STORAGE_KEY,
  loadBookmarksFromStorage,
  saveBookmarksToStorage,
  type Bookmark,
  type BookmarksSlice,
} from "./bookmarks";
import type { useSession } from "../store";

const BOOKMARKS_STORAGE_KEY_V1 = "driveline.bookmarks.v1";

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

const SAMPLE_BOOKMARKS: Bookmark[] = [
  {
    id: "uuid-a",
    ns: 1_500_000_000n,
    beforeNs: 0n,
    afterNs: 0n,
    label: "hard brake",
    color: "#f97316",
    createdAt: 1_700_000_000_000,
    tags: {},
  },
  {
    id: "uuid-b",
    ns: 5_000_000_000n,
    beforeNs: 2_000_000_000n,
    afterNs: 3_000_000_000n,
    label: "lane change L",
    color: "#3b82f6",
    createdAt: 1_700_000_001_000,
    tags: { weather: "Rain", road_type: "Highway" },
  },
];

describe("bookmarks persist (v2)", () => {
  it("round-trips save → load with BigInt + range + tags encoding", () => {
    const s = makeStorage();
    saveBookmarksToStorage(SAMPLE_BOOKMARKS, s);
    expect(loadBookmarksFromStorage(s)).toEqual(SAMPLE_BOOKMARKS);
  });

  it("encodes ns / beforeNs / afterNs as decimal strings in storage", () => {
    const s = makeStorage();
    saveBookmarksToStorage(SAMPLE_BOOKMARKS, s);
    const raw = JSON.parse(s.getItem(BOOKMARKS_STORAGE_KEY) ?? "null");
    expect(raw.version).toBe(2);
    expect(raw.bookmarks[1].ns).toBe("5000000000");
    expect(raw.bookmarks[1].beforeNs).toBe("2000000000");
    expect(raw.bookmarks[1].afterNs).toBe("3000000000");
    expect(typeof raw.bookmarks[1].ns).toBe("string");
    expect(raw.bookmarks[1].tags).toEqual({
      weather: "Rain",
      road_type: "Highway",
    });
  });

  it("returns null when nothing is stored", () => {
    expect(loadBookmarksFromStorage(makeStorage())).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const s = makeStorage();
    s.setItem(BOOKMARKS_STORAGE_KEY, "not json {");
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null when version is not 2 (and not the migratable v1)", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({ version: 3, bookmarks: [] }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null when bookmarks is not an array", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({ version: 2, bookmarks: {} }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null for an unparseable ns string", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        bookmarks: [
          {
            id: "x",
            ns: "not-a-number",
            beforeNs: "0",
            afterNs: "0",
            label: "x",
            color: "#fff",
            createdAt: 0,
            tags: {},
          },
        ],
      }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null when a range duration is negative", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        bookmarks: [
          {
            id: "x",
            ns: "0",
            beforeNs: "-1",
            afterNs: "0",
            label: "x",
            color: "#fff",
            createdAt: 0,
            tags: {},
          },
        ],
      }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null when a tag value is not a string", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        bookmarks: [
          {
            id: "x",
            ns: "0",
            beforeNs: "0",
            afterNs: "0",
            label: "x",
            color: "#fff",
            createdAt: 0,
            tags: { weather: 5 },
          },
        ],
      }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null when an entry is missing required fields", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({ version: 2, bookmarks: [{ id: "x", ns: "0" }] }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("no-ops when storage is undefined", () => {
    expect(() =>
      saveBookmarksToStorage(SAMPLE_BOOKMARKS, undefined),
    ).not.toThrow();
    expect(loadBookmarksFromStorage(undefined)).toBeNull();
  });

  it("accepts an empty bookmarks array", () => {
    const s = makeStorage();
    saveBookmarksToStorage([], s);
    expect(loadBookmarksFromStorage(s)).toEqual([]);
  });

  it("preserves bigint values that exceed Number.MAX_SAFE_INTEGER", () => {
    const big: Bookmark = {
      id: "big",
      ns: 9_007_199_254_740_993n,
      beforeNs: 0n,
      afterNs: 0n,
      label: "huge",
      color: "#fff",
      createdAt: 0,
      tags: {},
    };
    const s = makeStorage();
    saveBookmarksToStorage([big], s);
    const loaded = loadBookmarksFromStorage(s);
    expect(loaded?.[0].ns).toBe(9_007_199_254_740_993n);
  });
});

describe("bookmarks v1 → v2 migration", () => {
  it("migrates a legacy v1 payload, defaulting range to 0 and tags to {}", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY_V1,
      JSON.stringify({
        version: 1,
        bookmarks: [
          { id: "old", ns: "42", label: "legacy", color: "#abc", createdAt: 7 },
        ],
      }),
    );
    expect(loadBookmarksFromStorage(s)).toEqual([
      {
        id: "old",
        ns: 42n,
        beforeNs: 0n,
        afterNs: 0n,
        label: "legacy",
        color: "#abc",
        createdAt: 7,
        tags: {},
      },
    ]);
  });

  it("prefers a present v2 payload over the legacy v1 key", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY_V1,
      JSON.stringify({
        version: 1,
        bookmarks: [
          { id: "old", ns: "1", label: "legacy", color: "#abc", createdAt: 1 },
        ],
      }),
    );
    saveBookmarksToStorage(SAMPLE_BOOKMARKS, s);
    expect(loadBookmarksFromStorage(s)).toEqual(SAMPLE_BOOKMARKS);
  });

  it("fails closed on a malformed v2 payload without falling back to v1", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY_V1,
      JSON.stringify({
        version: 1,
        bookmarks: [
          { id: "old", ns: "1", label: "legacy", color: "#abc", createdAt: 1 },
        ],
      }),
    );
    s.setItem(BOOKMARKS_STORAGE_KEY, "broken {");
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });
});

interface FakeStore {
  getState: () => BookmarksSlice;
  subscribe: (cb: (s: BookmarksSlice) => void) => () => void;
  push: (next: BookmarksSlice) => void;
  listenerCount: () => number;
}

function makeFakeStore(initial: BookmarksSlice): FakeStore {
  let state = initial;
  const listeners = new Set<(s: BookmarksSlice) => void>();
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

describe("attachBookmarksPersistence", () => {
  const initial: BookmarksSlice = { bookmarks: [] };

  it("writes when bookmarks ref changes", () => {
    const s = makeStorage();
    const store = makeFakeStore(initial);
    const stop = attachBookmarksPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
    store.push({ bookmarks: SAMPLE_BOOKMARKS });
    expect(loadBookmarksFromStorage(s)).toEqual(SAMPLE_BOOKMARKS);
    stop();
  });

  it("skips the write when bookmarks ref is unchanged", () => {
    const s = makeStorage();
    const store = makeFakeStore({ bookmarks: SAMPLE_BOOKMARKS });
    const stop = attachBookmarksPersistence(
      store as unknown as typeof useSession,
      s,
    );
    store.push({ bookmarks: SAMPLE_BOOKMARKS });
    expect(loadBookmarksFromStorage(s)).toBeNull();
    stop();
  });

  it("unsubscribes on the returned dispose handle", () => {
    const s = makeStorage();
    const store = makeFakeStore(initial);
    const stop = attachBookmarksPersistence(
      store as unknown as typeof useSession,
      s,
    );
    expect(store.listenerCount()).toBe(1);
    stop();
    expect(store.listenerCount()).toBe(0);
    store.push({ bookmarks: SAMPLE_BOOKMARKS });
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("is a no-op when storage is undefined", () => {
    const store = makeFakeStore(initial);
    const stop = attachBookmarksPersistence(
      store as unknown as typeof useSession,
      undefined,
    );
    expect(store.listenerCount()).toBe(0);
    expect(() => stop()).not.toThrow();
  });
});
