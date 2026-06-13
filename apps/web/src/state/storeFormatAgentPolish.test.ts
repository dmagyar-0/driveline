// @vitest-environment jsdom
//
// Store unit tests for the Format Agent Phase-4 polish surface (docs/12 §9/§10):
// - reDeriveRecipe queues an unknown import in re-derive mode
// - confirmRecipeImport with `lowConfidence` opens a draft source (banner) and
//   does NOT register a recipe
// - confirmRecipeImport with `replaceRecipeName` overwrites the old registry
//   entry on a re-derive
// - the open-time stale-recipe gate queues a matched-but-failing recipe instead
//   of opening garbage
// - ingestConvertedMcap opens converted MCAP bytes as a one-shot source
//
// Uses a minimal fake worker covering only the recipe + mcap paths.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Remote } from "comlink";
import { useSession } from "./store";
import type { DataCoreApi } from "../workerClient";
import { loadRecipes, saveRecipe, FORMAT_REGISTRY_KEY } from "./formatRegistry";
import type { Recipe } from "./recipe";
import type { RawRecipeDryRunReport } from "./recipe";

function recipe(name: string, exts: string[] = [".aln"]): Recipe {
  return {
    recipeVersion: 1,
    name,
    description: `${name} desc`,
    detect: { extensions: exts },
    provenance: { createdBy: "format-agent" },
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

function report(coverage: number, rejected = 0): RawRecipeDryRunReport {
  return {
    records_decoded: 100n,
    records_rejected: BigInt(rejected),
    first_error: null,
    time_stats: {
      start_ns: 1_000n,
      end_ns: 2_000n,
      monotonic_violations: 0n,
      median_delta_ns: 10n,
    },
    per_channel: [
      {
        native_id: "v",
        count: 100n,
        min: 0,
        max: 9,
        nan_count: 0n,
        constant: false,
      },
    ],
    coverage,
  };
}

interface FakeOpts {
  /** Coverage the dry-run returns (drives the stale gate). */
  coverage?: number;
  rejected?: number;
}

function makeWorker(opts: FakeOpts = {}): Remote<DataCoreApi> {
  let nextHandle = 1;
  const summary = {
    start_ns: 1_000n,
    end_ns: 2_000n,
    channels: [
      {
        id: "v",
        name: "signal/v",
        group: null,
        kind: "scalar" as const,
        dtype: "f64",
        unit: null,
        sample_count: 100,
        start_ns: 1_000n,
        end_ns: 2_000n,
      },
    ],
  };
  const api = {
    async ping() {
      return "pong";
    },
    async recipeDryRun() {
      return report(opts.coverage ?? 1, opts.rejected ?? 0);
    },
    async openRecipe() {
      return nextHandle++;
    },
    async recipeSummary() {
      return summary;
    },
    async openMcap() {
      return nextHandle++;
    },
    async mcapSummary() {
      return summary;
    },
    async closeMcap() {},
    async closeRecipe() {},
  };
  return api as unknown as Remote<DataCoreApi>;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  localStorage.clear();
  await useSession.getState().clear();
});

describe("reDeriveRecipe", () => {
  it("queues an unknown import flagged for re-derivation", () => {
    useSession.getState().setWorker(makeWorker());
    const file = new File([new Uint8Array(16)], "rep.aln");
    useSession.getState().reDeriveRecipe("Old Format", file);
    const q = useSession.getState().pendingUnknownImports;
    expect(q).toHaveLength(1);
    expect(q[0].reDeriveName).toBe("Old Format");
    expect(q[0].name).toBe("rep.aln");
  });

  it("ignores an empty file", () => {
    useSession.getState().setWorker(makeWorker());
    useSession.getState().reDeriveRecipe("X", new File([], "empty.aln"));
    expect(useSession.getState().pendingUnknownImports).toHaveLength(0);
  });
});

describe("confirmRecipeImport — draft (low-confidence)", () => {
  it("opens a draft source with the banner flag and does NOT register a recipe", async () => {
    useSession.getState().setWorker(makeWorker());
    // Queue an unknown import via reDerive (any queue entry works).
    const file = new File([new Uint8Array(16)], "x.aln");
    useSession.setState({
      pendingUnknownImports: [{ id: "u1", name: "x.aln", size: 16, file }],
    });
    await useSession
      .getState()
      .confirmRecipeImport("u1", JSON.stringify(recipe("Draftish")), {
        lowConfidence: true,
      });
    const sources = useSession.getState().sources;
    expect(sources).toHaveLength(1);
    expect(sources[0].lowConfidence).toBe(true);
    // Never registered.
    expect(localStorage.getItem(FORMAT_REGISTRY_KEY)).toBeNull();
    expect(loadRecipes()).toEqual([]);
  });
});

describe("confirmRecipeImport — re-derive replacement", () => {
  it("overwrites the old registry entry when the name changed", async () => {
    useSession.getState().setWorker(makeWorker());
    saveRecipe(recipe("Old Name"));
    const file = new File([new Uint8Array(16)], "x.aln");
    useSession.setState({
      pendingUnknownImports: [{ id: "u1", name: "x.aln", size: 16, file }],
    });
    await useSession
      .getState()
      .confirmRecipeImport("u1", JSON.stringify(recipe("New Name")), {
        replaceRecipeName: "Old Name",
      });
    expect(loadRecipes().map((r) => r.name)).toEqual(["New Name"]);
  });
});

describe("open-time stale-recipe gate", () => {
  it("queues a matched-but-failing recipe instead of opening it", async () => {
    // Pre-seed a matching recipe; the dry-run returns low coverage → stale.
    saveRecipe(recipe("Stale", [".aln"]));
    useSession.getState().setWorker(makeWorker({ coverage: 0.4 }));
    const file = new File([new Uint8Array(16)], "drop.aln");
    await useSession.getState().openFiles([file]);
    expect(useSession.getState().sources).toHaveLength(0);
    const q = useSession.getState().pendingUnknownImports;
    expect(q).toHaveLength(1);
    expect(q[0].staleRecipe?.name).toBe("Stale");
  });

  it("opens cleanly when the matched recipe still decodes (coverage ok)", async () => {
    saveRecipe(recipe("Fresh", [".aln"]));
    useSession.getState().setWorker(makeWorker({ coverage: 1 }));
    const file = new File([new Uint8Array(16)], "drop.aln");
    await useSession.getState().openFiles([file]);
    expect(useSession.getState().sources).toHaveLength(1);
    expect(useSession.getState().pendingUnknownImports).toHaveLength(0);
  });
});

describe("ingestConvertedMcap (escape hatch)", () => {
  it("opens converted MCAP bytes as a one-shot source and dequeues", async () => {
    useSession.getState().setWorker(makeWorker());
    const file = new File([new Uint8Array(16)], "weird.bin");
    useSession.setState({
      pendingUnknownImports: [{ id: "u9", name: "weird.bin", size: 16, file }],
    });
    await useSession
      .getState()
      .ingestConvertedMcap("u9", "weird.bin", new Uint8Array([1, 2, 3]));
    const sources = useSession.getState().sources;
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe("mcap");
    expect(sources[0].oneShot).toBe(true);
    expect(sources[0].name).toContain(".mcap");
    expect(useSession.getState().pendingUnknownImports).toHaveLength(0);
  });
});
