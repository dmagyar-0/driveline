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

interface PersistedRegistry {
  version: 1;
  recipes: Recipe[];
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
