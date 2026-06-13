// @vitest-environment jsdom
//
// FormatsDrawer · Format Registry management UI (docs/12 §3.4, §9, Phase 4).
//
// Renders saved recipes + drafts from localStorage (the formatRegistry shard),
// and exercises rename / delete / export / re-derive and the drafts section.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { FormatsDrawer } from "./FormatsDrawer";
import { useSession } from "../../state/store";
import {
  saveRecipe,
  saveDraft,
  loadRecipes,
  loadDrafts,
  recordDerivationCost,
} from "../../state/formatRegistry";
import type { Recipe } from "../../state/recipe";

function recipe(name: string): Recipe {
  return {
    recipeVersion: 1,
    name,
    description: `${name} desc`,
    detect: { extensions: [".foo"] },
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await useSession.getState().clear();
});

describe("FormatsDrawer", () => {
  it("shows an empty state when no recipes are saved", () => {
    render(<FormatsDrawer />);
    expect(screen.getByTestId("formats-empty")).toBeTruthy();
    expect(screen.queryByTestId("formats-drafts")).toBeNull();
  });

  it("lists saved recipes with channel count, provenance, and cost", () => {
    saveRecipe(recipe("Acme"));
    recordDerivationCost("Acme", {
      inputTokens: 12800,
      outputTokens: 800,
      estimatedUsd: 0.1,
    });
    render(<FormatsDrawer />);
    const row = screen.getByTestId("format-row-Acme");
    expect(within(row).getByText(/1 channel/)).toBeTruthy();
    expect(within(row).getByText(/format-agent/)).toBeTruthy();
    expect(within(row).getByText(/claude-opus-4-8/)).toBeTruthy();
    expect(screen.getByTestId("format-cost-Acme").textContent).toContain(
      "12,800 in / 800 out",
    );
  });

  it("renames a recipe inline", () => {
    saveRecipe(recipe("Old"));
    render(<FormatsDrawer />);
    fireEvent.click(screen.getByTestId("format-rename-Old"));
    const input = screen.getByTestId("format-rename-input-Old");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(loadRecipes().map((r) => r.name)).toEqual(["Renamed"]);
    expect(screen.getByTestId("format-row-Renamed")).toBeTruthy();
  });

  it("deletes a recipe", () => {
    saveRecipe(recipe("Gone"));
    render(<FormatsDrawer />);
    fireEvent.click(screen.getByTestId("format-delete-Gone"));
    expect(loadRecipes()).toEqual([]);
    expect(screen.queryByTestId("format-row-Gone")).toBeNull();
  });

  it("export triggers a download of a single recipe JSON", () => {
    saveRecipe(recipe("Exp"));
    const click = vi.fn();
    const realCreate = document.createElement.bind(document);
    const spy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = realCreate(tag) as HTMLElement;
        if (tag === "a") {
          (el as HTMLAnchorElement).click = click;
        }
        return el;
      });
    // jsdom lacks createObjectURL.
    const urlAny = URL as unknown as Record<string, unknown>;
    urlAny.createObjectURL = vi.fn(() => "blob:mock");
    urlAny.revokeObjectURL = vi.fn();

    render(<FormatsDrawer />);
    fireEvent.click(screen.getByTestId("format-export-Exp"));
    expect(click).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("re-derive routes through the store action with the picked file", () => {
    const reDeriveRecipe = vi.fn();
    useSession.setState({ reDeriveRecipe });
    saveRecipe(recipe("Rd"));
    render(<FormatsDrawer />);
    fireEvent.click(screen.getByTestId("format-rederive-Rd"));
    const file = new File([new Uint8Array(8)], "rep.foo");
    const input = screen.getByTestId(
      "formats-rederive-file",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    expect(reDeriveRecipe).toHaveBeenCalledWith("Rd", file);
  });

  it("renders the drafts section with promote/delete", () => {
    saveDraft({
      recipe: recipe("Draft1"),
      reason: "did not converge",
      capturedAt: "2026-06-13T00:00:00Z",
      coverage: 0.73,
    });
    render(<FormatsDrawer />);
    const section = screen.getByTestId("formats-drafts");
    expect(within(section).getByText(/best coverage 73.0%/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("draft-promote-Draft1"));
    expect(loadDrafts()).toEqual([]);
    expect(loadRecipes().map((r) => r.name)).toEqual(["Draft1"]);
  });
});
