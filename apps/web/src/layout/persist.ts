// T6.2 · Layout + panel-binding persistence.
//
// The whole layout slice (FlexLayout JSON model + per-panel video/plot
// bindings) serialises to a single `localStorage` key so a reload restores
// exactly what the user last saw. The adapter is a pure module — it takes
// an injectable `Storage` so Vitest's node env can round-trip against an
// in-memory stub without touching a real browser.
//
// Schema is versioned: on mismatch we return `null` and the store falls
// back to the default layout. Bumping the version means bumping the key
// too so stale v1 payloads don't collide with future reads.
//
// Phase 5 bumped to v2 to add `videoHudOn` (per-panel HUD overlay bit
// lifted out of `VideoPanel` local state). v1 payloads return `null` from
// `validate()`, which intentionally drops the user's old layout/bindings
// — acceptable per the existing fail-closed posture; pre-v1 app stage.
//
// `attachLayoutPersistence` wires the Zustand subscribe → Storage write
// loop; the first post-hydration fire is skipped so we don't rewrite the
// exact payload we just loaded.

import type { useSession } from "../state/store";

export const LAYOUT_STORAGE_KEY = "driveline.layout.v2";
export const LAYOUT_SCHEMA_VERSION = 2 as const;

export interface PersistedLayout {
  version: typeof LAYOUT_SCHEMA_VERSION;
  layoutJson: unknown | null;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  videoHudOn: Record<string, boolean>;
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

function validate(raw: unknown): PersistedLayout | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== LAYOUT_SCHEMA_VERSION) return null;
  const vb = raw.videoBindings;
  const pb = raw.plotBindings;
  const hud = raw.videoHudOn;
  if (!isPlainObject(vb) || !isPlainObject(pb) || !isPlainObject(hud))
    return null;
  for (const k of Object.keys(vb)) {
    const v = vb[k];
    if (v !== null && typeof v !== "string") return null;
  }
  for (const k of Object.keys(pb)) {
    if (!isStringArray(pb[k])) return null;
  }
  for (const k of Object.keys(hud)) {
    if (typeof hud[k] !== "boolean") return null;
  }
  return {
    version: LAYOUT_SCHEMA_VERSION,
    layoutJson: raw.layoutJson ?? null,
    videoBindings: vb as Record<string, string | null>,
    plotBindings: pb as Record<string, string[]>,
    videoHudOn: hud as Record<string, boolean>,
  };
}

export function loadLayoutFromStorage(
  storage: Storage | undefined = defaultStorage(),
): PersistedLayout | null {
  if (!storage) return null;
  let text: string | null;
  try {
    text = storage.getItem(LAYOUT_STORAGE_KEY);
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

export function saveLayoutToStorage(
  p: PersistedLayout,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Quota errors / private-mode bucket reject: best-effort only. The
    // next mutation will try again.
  }
}

// The minimal slice the adapter cares about. Keeps the persist module
// decoupled from the full `SessionState` surface for tests.
export interface LayoutSlice {
  layoutJson: unknown | null;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;
  videoHudOn: Record<string, boolean>;
}

function snapshot(s: LayoutSlice): PersistedLayout {
  return {
    version: LAYOUT_SCHEMA_VERSION,
    layoutJson: s.layoutJson,
    videoBindings: s.videoBindings,
    plotBindings: s.plotBindings,
    videoHudOn: s.videoHudOn,
  };
}

export function attachLayoutPersistence(
  store: typeof useSession,
  storage: Storage | undefined = defaultStorage(),
): () => void {
  if (!storage) return () => undefined;
  // Seed the "last written" snapshot with current state so the very first
  // subscribe fire — which may be identical to what hydration just loaded —
  // doesn't re-stringify and write. We only write when a field actually
  // differs from the last write.
  let last = snapshot(store.getState());
  return store.subscribe((s: LayoutSlice) => {
    if (
      s.layoutJson === last.layoutJson &&
      s.videoBindings === last.videoBindings &&
      s.plotBindings === last.plotBindings &&
      s.videoHudOn === last.videoHudOn
    ) {
      return;
    }
    last = snapshot(s);
    saveLayoutToStorage(last, storage);
  });
}
