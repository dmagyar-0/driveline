import { describe, expect, it } from "vitest";
import {
  FORMAT_REGISTRY_KEY,
  FORMAT_DRAFTS_KEY,
  loadRecipes,
  saveRecipe,
  removeRecipe,
  renameRecipe,
  exportRecipeBlob,
  loadDrafts,
  saveDraft,
  removeDraft,
  promoteDraft,
  recordDerivationCost,
  getDerivationCost,
  loadDerivationCosts,
  formatDerivationCost,
  matchRecipe,
  type RecipeDraft,
} from "./formatRegistry";
import type { Recipe } from "./recipe";

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, v);
    },
  } as Storage;
}

/** A minimal schema-valid recipe (fixed_record, one scalar channel). */
function recipe(name: string, exts: string[] = [".foo"]): Recipe {
  return {
    recipeVersion: 1,
    name,
    description: `${name} description`,
    detect: { extensions: exts },
    provenance: { createdBy: "format-agent", model: "claude-opus-4-8" },
    container: { type: "fixed_record", recordSizeBytes: 16 },
    time: { field: "t", unit: "micros" },
    fields: [
      { name: "t", offset: 0, dtype: "u64", endian: "le" },
      { name: "v", offset: 8, dtype: "f32", endian: "le" },
    ],
    channels: [
      { nativeId: "v", name: "signal/v", kind: "scalar", fields: ["v"] },
    ],
  };
}

describe("format registry — recipes", () => {
  it("saves, loads (newest first), and removes recipes", () => {
    const s = makeStorage();
    saveRecipe(recipe("A"), s);
    saveRecipe(recipe("B"), s);
    expect(loadRecipes(s).map((r) => r.name)).toEqual(["B", "A"]);

    removeRecipe("A", s);
    expect(loadRecipes(s).map((r) => r.name)).toEqual(["B"]);
  });

  it("save replaces a same-named recipe rather than duplicating", () => {
    const s = makeStorage();
    saveRecipe(recipe("A", [".one"]), s);
    saveRecipe(recipe("A", [".two"]), s);
    const all = loadRecipes(s);
    expect(all).toHaveLength(1);
    expect(all[0].detect?.extensions).toEqual([".two"]);
  });

  it("renameRecipe re-keys and carries cost metadata", () => {
    const s = makeStorage();
    saveRecipe(recipe("Old"), s);
    recordDerivationCost(
      "Old",
      { inputTokens: 100, outputTokens: 10, estimatedUsd: 0.5 },
      s,
    );
    renameRecipe("Old", "New", s);
    expect(loadRecipes(s).map((r) => r.name)).toEqual(["New"]);
    expect(getDerivationCost("Old", s)).toBeUndefined();
    expect(getDerivationCost("New", s)?.inputTokens).toBe(100);
  });

  it("renameRecipe is a no-op for blank / unknown names", () => {
    const s = makeStorage();
    saveRecipe(recipe("A"), s);
    renameRecipe("A", "   ", s);
    renameRecipe("missing", "B", s);
    expect(loadRecipes(s).map((r) => r.name)).toEqual(["A"]);
  });

  it("exportRecipeBlob makes a safe filename and excludes cost metadata", () => {
    const r = recipe("Acme DAQ v3!");
    const { filename, text } = exportRecipeBlob(r);
    expect(filename).toBe("acme-daq-v3.driveline-recipe.json");
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe("Acme DAQ v3!");
    expect(parsed).not.toHaveProperty("cost");
    expect(parsed).not.toHaveProperty("estimatedUsd");
  });

  it("removeRecipe drops orphan cost metadata", () => {
    const s = makeStorage();
    saveRecipe(recipe("A"), s);
    recordDerivationCost(
      "A",
      { inputTokens: 1, outputTokens: 1, estimatedUsd: 0.01 },
      s,
    );
    removeRecipe("A", s);
    expect(getDerivationCost("A", s)).toBeUndefined();
  });
});

describe("format registry — drafts shard (never auto-matched)", () => {
  function draft(name: string): RecipeDraft {
    return {
      recipe: recipe(name, [".draftfmt"]),
      reason: "did not converge",
      capturedAt: "2026-06-13T00:00:00Z",
      coverage: 0.7,
    };
  }

  it("drafts persist in a SEPARATE key from the registry", () => {
    const s = makeStorage();
    saveDraft(draft("D"), s);
    // Registry untouched; drafts live in their own key.
    expect(s.getItem(FORMAT_REGISTRY_KEY)).toBeNull();
    expect(s.getItem(FORMAT_DRAFTS_KEY)).not.toBeNull();
    expect(loadRecipes(s)).toEqual([]);
    expect(loadDrafts(s).map((d) => d.recipe.name)).toEqual(["D"]);
  });

  it("a draft is NEVER auto-matched on drop", async () => {
    const s = makeStorage();
    saveDraft(draft("D"), s);
    const file = new File([new Uint8Array(16)], "x.draftfmt");
    expect(await matchRecipe(file, s)).toBeNull();
  });

  it("a real recipe with the same extension still matches; drafts don't shadow it", async () => {
    const s = makeStorage();
    saveDraft(draft("D"), s);
    saveRecipe(recipe("Real", [".draftfmt"]), s);
    const file = new File([new Uint8Array(16)], "x.draftfmt");
    const m = await matchRecipe(file, s);
    expect(m?.name).toBe("Real");
  });

  it("promoteDraft moves a draft into the registry and carries its cost", () => {
    const s = makeStorage();
    const d = draft("D");
    d.cost = { inputTokens: 5, outputTokens: 2, estimatedUsd: 0.1 };
    saveDraft(d, s);
    promoteDraft("D", s);
    expect(loadDrafts(s)).toEqual([]);
    expect(loadRecipes(s).map((r) => r.name)).toEqual(["D"]);
    expect(getDerivationCost("D", s)?.inputTokens).toBe(5);
  });

  it("removeDraft drops only the named draft", () => {
    const s = makeStorage();
    saveDraft(draft("D1"), s);
    saveDraft(draft("D2"), s);
    removeDraft("D1", s);
    expect(loadDrafts(s).map((d) => d.recipe.name)).toEqual(["D2"]);
  });
});

describe("derivation cost telemetry", () => {
  it("records and lists per-format cost", () => {
    const s = makeStorage();
    recordDerivationCost(
      "A",
      { inputTokens: 12800, outputTokens: 800, estimatedUsd: 0.1 },
      s,
    );
    expect(loadDerivationCosts(s)).toEqual({
      A: { inputTokens: 12800, outputTokens: 800, estimatedUsd: 0.1 },
    });
  });

  it("formatDerivationCost renders a compact summary", () => {
    expect(
      formatDerivationCost({
        inputTokens: 12800,
        outputTokens: 800,
        estimatedUsd: 0.1,
      }),
    ).toBe("12,800 in / 800 out tokens · est. $0.10");
  });

  it("formatDerivationCost keeps sub-cent runs from reading $0.00", () => {
    expect(
      formatDerivationCost({
        inputTokens: 100,
        outputTokens: 10,
        estimatedUsd: 0.0031,
      }),
    ).toContain("$0.0031");
  });
});
