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
    label: "hard brake",
    color: "#f97316",
    createdAt: 1_700_000_000_000,
  },
  {
    id: "uuid-b",
    ns: 5_000_000_000n,
    label: "lane change L",
    color: "#3b82f6",
    createdAt: 1_700_000_001_000,
  },
];

interface RawPersisted {
  version: number;
  bookmarks: Array<{
    id: string;
    ns: string;
    label: string;
    color: string;
    createdAt: number;
  }>;
}

function persistedFromBookmarks(bms: Bookmark[]): RawPersisted {
  return {
    version: 1,
    bookmarks: bms.map((b) => ({
      id: b.id,
      ns: b.ns.toString(),
      label: b.label,
      color: b.color,
      createdAt: b.createdAt,
    })),
  };
}

describe("bookmarks persist", () => {
  it("round-trips save → load with BigInt encoding", () => {
    const s = makeStorage();
    saveBookmarksToStorage(SAMPLE_BOOKMARKS, s);
    expect(loadBookmarksFromStorage(s)).toEqual(SAMPLE_BOOKMARKS);
  });

  it("encodes ns as a decimal string in storage", () => {
    const s = makeStorage();
    saveBookmarksToStorage(SAMPLE_BOOKMARKS, s);
    const raw = JSON.parse(s.getItem(BOOKMARKS_STORAGE_KEY) ?? "null");
    expect(raw.bookmarks[0].ns).toBe("1500000000");
    expect(typeof raw.bookmarks[0].ns).toBe("string");
  });

  it("returns null when nothing is stored", () => {
    expect(loadBookmarksFromStorage(makeStorage())).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const s = makeStorage();
    s.setItem(BOOKMARKS_STORAGE_KEY, "not json {");
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null when version mismatches", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({ ...persistedFromBookmarks(SAMPLE_BOOKMARKS), version: 2 }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null when bookmarks is not an array", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({ version: 1, bookmarks: {} }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null for an unparseable ns string", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bookmarks: [
          {
            id: "x",
            ns: "not-a-number",
            label: "x",
            color: "#fff",
            createdAt: 0,
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
      JSON.stringify({
        version: 1,
        bookmarks: [{ id: "x", ns: "0" }],
      }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null when ns is a number rather than a string", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bookmarks: [
          { id: "x", ns: 1500000000, label: "x", color: "#fff", createdAt: 0 },
        ],
      }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("returns null when id is empty", () => {
    const s = makeStorage();
    s.setItem(
      BOOKMARKS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bookmarks: [
          { id: "", ns: "0", label: "x", color: "#fff", createdAt: 0 },
        ],
      }),
    );
    expect(loadBookmarksFromStorage(s)).toBeNull();
  });

  it("no-ops when storage is undefined", () => {
    expect(() => saveBookmarksToStorage(SAMPLE_BOOKMARKS, undefined)).not.toThrow();
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
      label: "huge",
      color: "#fff",
      createdAt: 0,
    };
    const s = makeStorage();
    saveBookmarksToStorage([big], s);
    const loaded = loadBookmarksFromStorage(s);
    expect(loaded?.[0].ns).toBe(9_007_199_254_740_993n);
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
