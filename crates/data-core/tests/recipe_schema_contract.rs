//! Rust half of the Recipe v1 schema contract (mirrors `arrow_contract.rs` and
//! the TS `recipeSchema.contract.test.ts`).
//!
//! The single source of truth for the recipe shape is
//! `docs/schemas/recipe.v1.schema.json`, validated at runtime in tsc-land with
//! ajv. This test enforces the *Rust* half of that contract: the serde structs
//! in `recipe.rs` must deserialize the committed golden recipe, reject an
//! unknown `recipeVersion`, and reject unknown keys (`#[serde(deny_unknown_fields)]`
//! mirroring the schema's `additionalProperties:false`). A schema change that
//! relaxes/tightens one side without the other breaks here.

use std::path::PathBuf;

use data_core::recipe::Recipe;

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/crates/data-core
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// The committed golden recipe (the Format Agent's output for `sample.acme`)
/// must round-trip through the serde structs. The recipe JSON is committed even
/// though the `.acme` binary is git-ignored, so this never skips.
#[test]
fn committed_sample_recipe_deserializes() {
    let path = repo_root().join("sample-data/sample.acme.recipe.json");
    let json = std::fs::read_to_string(&path).expect("committed golden recipe must exist");
    let recipe: Recipe =
        serde_json::from_str(&json).expect("sample.acme.recipe.json must match the serde structs");

    assert_eq!(recipe.recipe_version, 1);
    assert_eq!(recipe.channels.len(), 8);
    assert_eq!(recipe.fields.len(), 9);
    assert_eq!(recipe.time.field, "t");
    // `detect` / `provenance` are accepted (opaque to the decoder) so a registry
    // round-trip never strips them.
    assert!(recipe.detect.is_some());
    assert!(recipe.provenance.is_some());
}

/// A minimal recipe exercising only the required props deserializes — matches
/// the `minimalRecipe` in the TS contract test.
#[test]
fn minimal_recipe_deserializes() {
    let json = r#"{
      "recipeVersion": 1,
      "container": { "type": "fixed_record", "recordSizeBytes": 8 },
      "time": { "field": "t", "unit": "nanos" },
      "fields": [ { "name": "t", "offset": 0, "dtype": "u64" } ],
      "channels": [ { "nativeId": "t", "fields": ["t"] } ]
    }"#;
    let recipe: Recipe = serde_json::from_str(json).expect("minimal recipe deserializes");
    assert_eq!(recipe.recipe_version, 1);
}

/// `recipeVersion: 2` deserializes structurally (the field is a `u32`) but the
/// decode plan rejects it. The JS side rejects it at the schema layer (`const 1`);
/// Rust enforces the version explicitly in `DecodePlan::build`.
#[test]
fn unknown_recipe_version_rejected_by_decoder() {
    let json = r#"{
      "recipeVersion": 2,
      "container": { "type": "fixed_record", "recordSizeBytes": 8 },
      "time": { "field": "t", "unit": "nanos" },
      "fields": [ { "name": "t", "offset": 0, "dtype": "u64" } ],
      "channels": [ { "nativeId": "t", "fields": ["t"] } ]
    }"#;
    let recipe: Recipe = serde_json::from_str(json).expect("structurally valid");
    assert_eq!(recipe.recipe_version, 2);
    // The decoder is the authority: it refuses any version != 1.
    assert!(
        data_core::RecipeReader::open(b"xxxxxxxx", json).is_err(),
        "decoder must reject recipeVersion != 1"
    );
}

/// Unknown top-level key is rejected (serde `deny_unknown_fields` mirrors the
/// schema's `additionalProperties:false`).
#[test]
fn unknown_top_level_key_rejected() {
    let json = r#"{
      "recipeVersion": 1,
      "bogusKey": 1,
      "container": { "type": "fixed_record", "recordSizeBytes": 8 },
      "time": { "field": "t", "unit": "nanos" },
      "fields": [ { "name": "t", "offset": 0, "dtype": "u64" } ],
      "channels": [ { "nativeId": "t", "fields": ["t"] } ]
    }"#;
    assert!(
        serde_json::from_str::<Recipe>(json).is_err(),
        "unknown top-level key must be rejected"
    );
}

/// Unknown nested key inside `time` is rejected (the `TimeSpec` struct carries
/// `deny_unknown_fields`).
#[test]
fn unknown_nested_key_rejected() {
    let json = r#"{
      "recipeVersion": 1,
      "container": { "type": "fixed_record", "recordSizeBytes": 8 },
      "time": { "field": "t", "unit": "nanos", "sneaky": true },
      "fields": [ { "name": "t", "offset": 0, "dtype": "u64" } ],
      "channels": [ { "nativeId": "t", "fields": ["t"] } ]
    }"#;
    assert!(
        serde_json::from_str::<Recipe>(json).is_err(),
        "unknown nested key in time must be rejected"
    );
}

/// Unknown keys *inside the container* cannot be rejected by serde: `Container`
/// is an internally-tagged enum, and serde does not support
/// `deny_unknown_fields` on its variants. The JSON Schema layer
/// (`additionalProperties:false`, enforced by ajv) is the authority for
/// container strictness — this test documents that split so a future
/// "tighten the container in serde" change is a conscious one.
#[test]
fn unknown_container_key_passes_serde_guarded_by_schema() {
    let json = r#"{
      "recipeVersion": 1,
      "container": { "type": "fixed_record", "recordSizeBytes": 8, "sneaky": true },
      "time": { "field": "t", "unit": "nanos" },
      "fields": [ { "name": "t", "offset": 0, "dtype": "u64" } ],
      "channels": [ { "nativeId": "t", "fields": ["t"] } ]
    }"#;
    assert!(
        serde_json::from_str::<Recipe>(json).is_ok(),
        "serde accepts unknown container keys; ajv (additionalProperties:false) rejects them"
    );
}

/// Unknown key inside a field entry is rejected.
#[test]
fn unknown_field_key_rejected() {
    let json = r#"{
      "recipeVersion": 1,
      "container": { "type": "fixed_record", "recordSizeBytes": 8 },
      "time": { "field": "t", "unit": "nanos" },
      "fields": [ { "name": "t", "offset": 0, "dtype": "u64", "wat": 1 } ],
      "channels": [ { "nativeId": "t", "fields": ["t"] } ]
    }"#;
    assert!(
        serde_json::from_str::<Recipe>(json).is_err(),
        "unknown key in a field entry must be rejected"
    );
}
