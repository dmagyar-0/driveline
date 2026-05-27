// Bookmarks persistence. Mirrors `state/persist/namedLayouts.ts` and
// `state/persist/ui.ts`: schema-versioned JSON in a single localStorage
// key, fail-closed validation, write-on-change subscriber that skips
// identical fires. Bookmarks outlive a session — `clear()` does NOT
// reset them, same posture as `namedLayouts`.
//
// `Bookmark.ns` is a `bigint` in-memory; on disk it round-trips as a
// decimal string so JSON parses across the structured-clone boundary
// (matches `layout/persist.ts`'s BigInt encoding).
//
// Colour is frozen at create-time via FNV-1a `colorFor(id)` rather than
// recomputed at render — a future palette change must not retroactively
// re-skin user bookmarks.

import type { useSession } from "../store";

export const BOOKMARKS_STORAGE_KEY = "driveline.bookmarks.v1";
export const BOOKMARKS_SCHEMA_VERSION = 1 as const;

export interface Bookmark {
  id: string;
  ns: bigint;
  label: string;
  color: string;
  createdAt: number;
}

export interface PersistedBookmark {
  id: string;
  ns: string;
  label: string;
  color: string;
  createdAt: number;
}

export interface PersistedBookmarks {
  version: typeof BOOKMARKS_SCHEMA_VERSION;
  bookmarks: PersistedBookmark[];
}

function defaultStorage(): Storage | undefined {
  return typeof localStorage !== "undefined" ? localStorage : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tryParseBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function validateBookmark(raw: unknown): Bookmark | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.label !== "string") return null;
  if (typeof raw.color !== "string" || raw.color.length === 0) return null;
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) {
    return null;
  }
  if (typeof raw.ns !== "string") return null;
  const ns = tryParseBigInt(raw.ns);
  if (ns === null) return null;
  return {
    id: raw.id,
    ns,
    label: raw.label,
    color: raw.color,
    createdAt: raw.createdAt,
  };
}

function validate(raw: unknown): Bookmark[] | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== BOOKMARKS_SCHEMA_VERSION) return null;
  if (!Array.isArray(raw.bookmarks)) return null;
  const out: Bookmark[] = [];
  for (const b of raw.bookmarks) {
    const v = validateBookmark(b);
    if (!v) return null;
    out.push(v);
  }
  return out;
}

export function loadBookmarksFromStorage(
  storage: Storage | undefined = defaultStorage(),
): Bookmark[] | null {
  if (!storage) return null;
  let text: string | null;
  try {
    text = storage.getItem(BOOKMARKS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validate(parsed);
}

export function saveBookmarksToStorage(
  bookmarks: Bookmark[],
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  const payload: PersistedBookmarks = {
    version: BOOKMARKS_SCHEMA_VERSION,
    bookmarks: bookmarks.map((b) => ({
      id: b.id,
      ns: b.ns.toString(),
      label: b.label,
      color: b.color,
      createdAt: b.createdAt,
    })),
  };
  try {
    storage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private-mode bucket reject — best-effort only.
  }
}

export interface BookmarksSlice {
  bookmarks: Bookmark[];
}

export function attachBookmarksPersistence(
  store: typeof useSession,
  storage: Storage | undefined = defaultStorage(),
): () => void {
  if (!storage) return () => undefined;
  let last = store.getState().bookmarks;
  return store.subscribe((s: BookmarksSlice) => {
    if (s.bookmarks === last) return;
    last = s.bookmarks;
    saveBookmarksToStorage(last, storage);
  });
}
