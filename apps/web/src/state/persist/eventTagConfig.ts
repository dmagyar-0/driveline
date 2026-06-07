// Phase 8 · Event Tag config persistence.
//
// The Event Tagging feature lets a user attach structured attributes
// (weather, road type, lighting, …) to each event. The *schema* for
// those attributes lives in this config: a list of `TagAttribute`s,
// each either a single-`select` (with a fixed option list) or free
// `text`. The config is editable in-app (EventTagConfigEditor) and is
// importable / exportable as JSON so a team can share one taxonomy.
//
// Mirrors `state/persist/bookmarks.ts`: schema-versioned JSON in a
// single `localStorage` key, fail-closed strict validation on load,
// write-on-change subscriber that skips identical fires. The config
// outlives a session — `clear()` does NOT reset it, same posture as
// bookmarks and named layouts.
//
// On a fresh / missing / malformed store the slice hydrates to
// `DEFAULT_EVENT_TAG_CONFIG` (a sensible ADAS-style starter taxonomy)
// rather than empty, so the feature is useful out of the box.

import type { useSession } from "../store";

export const EVENT_TAG_CONFIG_STORAGE_KEY = "driveline.eventTags.config.v1";
export const EVENT_TAG_CONFIG_SCHEMA_VERSION = 1 as const;

export type TagAttributeType = "select" | "text";

export interface TagAttribute {
  id: string;
  name: string;
  type: TagAttributeType;
  /** Allowed values for a `select` attribute. Ignored for `text`. */
  options: string[];
}

export interface EventTagConfig {
  attributes: TagAttribute[];
}

export interface PersistedEventTagConfig {
  version: typeof EVENT_TAG_CONFIG_SCHEMA_VERSION;
  attributes: TagAttribute[];
}

// Starter taxonomy. The option lists follow common autonomous-driving
// scenario-element conventions (weather / road type / lighting /
// maneuver) so the feature ships useful and the user can prune or
// extend it. Ids are stable slugs so persisted tag values survive a
// rename of the display `name`.
export const DEFAULT_EVENT_TAG_CONFIG: EventTagConfig = {
  attributes: [
    {
      id: "weather",
      name: "Weather",
      type: "select",
      options: [
        "Clear",
        "Cloudy",
        "Overcast",
        "Rain",
        "Snow",
        "Fog",
        "Sandstorm",
      ],
    },
    {
      id: "road_type",
      name: "Road type",
      type: "select",
      options: [
        "Highway",
        "Urban",
        "Rural",
        "Ramp",
        "Tunnel",
        "Bridge",
        "Parking lot",
        "Intersection",
      ],
    },
    {
      id: "lighting",
      name: "Lighting",
      type: "select",
      options: ["Day", "Dusk/Dawn", "Night", "Low light", "Glare"],
    },
    {
      id: "maneuver",
      name: "Maneuver",
      type: "select",
      options: [
        "Go straight",
        "Turn left",
        "Turn right",
        "U-turn",
        "Lane change",
        "Overtake",
        "Accelerate",
        "Decelerate",
        "Stop",
        "Start",
        "Car following",
      ],
    },
  ],
};

function defaultStorage(): Storage | undefined {
  return typeof localStorage !== "undefined" ? localStorage : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Strict attribute validation used on persistence load (fail-closed). */
function validateAttribute(raw: unknown): TagAttribute | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.name !== "string") return null;
  if (raw.type !== "select" && raw.type !== "text") return null;
  if (!isStringArray(raw.options)) return null;
  return { id: raw.id, name: raw.name, type: raw.type, options: raw.options };
}

function validate(raw: unknown): EventTagConfig | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== EVENT_TAG_CONFIG_SCHEMA_VERSION) return null;
  if (!Array.isArray(raw.attributes)) return null;
  const out: TagAttribute[] = [];
  const seen = new Set<string>();
  for (const a of raw.attributes) {
    const v = validateAttribute(a);
    if (!v) return null;
    // Duplicate ids would make tag values ambiguous — reject.
    if (seen.has(v.id)) return null;
    seen.add(v.id);
    out.push(v);
  }
  return { attributes: out };
}

export function loadEventTagConfigFromStorage(
  storage: Storage | undefined = defaultStorage(),
): EventTagConfig | null {
  if (!storage) return null;
  let text: string | null;
  try {
    text = storage.getItem(EVENT_TAG_CONFIG_STORAGE_KEY);
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

export function saveEventTagConfigToStorage(
  config: EventTagConfig,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  const payload: PersistedEventTagConfig = {
    version: EVENT_TAG_CONFIG_SCHEMA_VERSION,
    attributes: config.attributes.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      options: [...a.options],
    })),
  };
  try {
    storage.setItem(EVENT_TAG_CONFIG_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private-mode bucket reject — best-effort only.
  }
}

function slugify(name: string, fallback: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : fallback;
}

/**
 * Lenient parse for user-supplied JSON import. Accepts any of:
 *   - the exported wrapper `{ version, attributes: [...] }`
 *   - a bare `{ attributes: [...] }`
 *   - a bare array of attributes `[...]`
 * Each attribute may omit `id` (derived from `name`), `type` (defaults
 * to `"select"`), and `options` (defaults to `[]`). Duplicate / empty
 * ids are de-duplicated with a numeric suffix. Returns `null` if the
 * shape is unrecoverable.
 */
export function parseEventTagConfig(text: string): EventTagConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let rawAttrs: unknown;
  if (Array.isArray(parsed)) {
    rawAttrs = parsed;
  } else if (isPlainObject(parsed) && Array.isArray(parsed.attributes)) {
    rawAttrs = parsed.attributes;
  } else {
    return null;
  }
  if (!Array.isArray(rawAttrs)) return null;
  const out: TagAttribute[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawAttrs.length; i++) {
    const raw = rawAttrs[i];
    if (!isPlainObject(raw)) return null;
    if (typeof raw.name !== "string" && typeof raw.id !== "string") return null;
    const name = typeof raw.name === "string" ? raw.name : String(raw.id);
    const type: TagAttributeType = raw.type === "text" ? "text" : "select";
    const options = isStringArray(raw.options) ? raw.options : [];
    let id =
      typeof raw.id === "string" && raw.id.length > 0
        ? raw.id
        : slugify(name, `attr_${i + 1}`);
    if (seen.has(id)) {
      let n = 2;
      while (seen.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    seen.add(id);
    out.push({ id, name, type, options });
  }
  return { attributes: out };
}

export function serializeEventTagConfig(config: EventTagConfig): string {
  const payload: PersistedEventTagConfig = {
    version: EVENT_TAG_CONFIG_SCHEMA_VERSION,
    attributes: config.attributes.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      options: [...a.options],
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export interface EventTagConfigSlice {
  eventTagConfig: EventTagConfig;
}

export function attachEventTagConfigPersistence(
  store: typeof useSession,
  storage: Storage | undefined = defaultStorage(),
): () => void {
  if (!storage) return () => undefined;
  let last = store.getState().eventTagConfig;
  return store.subscribe((s: EventTagConfigSlice) => {
    if (s.eventTagConfig === last) return;
    last = s.eventTagConfig;
    saveEventTagConfigToStorage(last, storage);
  });
}
