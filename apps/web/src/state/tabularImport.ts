// Pure helpers for the CSV / Parquet import flow. Kept side-effect-free so
// vitest can exercise the time-basis maths (the precision-critical part of
// the feature) without booting the wasm worker or React.
//
// CSV / Parquet sources can't open until the user picks a *time basis*: which
// column carries time, what unit its values are in, whether those values are
// absolute (already epoch-relative) or relative to a clip-start epoch, and the
// epoch offset to add. The reader takes this as a JSON `TimeBasis`; everything
// here builds and previews that basis WITHOUT ever pushing a ns value through
// a lossy `Number` (epoch offsets are ~1.7e18, well past `Number.MAX_SAFE_INTEGER`).

import { formatAbsolute } from "../timeline/formatTime";

/** Time-unit tags as serialised by the wasm `TimeBasis` (`unit` field). */
export type TimeUnit = "Nanos" | "Micros" | "Millis" | "Seconds";

/** Absolute = column already holds epoch-relative values; Relative = values
 *  are offsets from `epoch_offset_ns` (the clip-start epoch). */
export type TimeBasisMode = "Absolute" | "Relative";

/**
 * The `TimeBasis` the wasm `open_tabular` endpoint expects (snake_case keys,
 * PascalCase enum values). `epoch_offset_ns` is serialised as a plain JS
 * number per the frozen wasm contract — the value is built from a `bigint`
 * (see `basisToJson`) so the only narrowing happens at the JSON boundary the
 * reader itself defines.
 */
export interface TimeBasis {
  time_column: string;
  unit: TimeUnit;
  mode: TimeBasisMode;
  epoch_offset_ns: number;
}

export interface TabularColumn {
  name: string;
  dtype: string;
  is_numeric: boolean;
}

/** The JSON object `tabular_inspect` returns. */
export interface TabularSchema {
  columns: TabularColumn[];
  suggested: TimeBasis;
}

/** Raw (wire) shapes — `epoch_offset_ns` may arrive as a `bigint` (large)
 *  or `number` (small) from serde_wasm_bindgen, mirroring the other summaries. */
interface RawTimeBasis {
  time_column: string;
  unit: TimeUnit;
  mode: TimeBasisMode;
  epoch_offset_ns: number | bigint;
}
export interface RawTabularSchema {
  columns: TabularColumn[];
  suggested: RawTimeBasis;
}

/** All four `TimeUnit` tags, in escalating magnitude — drives the unit
 *  selector order and the `ns`-per-unit table. */
export const TIME_UNITS: readonly TimeUnit[] = [
  "Nanos",
  "Micros",
  "Millis",
  "Seconds",
];

/** Short human label for a unit (used by the dialog selector). */
export function timeUnitLabel(unit: TimeUnit): string {
  switch (unit) {
    case "Nanos":
      return "nanoseconds (ns)";
    case "Micros":
      return "microseconds (µs)";
    case "Millis":
      return "milliseconds (ms)";
    case "Seconds":
      return "seconds (s)";
  }
  // Exhaustiveness guard — a new unit tag must be handled above.
  const _exhaustive: never = unit;
  return _exhaustive;
}

/** Nanoseconds per one tick of `unit`, as a `bigint` so conversions stay exact. */
export function nsPerUnit(unit: TimeUnit): bigint {
  switch (unit) {
    case "Nanos":
      return 1n;
    case "Micros":
      return 1_000n;
    case "Millis":
      return 1_000_000n;
    case "Seconds":
      return 1_000_000_000n;
  }
  const _exhaustive: never = unit;
  return _exhaustive;
}

/**
 * Editable form of a `TimeBasis`. The epoch offset is held as a decimal
 * STRING so the user can type a full-precision nanosecond value (≈1.7e18)
 * without it round-tripping through a lossy `number`. Everything that needs
 * the numeric value re-parses it as a `bigint`.
 */
export interface BasisDraft {
  timeColumn: string;
  unit: TimeUnit;
  mode: TimeBasisMode;
  /** Epoch offset in nanoseconds, as a decimal string (may be empty while editing). */
  epochOffsetNs: string;
}

/** Coalesce a raw schema's `epoch_offset_ns` (number | bigint) to `bigint`. */
function rawOffsetToBig(v: number | bigint): bigint {
  return typeof v === "bigint" ? v : BigInt(Math.trunc(v));
}

/** Build the editable default draft from an inspected schema's `suggested`
 *  basis. The offset is carried as a decimal string (via `bigint`) so a large
 *  epoch value is never narrowed through a lossy `number`. */
export function draftFromSchema(raw: RawTabularSchema): BasisDraft {
  const s = raw.suggested;
  return {
    timeColumn: s.time_column,
    unit: s.unit,
    mode: s.mode,
    epochOffsetNs: rawOffsetToBig(s.epoch_offset_ns).toString(),
  };
}

/** Parse the draft's epoch-offset string to a `bigint`, or `null` if it is not
 *  a valid (optionally signed) decimal integer. Empty string is treated as 0. */
export function parseEpochOffsetNs(raw: string): bigint | null {
  const t = raw.trim();
  if (t === "" || t === "-" || t === "+") return 0n;
  if (!/^[+-]?\d+$/.test(t)) return null;
  try {
    return BigInt(t);
  } catch {
    return null;
  }
}

/** True when the draft can be turned into a valid basis (column chosen, offset parses). */
export function isDraftValid(draft: BasisDraft): boolean {
  return (
    draft.timeColumn.trim().length > 0 &&
    parseEpochOffsetNs(draft.epochOffsetNs) !== null
  );
}

/**
 * Build the `TimeBasis` to hand to `open_tabular`. The epoch offset is parsed
 * as a `bigint` (full precision) and narrowed to `number` only here, at the
 * JSON boundary the frozen wasm contract defines — never before. Returns
 * `null` when the draft is invalid.
 */
export function draftToBasis(draft: BasisDraft): TimeBasis | null {
  const offset = parseEpochOffsetNs(draft.epochOffsetNs);
  if (offset === null || draft.timeColumn.trim().length === 0) return null;
  return {
    time_column: draft.timeColumn,
    unit: draft.unit,
    mode: draft.mode,
    epoch_offset_ns: Number(offset),
  };
}

/** Serialise a basis to the JSON string `open_tabular` expects. */
export function basisToJson(basis: TimeBasis): string {
  return JSON.stringify(basis);
}

/**
 * The wall-clock start epoch (ns) the chosen basis WILL anchor the timeline to,
 * computed without the file's actual sample values:
 *  - Relative: every sample is `epoch_offset_ns + value`, so the earliest
 *    representable start is exactly `epoch_offset_ns` (value 0). This is the
 *    "clip start epoch" the user is setting.
 *  - Absolute: samples already carry their own epoch (in `unit` ticks); the
 *    real start isn't known until load, so this returns `null`.
 */
export function previewStartNs(draft: BasisDraft): bigint | null {
  const offset = parseEpochOffsetNs(draft.epochOffsetNs);
  if (offset === null) return null;
  if (draft.mode === "Relative") return offset;
  return null;
}

/**
 * Human-readable UTC preview line for the chosen basis, so the user can verify
 * their timestamp interpretation before opening. For Relative mode this is the
 * exact clip-start wall clock; for Absolute mode the start depends on the
 * column's own values, so we say so rather than guess.
 */
export function previewStartLabel(draft: BasisDraft): string {
  const start = previewStartNs(draft);
  if (draft.mode === "Relative") {
    if (start === null) return "Enter a valid epoch offset to preview the start time.";
    return `${formatAbsolute(start)} UTC`;
  }
  return "Absolute — start time is read from the column on load.";
}
