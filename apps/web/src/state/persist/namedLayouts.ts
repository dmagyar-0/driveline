// Phase 4 · Named-layouts persistence.
//
// Mirrors `state/persist/ui.ts` and `layout/persist.ts`: schema-versioned
// JSON in a single `localStorage` key, fail-closed validation, write-on-
// change subscriber that skips identical fires. The `namedLayouts` slice
// is independent of session lifetime (saved layouts outlive a
// `clearSession`, like bookmarks will in Phase 8).
//
// No BigInts in this slice — panel ids, channel ids, and the user-typed
// name are strings; `createdAt` is a millisecond `number`. So unlike the
// (future) bookmarks adapter no string-encoding round-trip is needed.

import type { useSession } from "../store";

export const NAMED_LAYOUTS_STORAGE_KEY = "driveline.layouts.named.v1";
export const NAMED_LAYOUTS_SCHEMA_VERSION = 1 as const;

export interface NamedLayout {
  id: string;
  name: string;
  layoutJson: unknown;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  createdAt: number;
}

export interface PersistedNamedLayouts {
  version: typeof NAMED_LAYOUTS_SCHEMA_VERSION;
  layouts: NamedLayout[];
  activeNamedLayoutId: string | null;
}

function defaultStorage(): Storage | undefined {
  return typeof localStorage !== "undefined" ? localStorage : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validateBindings(
  vb: unknown,
  pb: unknown,
): {
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
} | null {
  if (!isPlainObject(vb) || !isPlainObject(pb)) return null;
  for (const k of Object.keys(vb)) {
    const v = vb[k];
    if (v !== null && typeof v !== "string") return null;
  }
  for (const k of Object.keys(pb)) {
    if (!isStringArray(pb[k])) return null;
  }
  return {
    videoBindings: vb as Record<string, string | null>,
    plotBindings: pb as Record<string, string[]>,
  };
}

function validateLayout(raw: unknown): NamedLayout | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.name !== "string") return null;
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) {
    return null;
  }
  const bindings = validateBindings(raw.videoBindings, raw.plotBindings);
  if (!bindings) return null;
  return {
    id: raw.id,
    name: raw.name,
    layoutJson: raw.layoutJson ?? null,
    videoBindings: bindings.videoBindings,
    plotBindings: bindings.plotBindings,
    createdAt: raw.createdAt,
  };
}

function validate(raw: unknown): PersistedNamedLayouts | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== NAMED_LAYOUTS_SCHEMA_VERSION) return null;
  if (!Array.isArray(raw.layouts)) return null;
  const layouts: NamedLayout[] = [];
  for (const l of raw.layouts) {
    const v = validateLayout(l);
    if (!v) return null;
    layouts.push(v);
  }
  const active = raw.activeNamedLayoutId;
  if (active !== null && typeof active !== "string") return null;
  // Fail closed: an active id that doesn't match any saved layout is
  // treated as null rather than rejected — the user has nothing to gain
  // from us discarding the whole slice over a stale pointer.
  const activeId =
    active !== null && layouts.some((l) => l.id === active) ? active : null;
  return {
    version: NAMED_LAYOUTS_SCHEMA_VERSION,
    layouts,
    activeNamedLayoutId: activeId,
  };
}

export function loadNamedLayoutsFromStorage(
  storage: Storage | undefined = defaultStorage(),
): PersistedNamedLayouts | null {
  if (!storage) return null;
  let text: string | null;
  try {
    text = storage.getItem(NAMED_LAYOUTS_STORAGE_KEY);
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

export function saveNamedLayoutsToStorage(
  p: PersistedNamedLayouts,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(NAMED_LAYOUTS_STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Quota / private-mode bucket reject — best-effort only.
  }
}

export interface NamedLayoutsSlice {
  namedLayouts: NamedLayout[];
  activeNamedLayoutId: string | null;
}

function snapshot(s: NamedLayoutsSlice): PersistedNamedLayouts {
  return {
    version: NAMED_LAYOUTS_SCHEMA_VERSION,
    layouts: s.namedLayouts,
    activeNamedLayoutId: s.activeNamedLayoutId,
  };
}

export function attachNamedLayoutsPersistence(
  store: typeof useSession,
  storage: Storage | undefined = defaultStorage(),
): () => void {
  if (!storage) return () => undefined;
  let last = snapshot(store.getState());
  return store.subscribe((s: NamedLayoutsSlice) => {
    if (
      s.namedLayouts === last.layouts &&
      s.activeNamedLayoutId === last.activeNamedLayoutId
    ) {
      return;
    }
    last = snapshot(s);
    saveNamedLayoutsToStorage(last, storage);
  });
}
