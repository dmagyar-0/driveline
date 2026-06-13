/**
 * Format Registry — local, persistent store of Ingest Recipes so the Format
 * Agent runs once per *format*, not once per file. A recipe derived (or
 * imported) today auto-matches future drops of the same format offline, with no
 * API key and no network. See `docs/12-format-agent.md` §3.4.
 *
 * Persistence mirrors `layout/persist.ts`: a single versioned localStorage key,
 * best-effort writes (quota / private-mode safe), defensive validation on load.
 */

import { parseRecipe, type Recipe } from "./recipe";

export const FORMAT_REGISTRY_KEY = "driveline.formats.v1";

/**
 * Drafts + side-metadata shard (Phase 4). Kept in a SEPARATE localStorage key
 * from the real registry so the schema-locked `Recipe` shape stays untouched
 * (the JSON Schema uses `additionalProperties:false` and the Rust serde uses
 * `deny_unknown_fields`, so neither draft markers nor per-format cost can live
 * inside a `Recipe`). `matchRecipe` reads ONLY the real registry, so a draft is
 * never auto-matched on drop (docs/12 §9).
 */
export const FORMAT_DRAFTS_KEY = "driveline.formats.drafts.v1";

interface PersistedRegistry {
  version: 1;
  recipes: Recipe[];
}

/** Last-run derivation cost recorded per format (docs/12 §4.5, Phase 4 cost
 * telemetry). Held OUTSIDE the `Recipe` so the schema/serde stay locked. */
export interface DerivationCost {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  /** ISO timestamp of the run that produced this recipe. */
  derivedAt?: string;
  /** Model that derived it (mirrors provenance.model, kept here too). */
  model?: string;
}

/**
 * A low-confidence "best attempt" recipe from a non-converging / gate-failing
 * run (docs/12 §9). Stored in the parallel drafts shard, never auto-matched.
 * Opens read-only with a "low-confidence decode" banner.
 */
export interface RecipeDraft {
  recipe: Recipe;
  /** Why this is a draft, surfaced in the Formats drawer + the banner. */
  reason: string;
  /** When the draft was captured (ISO). */
  capturedAt: string;
  /** The best dry-run coverage the run reached, 0..1 (for display). */
  coverage?: number;
  cost?: DerivationCost;
}

interface PersistedDrafts {
  version: 1;
  drafts: RecipeDraft[];
  /** Per-format last derivation cost, keyed by recipe `name`. */
  costs: Record<string, DerivationCost>;
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** All stored recipes, newest first. Invalid entries are dropped. */
export function loadRecipes(
  storage: Storage | undefined = defaultStorage(),
): Recipe[] {
  if (!storage) return [];
  let text: string | null;
  try {
    text = storage.getItem(FORMAT_REGISTRY_KEY);
  } catch {
    return [];
  }
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as PersistedRegistry).version !== 1 ||
    !Array.isArray((parsed as PersistedRegistry).recipes)
  ) {
    return [];
  }
  return (parsed as PersistedRegistry).recipes.filter(
    (r): r is Recipe => "recipe" in parseRecipe(JSON.stringify(r)),
  );
}

function persist(recipes: Recipe[], storage: Storage | undefined): void {
  if (!storage) return;
  const payload: PersistedRegistry = { version: 1, recipes };
  try {
    storage.setItem(FORMAT_REGISTRY_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort only — quota / private-mode rejections are non-fatal.
  }
}

/**
 * Add or replace a recipe (keyed by `name`). Newly saved recipes sort to the
 * front so they win a magic-collision pick.
 */
export function saveRecipe(
  recipe: Recipe,
  storage: Storage | undefined = defaultStorage(),
): void {
  const key = recipe.name ?? "";
  const rest = loadRecipes(storage).filter((r) => (r.name ?? "") !== key);
  persist([recipe, ...rest], storage);
}

export function removeRecipe(
  name: string,
  storage: Storage | undefined = defaultStorage(),
): void {
  persist(
    loadRecipes(storage).filter((r) => (r.name ?? "") !== name),
    storage,
  );
  // Drop any side-metadata (last-run cost) keyed by the same name so the shard
  // doesn't accumulate orphans.
  const meta = loadDraftsShard(storage);
  if (meta.costs[name] !== undefined) {
    const { [name]: _gone, ...rest } = meta.costs;
    persistDrafts({ ...meta, costs: rest }, storage);
  }
}

/**
 * Rename a saved recipe (registry key is `name`). No-op if `from` doesn't exist
 * or `to` is blank. If a recipe already uses `to`, this overwrites it (the UI
 * gates against an explicit collision). Side-metadata (cost) re-keys with it.
 */
export function renameRecipe(
  from: string,
  to: string,
  storage: Storage | undefined = defaultStorage(),
): void {
  const trimmed = to.trim();
  if (trimmed.length === 0 || trimmed === from) return;
  const recipes = loadRecipes(storage);
  const target = recipes.find((r) => (r.name ?? "") === from);
  if (!target) return;
  const next = recipes
    .filter((r) => (r.name ?? "") !== to)
    .map((r) => ((r.name ?? "") === from ? { ...r, name: trimmed } : r));
  persist(next, storage);
  // Re-key the per-format cost metadata so the drawer keeps showing it.
  const meta = loadDraftsShard(storage);
  const cost = meta.costs[from];
  if (cost !== undefined) {
    const { [from]: _gone, ...rest } = meta.costs;
    persistDrafts({ ...meta, costs: { ...rest, [trimmed]: cost } }, storage);
  }
}

/** Build the export blob + filename for a single recipe (docs/12 §3.4). The
 * caller (drawer) triggers the actual download. Keeps the cost metadata OUT of
 * the exported JSON (it's not part of the shareable recipe). */
export function exportRecipeBlob(recipe: Recipe): {
  filename: string;
  text: string;
} {
  const safe = (recipe.name ?? "recipe")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return {
    filename: `${safe || "recipe"}.driveline-recipe.json`,
    text: JSON.stringify(recipe, null, 2),
  };
}

// --- Drafts + per-format cost shard (Phase 4) --------------------------------

function loadDraftsShard(
  storage: Storage | undefined = defaultStorage(),
): PersistedDrafts {
  const empty: PersistedDrafts = { version: 1, drafts: [], costs: {} };
  if (!storage) return empty;
  let text: string | null;
  try {
    text = storage.getItem(FORMAT_DRAFTS_KEY);
  } catch {
    return empty;
  }
  if (!text) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as PersistedDrafts).version !== 1
  ) {
    return empty;
  }
  const p = parsed as Partial<PersistedDrafts>;
  const drafts = Array.isArray(p.drafts)
    ? p.drafts.filter(
        (d): d is RecipeDraft =>
          !!d &&
          typeof d === "object" &&
          "recipe" in d &&
          "recipe" in parseRecipe(JSON.stringify((d as RecipeDraft).recipe)),
      )
    : [];
  const costs =
    p.costs && typeof p.costs === "object" && !Array.isArray(p.costs)
      ? (p.costs as Record<string, DerivationCost>)
      : {};
  return { version: 1, drafts, costs };
}

function persistDrafts(
  shard: PersistedDrafts,
  storage: Storage | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(FORMAT_DRAFTS_KEY, JSON.stringify(shard));
  } catch {
    // Best-effort only.
  }
}

/** All saved drafts, newest first. */
export function loadDrafts(
  storage: Storage | undefined = defaultStorage(),
): RecipeDraft[] {
  return loadDraftsShard(storage).drafts;
}

/** Add or replace a draft (keyed by its recipe `name`); newest sorts first. */
export function saveDraft(
  draft: RecipeDraft,
  storage: Storage | undefined = defaultStorage(),
): void {
  const key = draft.recipe.name ?? "";
  const shard = loadDraftsShard(storage);
  const rest = shard.drafts.filter((d) => (d.recipe.name ?? "") !== key);
  persistDrafts({ ...shard, drafts: [draft, ...rest] }, storage);
}

export function removeDraft(
  name: string,
  storage: Storage | undefined = defaultStorage(),
): void {
  const shard = loadDraftsShard(storage);
  persistDrafts(
    {
      ...shard,
      drafts: shard.drafts.filter((d) => (d.recipe.name ?? "") !== name),
    },
    storage,
  );
}

/**
 * Promote a draft to a real registry recipe: move it from the drafts shard into
 * the registry. Carries any captured cost into the per-format cost metadata.
 * No-op on an unknown name.
 */
export function promoteDraft(
  name: string,
  storage: Storage | undefined = defaultStorage(),
): void {
  const shard = loadDraftsShard(storage);
  const draft = shard.drafts.find((d) => (d.recipe.name ?? "") === name);
  if (!draft) return;
  saveRecipe(draft.recipe, storage);
  if (draft.cost) recordDerivationCost(name, draft.cost, storage);
  removeDraft(name, storage);
}

// --- Per-format last-run cost (docs/12 §4.5 telemetry) ----------------------

/** Record the last derivation cost for a format (keyed by recipe `name`). */
export function recordDerivationCost(
  name: string,
  cost: DerivationCost,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (name.length === 0) return;
  const shard = loadDraftsShard(storage);
  persistDrafts({ ...shard, costs: { ...shard.costs, [name]: cost } }, storage);
}

/** The recorded last-run cost for a format, or `undefined` if none. */
export function getDerivationCost(
  name: string,
  storage: Storage | undefined = defaultStorage(),
): DerivationCost | undefined {
  return loadDraftsShard(storage).costs[name];
}

/** All recorded per-format costs (for the drawer's list render). */
export function loadDerivationCosts(
  storage: Storage | undefined = defaultStorage(),
): Record<string, DerivationCost> {
  return loadDraftsShard(storage).costs;
}

/**
 * Render a derivation cost as a compact one-line summary for the dialog outcome
 * and the Formats drawer ("12,800 in / 800 out · est. $0.10"). Pure — unit
 * tested. Token counts use locale grouping; USD is fixed to 2 dp (or more for
 * sub-cent runs so a cheap layout-style run doesn't read "$0.00").
 */
export function formatDerivationCost(cost: DerivationCost): string {
  const usd =
    cost.estimatedUsd >= 0.01
      ? `$${cost.estimatedUsd.toFixed(2)}`
      : `$${cost.estimatedUsd.toFixed(4)}`;
  return `${cost.inputTokens.toLocaleString()} in / ${cost.outputTokens.toLocaleString()} out tokens · est. ${usd}`;
}

function extensionMatches(recipe: Recipe, fileName: string): boolean {
  const exts = recipe.detect?.extensions ?? [];
  const lower = fileName.toLowerCase();
  return exts.some((e) => lower.endsWith(e.toLowerCase()));
}

function magicMatches(recipe: Recipe, head: Uint8Array): boolean {
  const magics = recipe.detect?.magic ?? [];
  if (magics.length === 0) return false;
  return magics.every((m) => {
    const bytes = hexToBytes(m.bytesHex);
    if (!bytes) return false;
    for (let i = 0; i < bytes.length; i++) {
      if (head[m.offset + i] !== bytes[i]) return false;
    }
    return true;
  });
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

/**
 * Find a stored recipe that matches a dropped file: a `magic` match wins
 * (strongest signal), else an `extensions` match. Reads only the file's first
 * 256 bytes. Returns `null` when nothing matches — the caller then queues the
 * file for the Format Agent dialog.
 */
export async function matchRecipe(
  file: File,
  storage: Storage | undefined = defaultStorage(),
): Promise<Recipe | null> {
  const recipes = loadRecipes(storage);
  if (recipes.length === 0) return null;
  const head = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  // Prefer a magic-byte match; fall back to extension.
  return (
    recipes.find((r) => magicMatches(r, head)) ??
    recipes.find((r) => extensionMatches(r, file.name)) ??
    null
  );
}
