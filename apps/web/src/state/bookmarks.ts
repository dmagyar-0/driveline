// Bookmark (event-tag) domain logic, extracted from the store factory
// (STATE-03). These actions own the "events" slice: placing bookmarks at the
// cursor / an explicit ns, importing them in bulk, renaming, ranging, tagging,
// and the Event Tag config (the attribute schema) plus its orphan-tag pruning.
//
// The implementations are unchanged — they still mutate the single store via
// the `get`/`set` the factory passes in. Bundling them here keeps the
// bookmark/tag rules in one cohesive module instead of inline among the
// ingestion FSM and the layout actions, while `store.ts` spreads the returned
// object into the store so every action name and signature is identical.
//
// `ns` / `beforeNs` / `afterNs` are `bigint` nanoseconds throughout; the
// persist adapter encodes them as decimal strings.

import { colorFor } from "../panels/palette";
import { formatRelative } from "../timeline/formatTime";
import {
  DEFAULT_EVENT_TAG_CONFIG,
  type EventTagConfig,
  type TagAttribute,
  type TagAttributeType,
} from "./persist/eventTagConfig";
import type { Bookmark } from "./persist/bookmarks";
import { mintId } from "./ids";
import type { AddBookmarkOpts, SessionState } from "./types";

// Re-export the default so `store.ts` can seed the slice from this module
// (keeping the bookmark/tag concern's defaults co-located with its actions).
export { DEFAULT_EVENT_TAG_CONFIG };

type Get = () => SessionState;
type Set = (partial: Partial<SessionState>) => void;

// Drop tag values whose attribute id no longer exists in `config` from
// every event. Shared by `setEventTagConfig` and `removeTagAttribute`;
// preserves array/object references when nothing changes so the persist
// subscriber and React selectors don't churn.
function pruneOrphanTags(get: Get, set: Set, config: EventTagConfig): void {
  const valid = new Set(config.attributes.map((a) => a.id));
  const prev = get().bookmarks;
  let changed = false;
  const next = prev.map((b) => {
    const drop = Object.keys(b.tags).filter((k) => !valid.has(k));
    if (drop.length === 0) return b;
    const tags = { ...b.tags };
    for (const k of drop) delete tags[k];
    changed = true;
    return { ...b, tags };
  });
  if (!changed) return;
  set({ bookmarks: next });
}

/** The bookmark + event-tag slice of `SessionState` — the action surface this
 *  module implements. Picked from `SessionState` so the signatures can never
 *  drift from the public type. */
export type BookmarkActions = Pick<
  SessionState,
  | "addBookmarkAtCursor"
  | "addBookmark"
  | "importBookmarks"
  | "removeBookmark"
  | "renameBookmark"
  | "setBookmarkRange"
  | "setBookmarkTag"
  | "setEventTagConfig"
  | "addTagAttribute"
  | "removeTagAttribute"
  | "updateTagAttribute"
>;

/** Build the bookmark/event-tag actions bound to the store's `get`/`set`. */
export function createBookmarkActions(get: Get, set: Set): BookmarkActions {
  return {
    addBookmarkAtCursor(label) {
      const { globalRange, cursorNs } = get();
      if (!globalRange) return null;
      const id = mintId("bm");
      const finalLabel =
        label !== undefined && label.trim().length > 0
          ? label.trim()
          : `bookmark @ ${formatRelative(cursorNs, globalRange.startNs)}`;
      const entry: Bookmark = {
        id,
        ns: cursorNs,
        beforeNs: 0n,
        afterNs: 0n,
        label: finalLabel,
        color: colorFor(id),
        createdAt: Date.now(),
        tags: {},
        origin: "user",
        confidence: null,
      };
      set({ bookmarks: [...get().bookmarks, entry] });
      return id;
    },

    addBookmark(ns: bigint, label?: string, opts?: AddBookmarkOpts) {
      const id = mintId("bm");
      const finalLabel =
        label !== undefined && label.trim().length > 0
          ? label.trim()
          : `bookmark @ ${formatRelative(ns, 0n)}`;
      const beforeNs = opts?.beforeNs ?? 0n;
      const afterNs = opts?.afterNs ?? 0n;
      const confidence = opts?.confidence ?? null;
      const entry: Bookmark = {
        id,
        ns,
        beforeNs: beforeNs < 0n ? 0n : beforeNs,
        afterNs: afterNs < 0n ? 0n : afterNs,
        label: finalLabel,
        color: colorFor(id),
        createdAt: Date.now(),
        tags: { ...(opts?.tags ?? {}) },
        origin: opts?.origin ?? "user",
        confidence:
          confidence === null ? null : Math.min(1, Math.max(0, confidence)),
      };
      set({ bookmarks: [...get().bookmarks, entry] });
      return id;
    },

    importBookmarks(entries: Bookmark[], mode: "merge" | "replace") {
      if (mode === "replace") {
        set({ bookmarks: [...entries] });
        return { added: entries.length, updated: 0 };
      }
      const byId = new Map(entries.map((e) => [e.id, e]));
      let updated = 0;
      const merged = get().bookmarks.map((b) => {
        const incoming = byId.get(b.id);
        if (!incoming) return b;
        byId.delete(b.id);
        updated++;
        return incoming;
      });
      const appended = entries.filter((e) => byId.has(e.id));
      set({ bookmarks: [...merged, ...appended] });
      return { added: appended.length, updated };
    },

    removeBookmark(id: string) {
      const prev = get().bookmarks;
      const next = prev.filter((b) => b.id !== id);
      if (next.length === prev.length) return false;
      set({ bookmarks: next });
      return true;
    },

    renameBookmark(id: string, label: string) {
      const trimmed = label.trim();
      if (trimmed.length === 0) return false;
      const prev = get().bookmarks;
      let changed = false;
      const next = prev.map((b) => {
        if (b.id !== id) return b;
        if (b.label === trimmed) return b;
        changed = true;
        return { ...b, label: trimmed };
      });
      if (!changed) return false;
      set({ bookmarks: next });
      return true;
    },

    setBookmarkRange(id: string, beforeNs: bigint, afterNs: bigint) {
      const before = beforeNs < 0n ? 0n : beforeNs;
      const after = afterNs < 0n ? 0n : afterNs;
      const prev = get().bookmarks;
      let changed = false;
      const next = prev.map((b) => {
        if (b.id !== id) return b;
        if (b.beforeNs === before && b.afterNs === after) return b;
        changed = true;
        return { ...b, beforeNs: before, afterNs: after };
      });
      if (!changed) return false;
      set({ bookmarks: next });
      return true;
    },

    setBookmarkTag(id: string, attributeId: string, value: string) {
      const clear = value.trim().length === 0;
      const prev = get().bookmarks;
      let changed = false;
      const next = prev.map((b) => {
        if (b.id !== id) return b;
        const has = attributeId in b.tags;
        if (clear) {
          if (!has) return b;
          const tags = { ...b.tags };
          delete tags[attributeId];
          changed = true;
          return { ...b, tags };
        }
        if (has && b.tags[attributeId] === value) return b;
        changed = true;
        return { ...b, tags: { ...b.tags, [attributeId]: value } };
      });
      if (!changed) return false;
      set({ bookmarks: next });
      return true;
    },

    setEventTagConfig(config: EventTagConfig) {
      set({ eventTagConfig: config });
      pruneOrphanTags(get, set, config);
    },

    addTagAttribute(name: string, type: TagAttributeType) {
      const id = mintId("attr");
      const trimmed = name.trim();
      const attr: TagAttribute = {
        id,
        name: trimmed.length > 0 ? trimmed : "New attribute",
        type,
        options: [],
      };
      set({
        eventTagConfig: {
          attributes: [...get().eventTagConfig.attributes, attr],
        },
      });
      return id;
    },

    removeTagAttribute(attributeId: string) {
      const prev = get().eventTagConfig.attributes;
      const next = prev.filter((a) => a.id !== attributeId);
      if (next.length === prev.length) return;
      const config: EventTagConfig = { attributes: next };
      set({ eventTagConfig: config });
      pruneOrphanTags(get, set, config);
    },

    updateTagAttribute(
      attributeId: string,
      patch: Partial<Pick<TagAttribute, "name" | "type" | "options">>,
    ) {
      const prev = get().eventTagConfig.attributes;
      let changed = false;
      const next = prev.map((a) => {
        if (a.id !== attributeId) return a;
        changed = true;
        return {
          ...a,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.options !== undefined ? { options: patch.options } : {}),
        };
      });
      if (!changed) return;
      set({ eventTagConfig: { attributes: next } });
    },
  };
}
