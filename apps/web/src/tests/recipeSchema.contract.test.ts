import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRecipe,
  validateRecipeAgainstSchema,
  RECIPE_V1_SCHEMA,
} from "../state/recipe";

// The canonical schema lives in `docs/schemas/recipe.v1.schema.json`; a
// byte-identical copy sits next to the recipe module so the web build never
// imports across the `src` rootDir. This contract test holds the two copies in
// lock-step and proves the committed sample recipe validates, while unknown
// keys / wrong versions are rejected — mirroring `arrow.contract.test.ts`.

const repoRoot = resolve(__dirname, "../../../..");
const canonicalSchemaPath = resolve(
  repoRoot,
  "docs/schemas/recipe.v1.schema.json",
);
const sampleRecipePath = resolve(
  repoRoot,
  "sample-data/sample.acme.recipe.json",
);

/** A minimal recipe that exercises only the required props. */
const minimalRecipe = {
  recipeVersion: 1,
  container: { type: "fixed_record", recordSizeBytes: 8 },
  time: { field: "t", unit: "nanos" },
  fields: [{ name: "t", offset: 0, dtype: "u64" }],
  channels: [{ nativeId: "t", fields: ["t"] }],
};

describe("Recipe v1 JSON Schema contract (canonical ↔ web copy ↔ serde)", () => {
  it("the web-bundled copy is byte-identical to the canonical docs schema", () => {
    const canonical = readFileSync(canonicalSchemaPath, "utf8");
    const bundled = JSON.stringify(RECIPE_V1_SCHEMA);
    // Compare structurally (the bundled import is already parsed JSON) plus
    // verify the on-disk web copy matches the docs copy byte-for-byte.
    expect(JSON.parse(canonical)).toEqual(RECIPE_V1_SCHEMA);
    const webCopyPath = resolve(__dirname, "../state/recipe.v1.schema.json");
    expect(readFileSync(webCopyPath, "utf8")).toBe(canonical);
    expect(bundled.length).toBeGreaterThan(0);
  });

  it("validates the committed sample.acme.recipe.json", () => {
    const json = readFileSync(sampleRecipePath, "utf8");
    const result = parseRecipe(json);
    expect(result).toHaveProperty("recipe");
    if ("error" in result) throw new Error(result.error);
    expect(result.recipe.recipeVersion).toBe(1);
    expect(result.recipe.channels.length).toBe(8);
  });

  it("accepts a minimal valid recipe", () => {
    const result = validateRecipeAgainstSchema(minimalRecipe);
    expect(result).toHaveProperty("recipe");
  });

  it("rejects an unknown top-level key (additionalProperties:false)", () => {
    const result = validateRecipeAgainstSchema({
      ...minimalRecipe,
      bogusKey: 1,
    });
    expect(result).toHaveProperty("error");
  });

  it("rejects an unknown nested key inside container", () => {
    const result = validateRecipeAgainstSchema({
      ...minimalRecipe,
      container: { type: "fixed_record", recordSizeBytes: 8, sneaky: true },
    });
    expect(result).toHaveProperty("error");
  });

  it("rejects recipeVersion: 2", () => {
    const result = validateRecipeAgainstSchema({
      ...minimalRecipe,
      recipeVersion: 2,
    });
    expect(result).toHaveProperty("error");
  });

  it("rejects an unknown dtype enum value", () => {
    const result = validateRecipeAgainstSchema({
      ...minimalRecipe,
      fields: [{ name: "t", offset: 0, dtype: "u128" }],
    });
    expect(result).toHaveProperty("error");
  });
});
