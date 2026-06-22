// Shared id minting. `randomUUID()` is available in modern browsers and
// Node ≥ 19; the `Math.random` fallback keeps unit tests under jsdom or older
// runtimes from crashing while still producing a unique-per-call id with the
// supplied prefix. Used by the named-layout, bookmark, and tag-attribute
// actions.
export function mintId(prefix: string): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Math.random().toString(36).slice(2)}`;
}
