/**
 * BYOK (bring-your-own-key) policy for the Format Agent (docs/12 §6).
 *
 * The Anthropic API key is the user's own. We hold it in a module-scoped
 * variable by default — never in Zustand (devtools/persist exposure), never in
 * recipe provenance, never in exported JSON, never logged. Optional
 * `localStorage` persistence is opt-in behind an explicit boolean (the dialog
 * shows the "anyone with this browser profile can use this key" warning).
 *
 * Lives in the lazy `llm/` chunk; nothing here is imported at app top level.
 */

/** localStorage key for opt-in persistence. */
const STORAGE_KEY = "driveline.anthropic.key";

/** The only base URL the engine will ever talk to (docs/12 §6). */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

// Module-scoped, in-memory by default. Survives only as long as the chunk is
// loaded; a reload clears it unless the user opted into persistence.
let memoryKey: string | null = null;

function safeLocalStorage(): Storage | null {
  try {
    // `localStorage` can throw (disabled cookies, sandboxed iframe, SSR).
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Return the active key: the in-memory value, or a persisted one if the user
 * opted into "remember on this device". `null` when no key is set.
 */
export function getKey(): string | null {
  if (memoryKey !== null) return memoryKey;
  const ls = safeLocalStorage();
  if (ls) {
    const persisted = ls.getItem(STORAGE_KEY);
    if (persisted) {
      // Promote to memory so subsequent reads don't touch storage.
      memoryKey = persisted;
      return persisted;
    }
  }
  return null;
}

/**
 * Set the active key. With `{ persist: true }` it is also written to
 * `localStorage` (opt-in, explicit). With `persist` falsy any previously
 * persisted copy is cleared — toggling "remember" off forgets the device copy.
 */
export function setKey(key: string, opts?: { persist?: boolean }): void {
  memoryKey = key;
  const ls = safeLocalStorage();
  if (!ls) return;
  if (opts?.persist) {
    ls.setItem(STORAGE_KEY, key);
  } else {
    ls.removeItem(STORAGE_KEY);
  }
}

/** Forget the key everywhere — memory and any persisted copy. */
export function clearKey(): void {
  memoryKey = null;
  const ls = safeLocalStorage();
  ls?.removeItem(STORAGE_KEY);
}

/** Whether a key is currently persisted to this device's `localStorage`. */
export function hasPersistedKey(): boolean {
  const ls = safeLocalStorage();
  return !!ls?.getItem(STORAGE_KEY);
}

/**
 * Guard: the engine refuses any base URL other than `api.anthropic.com`
 * (docs/12 §6 — "Requests go only to https://api.anthropic.com"). Throws on a
 * non-matching origin so a misconfigured or hostile base URL can never
 * exfiltrate the sample or the key elsewhere.
 */
export function assertAnthropicBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`refusing non-Anthropic base URL: ${url}`);
  }
  // Compare the normalized origin; reject http:, ports, and any other host.
  if (parsed.origin !== ANTHROPIC_BASE_URL) {
    throw new Error(
      `refusing non-Anthropic base URL: ${parsed.origin} (only ${ANTHROPIC_BASE_URL} is allowed)`,
    );
  }
}
