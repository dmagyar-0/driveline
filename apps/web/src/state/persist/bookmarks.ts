// Phase 8 · Event-tag (bookmark) persistence.
//
// Mirrors `state/persist/namedLayouts.ts` and `state/persist/ui.ts`:
// schema-versioned JSON in a single `localStorage` key, fail-closed
// validation, write-on-change subscriber that skips identical fires.
// Bookmarks outlive a session — `clear()` does NOT reset them, same
// posture as `namedLayouts`.
//
// `Bookmark.ns` is a `bigint` in-memory; on disk it round-trips as a
// decimal string so JSON parses cleanly across the structured-clone
// boundary. Mirrors `layout/persist.ts`'s BigInt encoding.
//
// Color is stored (not recomputed at render): we freeze the FNV-1a
// `colorFor(id)` lookup at create-time so a future palette change can
// not retroactively re-skin user bookmarks.
//
// ── Schema v2 (Event Tagging) ──────────────────────────────────────
// v2 turns a single-point bookmark into a *taggable event* that can
// optionally span a time range. Three fields are added per entry:
//   - `beforeNs` / `afterNs`: non-negative durations. The event covers
//     `[ns - beforeNs, ns + afterNs]`; both default to `0n` (a point
//     event). Encoded on disk as decimal strings, like `ns`.
//   - `tags`: `Record<attributeId, value>` keyed by the attribute ids
//     defined in the Event Tag config (`state/persist/eventTagConfig.ts`).
//     `{}` for an untagged event.
// A legacy v1 payload (no before/after/tags) is **migrated forward** on
// load rather than fail-closed dropped: missing durations become `0n`,
// missing tags become `{}`. The old v1 key is read once and left in
// place (harmless; allows a manual rollback). A malformed *v2* payload
// still fails closed (returns `null`) without falling back to v1.

import type { useSession } from "../store";

export const BOOKMARKS_STORAGE_KEY = "driveline.bookmarks.v2";
const BOOKMARKS_STORAGE_KEY_V1 = "driveline.bookmarks.v1";
export const BOOKMARKS_SCHEMA_VERSION = 2 as const;

export interface Bookmark {
  id: string;
  ns: bigint;
  /** Duration before `ns` the event covers (>= 0; 0 = point event). */
  beforeNs: bigint;
  /** Duration after `ns` the event covers (>= 0; 0 = point event). */
  afterNs: bigint;
  label: string;
  color: string;
  createdAt: number;
  /** Per-event attribute values, keyed by Event Tag config attribute id. */
  tags: Record<string, string>;
}

export interface PersistedBookmark {
  id: string;
  ns: string;
  beforeNs: string;
  afterNs: string;
  label: string;
  color: string;
  createdAt: number;
  tags: Record<string, string>;
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

/** A flat string→string map; rejects any non-string value. */
function validateTags(raw: unknown): Record<string, string> | null {
  if (!isPlainObject(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

type BookmarkCore = Pick<
  Bookmark,
  "id" | "ns" | "label" | "color" | "createdAt"
>;

/** id / ns / label / color / createdAt — shared by both schema versions. */
function validateCore(raw: Record<string, unknown>): BookmarkCore | null {
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

function validateBookmarkV2(raw: unknown): Bookmark | null {
  if (!isPlainObject(raw)) return null;
  const core = validateCore(raw);
  if (!core) return null;
  if (typeof raw.beforeNs !== "string" || typeof raw.afterNs !== "string") {
    return null;
  }
  const beforeNs = tryParseBigInt(raw.beforeNs);
  const afterNs = tryParseBigInt(raw.afterNs);
  if (beforeNs === null || afterNs === null) return null;
  if (beforeNs < 0n || afterNs < 0n) return null;
  const tags = validateTags(raw.tags);
  if (tags === null) return null;
  return { ...core, beforeNs, afterNs, tags };
}

/** v1 entry → v2 in-memory shape (no range, no tags). */
function migrateBookmarkV1(raw: unknown): Bookmark | null {
  if (!isPlainObject(raw)) return null;
  const core = validateCore(raw);
  if (!core) return null;
  return { ...core, beforeNs: 0n, afterNs: 0n, tags: {} };
}

function validate(raw: unknown): Bookmark[] | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== BOOKMARKS_SCHEMA_VERSION) return null;
  if (!Array.isArray(raw.bookmarks)) return null;
  const out: Bookmark[] = [];
  for (const b of raw.bookmarks) {
    const v = validateBookmarkV2(b);
    if (!v) return null;
    out.push(v);
  }
  return out;
}

function migrateV1(raw: unknown): Bookmark[] | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== 1) return null;
  if (!Array.isArray(raw.bookmarks)) return null;
  const out: Bookmark[] = [];
  for (const b of raw.bookmarks) {
    const v = migrateBookmarkV1(b);
    if (!v) return null;
    out.push(v);
  }
  return out;
}

function readAndValidate(
  storage: Storage,
  key: string,
  validator: (raw: unknown) => Bookmark[] | null,
): Bookmark[] | null {
  let text: string | null;
  try {
    text = storage.getItem(key);
  } catch {
    return null;
  }
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validator(parsed);
}

export function loadBookmarksFromStorage(
  storage: Storage | undefined = defaultStorage(),
): Bookmark[] | null {
  if (!storage) return null;
  // Prefer the current v2 payload (present → trust it, fail closed on
  // a malformed body without falling through to the legacy key).
  let v2Text: string | null;
  try {
    v2Text = storage.getItem(BOOKMARKS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (v2Text !== null)
    return readAndValidate(storage, BOOKMARKS_STORAGE_KEY, validate);
  // No v2 yet — migrate a legacy v1 payload forward so the Event
  // Tagging upgrade preserves the user's existing bookmarks.
  return readAndValidate(storage, BOOKMARKS_STORAGE_KEY_V1, migrateV1);
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
      beforeNs: b.beforeNs.toString(),
      afterNs: b.afterNs.toString(),
      label: b.label,
      color: b.color,
      createdAt: b.createdAt,
      tags: { ...b.tags },
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
