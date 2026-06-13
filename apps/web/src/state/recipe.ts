/**
 * Ingest Recipe — the declarative, code-free description of how to decode an
 * unknown binary log format. Mirrors the serde structs in
 * `crates/data-core/src/recipe.rs`; see `docs/12-format-agent.md` §3.
 *
 * A recipe is *data*: container framing + a field table + a channel manifest.
 * It is produced by the Format Agent (or hand-written / shared as JSON) and
 * interpreted by the audited Rust `RecipeReader` — never executed.
 */

export type RecipeTimeUnit = "nanos" | "micros" | "millis" | "seconds";
export type RecipeTimeMode = "absolute" | "relative";
export type Monotonicity = "none" | "non_decreasing" | "strictly_increasing";
export type FieldDType =
  | "u8"
  | "i8"
  | "u16"
  | "i16"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "f32"
  | "f64";
export type Endian = "le" | "be";
export type RecipeChannelKind = "scalar" | "enum";

/** Container framing. v1 implements `fixed_record`. */
export interface FixedRecordContainer {
  type: "fixed_record";
  headerSkipBytes?: number;
  recordSizeBytes: number;
}
export type Container = FixedRecordContainer;

export interface TimeSpec {
  field: string;
  unit: RecipeTimeUnit;
  mode?: RecipeTimeMode;
  /** Decimal string (ns can exceed 2^53). Defaults to "0". */
  epochOffsetNs?: string;
  monotonicity?: Monotonicity;
}

export interface FieldSpec {
  name: string;
  offset: number;
  dtype: FieldDType;
  endian?: Endian;
  scale?: number;
  valueOffset?: number;
  unit?: string;
  enumDict?: Record<string, string>;
}

export interface ChannelSpec {
  nativeId: string;
  name?: string;
  kind?: RecipeChannelKind;
  /** Exactly one field name in v1. */
  fields: string[];
  unit?: string;
}

/** How future drops auto-match this recipe (checked in `bucket.ts`). */
export interface RecipeDetect {
  extensions?: string[];
  magic?: Array<{ offset: number; bytesHex: string }>;
}

export interface RecipeProvenance {
  createdBy?: "format-agent" | "user";
  model?: string;
  createdAt?: string;
  sampleSha256?: string;
}

export interface Recipe {
  recipeVersion: 1;
  name?: string;
  description?: string;
  detect?: RecipeDetect;
  provenance?: RecipeProvenance;
  container: Container;
  time: TimeSpec;
  fields: FieldSpec[];
  channels: ChannelSpec[];
}

// --- Dry-run report (wire shape from `recipe_dry_run`) -----------------------
//
// The wasm bigint serializer renders every 64-bit integer field as a `bigint`;
// f64 fields (`min`, `max`, `coverage`) arrive as `number`.

export interface RawDryRunError {
  byte_offset: bigint;
  reason: string;
}
export interface RawTimeStats {
  start_ns: bigint;
  end_ns: bigint;
  monotonic_violations: bigint;
  median_delta_ns: bigint;
}
export interface RawPerChannelStat {
  native_id: string;
  count: bigint;
  min: number;
  max: number;
  nan_count: bigint;
  constant: boolean;
}
export interface RawRecipeDryRunReport {
  records_decoded: bigint;
  records_rejected: bigint;
  first_error: RawDryRunError | null;
  time_stats: RawTimeStats | null;
  per_channel: RawPerChannelStat[];
  coverage: number;
}

/** Parse + minimally validate a recipe JSON string. Returns the recipe or an
 * error message. This is the client-side gate before the recipe reaches Rust —
 * Rust re-validates and clamps, but a friendly message here avoids a raw wasm
 * error in the dialog. */
export function parseRecipe(
  json: string,
): { recipe: Recipe } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    return { error: `not valid JSON: ${String(e)}` };
  }
  if (typeof value !== "object" || value === null) {
    return { error: "recipe must be a JSON object" };
  }
  const r = value as Partial<Recipe>;
  if (r.recipeVersion !== 1) {
    return { error: "recipeVersion must be 1" };
  }
  if (!r.container || r.container.type !== "fixed_record") {
    return { error: "container.type must be 'fixed_record' (v1)" };
  }
  if (!r.time || typeof r.time.field !== "string") {
    return { error: "time.field is required" };
  }
  if (!Array.isArray(r.fields) || r.fields.length === 0) {
    return { error: "fields must be a non-empty array" };
  }
  if (!Array.isArray(r.channels)) {
    return { error: "channels must be an array" };
  }
  return { recipe: value as Recipe };
}
