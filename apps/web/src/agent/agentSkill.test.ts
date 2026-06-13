import { describe, expect, it } from "vitest";
import { AGENT_SKILL } from "./agentSkill";
import { AGENT_API_VERSION } from "./agentApi";

// The BYOA skill is fixture-tested like `llm/prompts.ts`: the snapshot pins the
// exact bytes so any change to the agent-facing guide is deliberate and
// reviewed. If you intend to change it, update the snapshot in the same commit
// and explain why. Belt-and-suspenders behavioural assertions below guard the
// load-bearing pieces a snapshot update could silently drop.
describe("AGENT_SKILL", () => {
  it("is pinned to an exact, reviewed guide", () => {
    expect(AGENT_SKILL).toMatchSnapshot();
  });

  it("embeds the current API version", () => {
    expect(AGENT_SKILL).toContain(`(v${AGENT_API_VERSION})`);
  });

  it("documents the unlock + timestamp + ingestion protocol", () => {
    expect(AGENT_SKILL).toContain("?agent");
    expect(AGENT_SKILL).toContain("DECIMAL STRING");
    expect(AGENT_SKILL).toContain("AgentDataSourceSpec");
    expect(AGENT_SKILL).toContain("addDataSource");
    expect(AGENT_SKILL).toContain("getSkill()");
    expect(AGENT_SKILL).toContain("describe()");
  });

  it("includes a copy-pasteable worked example + the map case", () => {
    expect(AGENT_SKILL).toContain('createPanel("plot")');
    expect(AGENT_SKILL).toContain("bindChannels");
    expect(AGENT_SKILL).toContain("setCursor");
    expect(AGENT_SKILL).toContain('createPanel("map")');
    expect(AGENT_SKILL).toContain("setMapBinding");
    expect(AGENT_SKILL).toContain("Math.sin");
  });

  it("states that data stays in the browser", () => {
    expect(AGENT_SKILL).toMatch(/never uploaded|stays in this browser/i);
  });
});
