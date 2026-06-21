// Shared validation primitives for the persistence shards.
//
// Each shard (layout, named-layouts, ui, bookmarks, event-tag config) loads
// untrusted JSON from `localStorage` and must validate it fail-closed. The
// type guards for the common map shapes — string maps, nullable-string maps,
// string-array maps, and the `MapBinding` / `PointCloudOverlayBinding` /
// `PlotPanelSettingsLite` object maps — were duplicated across those shards.
// They live here once so a shape change is made in a single place.

import type {
  MapBinding,
  PlotPanelSettingsLite,
  PointCloudOverlayBinding,
} from "../../layout/persist";

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** `Record<string, string>` — every value must be a string. */
export function isStringMap(v: unknown): v is Record<string, string> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    if (typeof v[k] !== "string") return false;
  }
  return true;
}

/** `Record<string, string | null>`. */
export function isNullableStringMap(
  v: unknown,
): v is Record<string, string | null> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x !== null && typeof x !== "string") return false;
  }
  return true;
}

/** `Record<string, string[]>`. */
export function isStringArrayMap(v: unknown): v is Record<string, string[]> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    if (!isStringArray(v[k])) return false;
  }
  return true;
}

/** `Record<string, boolean>`. */
export function isBooleanMap(v: unknown): v is Record<string, boolean> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    if (typeof v[k] !== "boolean") return false;
  }
  return true;
}

export function isMapBindingMap(
  v: unknown,
): v is Record<string, MapBinding | null> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x === null) continue;
    if (!isPlainObject(x)) return false;
    if (typeof x.latChannelId !== "string") return false;
    if (typeof x.lonChannelId !== "string") return false;
  }
  return true;
}

export function isPointCloudOverlayMap(
  v: unknown,
): v is Record<string, PointCloudOverlayBinding | null> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x === null) continue;
    if (!isPlainObject(x)) return false;
    if (typeof x.calibrationChannelId !== "string") return false;
    if (typeof x.cameraName !== "string") return false;
    if (typeof x.pointcloudChannelId !== "string") return false;
  }
  return true;
}

export function isAxisAssignmentMap(v: unknown): v is Record<string, number> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0) return false;
  }
  return true;
}

export function isPlotPanelSettingsMap(
  v: unknown,
): v is Record<string, PlotPanelSettingsLite> {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (!isPlainObject(x)) return false;
    const t = x.gapThresholdSec;
    // Reject NaN / Infinity so we don't restore a junk value that the store
    // would just normalise away anyway.
    if (t !== null && (typeof t !== "number" || !Number.isFinite(t))) {
      return false;
    }
    // Optional, additive fields — only validate when present.
    if (
      x.axisAssignments !== undefined &&
      !isAxisAssignmentMap(x.axisAssignments)
    ) {
      return false;
    }
    if (x.stackAxes !== undefined && typeof x.stackAxes !== "boolean") {
      return false;
    }
    if (x.syncTimeAxis !== undefined && typeof x.syncTimeAxis !== "boolean") {
      return false;
    }
  }
  return true;
}
