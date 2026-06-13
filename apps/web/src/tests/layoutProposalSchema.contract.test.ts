import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LAYOUT_PROPOSAL_V1_SCHEMA,
  validateProposalAgainstSchema,
} from "../llm/layoutProposal";

// The canonical Layout Proposal schema lives in
// `docs/schemas/layoutProposal.v1.schema.json`; a byte-identical copy sits next
// to the llm module so the web build never imports across the `src` rootDir.
// This contract test holds the two copies in lock-step and proves the `kind`
// union is enforced — mirroring `recipeSchema.contract.test.ts`.

const repoRoot = resolve(__dirname, "../../../..");
const canonicalSchemaPath = resolve(
  repoRoot,
  "docs/schemas/layoutProposal.v1.schema.json",
);

describe("LayoutProposal v1 JSON Schema contract (canonical ↔ web copy)", () => {
  it("the web-bundled copy is byte-identical to the canonical docs schema", () => {
    const canonical = readFileSync(canonicalSchemaPath, "utf8");
    expect(JSON.parse(canonical)).toEqual(LAYOUT_PROPOSAL_V1_SCHEMA);
    const webCopyPath = resolve(
      __dirname,
      "../llm/layoutProposal.v1.schema.json",
    );
    expect(readFileSync(webCopyPath, "utf8")).toBe(canonical);
  });

  it("accepts each panel kind", () => {
    const r = validateProposalAgainstSchema({
      panels: [
        { kind: "plot", title: "P", channelIds: ["a"], yAxisGroups: [["a"]] },
        { kind: "map", latChannelId: "lat", lonChannelId: "lon" },
        { kind: "enum", channelIds: ["e"] },
        { kind: "table", channelIds: ["t"] },
        { kind: "value", channelIds: ["v"] },
      ],
      rationale: "everything",
    });
    expect(r).toHaveProperty("proposal");
  });

  it("rejects an unknown top-level key (additionalProperties:false)", () => {
    const r = validateProposalAgainstSchema({
      panels: [],
      rationale: "x",
      bogus: 1,
    });
    expect(r).toHaveProperty("error");
  });

  it("rejects an unknown panel-level key", () => {
    const r = validateProposalAgainstSchema({
      panels: [{ kind: "plot", title: "P", channelIds: ["a"], sneaky: true }],
      rationale: "x",
    });
    expect(r).toHaveProperty("error");
  });

  it("rejects a map panel missing lonChannelId", () => {
    const r = validateProposalAgainstSchema({
      panels: [{ kind: "map", latChannelId: "lat" }],
      rationale: "x",
    });
    expect(r).toHaveProperty("error");
  });
});
