// Shareable deep-link URL state.
//
// A user can copy a link that restores the workspace VIEW: the FlexLayout
// dock model, every panel's channel bindings, the cursor time, and the
// relative/absolute time-display mode. The encoded blob lives in the URL
// fragment (`#v=...`) so it never hits a server — Driveline is browser-only.
//
// IMPORTANT — what a link does NOT carry: the actual log files. Data files
// are local-only (dropped into the browser); they can't live in a URL. A
// restored link reconstructs the view (layout + which channel ids each
// panel wants + cursor + mode). The bindings re-activate once the user
// re-drops the matching file — the channel ids are stable across loads.
//
// Time values are nanoseconds in `bigint`. Per the project's hard rule we
// NEVER `Number()`/`parseInt` a timestamp bigint: `cursorNs` is serialised
// as a DECIMAL STRING (`BigInt.toString()`) and parsed back with `BigInt()`.

import { useSession } from "./store";
import type { MapBinding } from "../layout/persist";
import type { TimeMode } from "../timeline/formatTime";

/**
 * The decoded, in-memory shape of a shared view. `cursorNs` stays a decimal
 * string here and in the encoded form — it only becomes a `bigint` at the
 * `setCursor(BigInt(...))` boundary in {@link applyViewStateFromUrl}.
 */
export interface ViewState {
  layoutJson: unknown | null;
  bindings: {
    plot: Record<string, string[]>;
    video: Record<string, string | null>;
    map: Record<string, MapBinding | null>;
    table: Record<string, string[]>;
    value: Record<string, string[]>;
    enum: Record<string, string | null>;
    scene: Record<string, string | null>;
  };
  cursorNs: string;
  timeMode: TimeMode;
}

const HASH_PREFIX = "v=";

// ---- base64url helpers -----------------------------------------------------
// We base64url-encode the JSON (URL-safe alphabet, padding stripped) so the
// blob survives a copy/paste round-trip and doesn't need percent-escaping.

function toBase64Url(json: string): string {
  // Encode UTF-8 → base64. `btoa` only handles latin1, so widen via
  // `encodeURIComponent`/`unescape` which is well-defined for this purpose.
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  // Re-pad to a multiple of 4 so `atob` accepts it.
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return decodeURIComponent(escape(atob(b64 + pad)));
}

// ---- encode / decode -------------------------------------------------------

export function encodeViewState(state: ViewState): string {
  return toBase64Url(JSON.stringify(state));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Decode a base64url blob back into a {@link ViewState}. Returns `null` on
 * any malformed input (bad base64, bad JSON, wrong shape). Tolerates missing
 * fields by filling in safe defaults so a forward/backward schema drift
 * degrades to "restore what we can" instead of throwing.
 */
export function decodeViewState(str: string): ViewState | null {
  try {
    const raw: unknown = JSON.parse(fromBase64Url(str));
    if (!isObject(raw)) return null;

    const b = isObject(raw.bindings) ? raw.bindings : {};
    const asRecord = <T,>(v: unknown): Record<string, T> =>
      isObject(v) ? (v as Record<string, T>) : {};

    const cursorNs =
      typeof raw.cursorNs === "string" ? raw.cursorNs : "0";
    // Validate the cursor really is a decimal bigint; bail to "0" otherwise
    // so a later `BigInt(cursorNs)` can't throw on apply.
    let normalisedCursor = "0";
    try {
      normalisedCursor = BigInt(cursorNs).toString();
    } catch {
      normalisedCursor = "0";
    }

    const timeMode: TimeMode =
      raw.timeMode === "absolute" ? "absolute" : "relative";

    return {
      layoutJson: "layoutJson" in raw ? raw.layoutJson : null,
      bindings: {
        plot: asRecord<string[]>(b.plot),
        video: asRecord<string | null>(b.video),
        map: asRecord<MapBinding | null>(b.map),
        table: asRecord<string[]>(b.table),
        value: asRecord<string[]>(b.value),
        enum: asRecord<string | null>(b.enum),
        scene: asRecord<string | null>(b.scene),
      },
      cursorNs: normalisedCursor,
      timeMode,
    };
  } catch {
    return null;
  }
}

// ---- store <-> ViewState ---------------------------------------------------

function snapshotViewState(): ViewState {
  const s = useSession.getState();
  return {
    layoutJson: s.layoutJson,
    bindings: {
      plot: s.plotBindings,
      video: s.videoBindings,
      map: s.mapBindings,
      table: s.tableBindings,
      value: s.valueBindings,
      enum: s.enumBindings,
      scene: s.sceneBindings,
    },
    cursorNs: s.cursorNs.toString(),
    timeMode: s.timeMode,
  };
}

/** True when there's something worth sharing (any binding or a layout). */
function hasMeaningfulState(state: ViewState): boolean {
  if (state.layoutJson !== null) return true;
  const b = state.bindings;
  return (
    Object.keys(b.plot).length > 0 ||
    Object.keys(b.video).length > 0 ||
    Object.keys(b.map).length > 0 ||
    Object.keys(b.table).length > 0 ||
    Object.keys(b.value).length > 0 ||
    Object.keys(b.enum).length > 0 ||
    Object.keys(b.scene).length > 0
  );
}

// ---- public API ------------------------------------------------------------

/**
 * Build a shareable URL for the current store state:
 * `${origin}${pathname}#v=<base64url>`. Feature-detects `location` so it
 * doesn't throw under SSR / a bare test runner.
 */
export function getShareUrl(): string {
  const encoded = encodeViewState(snapshotViewState());
  if (typeof location === "undefined") return `#${HASH_PREFIX}${encoded}`;
  return `${location.origin}${location.pathname}#${HASH_PREFIX}${encoded}`;
}

function readHashViewState(): ViewState | null {
  if (typeof location === "undefined") return null;
  const hash = location.hash.startsWith("#")
    ? location.hash.slice(1)
    : location.hash;
  if (!hash.startsWith(HASH_PREFIX)) return null;
  return decodeViewState(hash.slice(HASH_PREFIX.length));
}

/**
 * Apply restore the per-map bindings from a decoded {@link ViewState}.
 *
 * NOTE — we use the per-map setters rather than a single store restore
 * action: `restoreNamedLayout` only restores entries that already live in
 * the `namedLayouts` slice, and the hard rules forbid adding a new store
 * action just for this. The per-map setters are individually no-op-guarded
 * and dedupe/cap, so writing them in sequence lands a coherent snapshot.
 */
function applyBindings(state: ViewState): void {
  const store = useSession.getState();
  for (const [panelId, ids] of Object.entries(state.bindings.plot)) {
    store.setPlotBinding(panelId, ids);
  }
  for (const [panelId, id] of Object.entries(state.bindings.video)) {
    store.setVideoBinding(panelId, id);
  }
  for (const [panelId, binding] of Object.entries(state.bindings.map)) {
    store.setMapBinding(panelId, binding);
  }
  for (const [panelId, ids] of Object.entries(state.bindings.table)) {
    store.setTableBinding(panelId, ids);
  }
  for (const [panelId, ids] of Object.entries(state.bindings.value)) {
    store.setValueBinding(panelId, ids);
  }
  for (const [panelId, id] of Object.entries(state.bindings.enum)) {
    store.setEnumBinding(panelId, id);
  }
  for (const [panelId, id] of Object.entries(state.bindings.scene)) {
    store.setSceneBinding(panelId, id);
  }
}

/**
 * Parse `location.hash` for `#v=...`; if present and it decodes, apply it to
 * the store. Order is layout → bindings → cursor/mode so the cursor lands
 * last. `setCursor` clamps to `globalRange`, which is `null` until a file
 * loads — so the cursor write is a deliberate best-effort that no-ops when
 * no data is present yet (the user re-drops the file to re-activate
 * bindings; the cursor simply rides along once data arrives). Returns true
 * if a view state was found and applied.
 */
export function applyViewStateFromUrl(): boolean {
  const state = readHashViewState();
  if (!state) return false;
  const store = useSession.getState();
  store.setLayoutJson(state.layoutJson);
  applyBindings(state);
  store.setTimeMode(state.timeMode);
  // Best-effort: no-ops while `globalRange === null` (no data loaded).
  store.setCursor(BigInt(state.cursorNs));
  return true;
}

const DEBOUNCE_MS = 400;

/**
 * Apply any `#v=` view state once, then keep the URL fragment current as the
 * shared session evolves (debounced ~400 ms). Returns an unsubscribe that
 * also clears any pending debounce timer.
 *
 * Guards against a feedback loop: writing the hash with `history.replaceState`
 * doesn't fire `hashchange` and we never re-read the hash on a store change,
 * so a self-write can't re-trigger an apply.
 */
export function attachUrlState(): () => void {
  applyViewStateFromUrl();

  if (typeof location === "undefined" || typeof history === "undefined") {
    return () => undefined;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;

  const writeHash = (): void => {
    timer = null;
    const state = snapshotViewState();
    if (!hasMeaningfulState(state)) return;
    const next = `#${HASH_PREFIX}${encodeViewState(state)}`;
    if (location.hash === next) return;
    // `replaceState` updates the address bar without a history entry and
    // without firing `hashchange`, so this write can't loop back into us.
    history.replaceState(history.state, "", next);
  };

  const unsub = useSession.subscribe(() => {
    if (timer !== null) return;
    timer = setTimeout(writeHash, DEBOUNCE_MS);
  });

  return () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    unsub();
  };
}
