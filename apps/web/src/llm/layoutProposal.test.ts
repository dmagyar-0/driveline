import { describe, expect, it } from "vitest";
import {
  requestLayoutProposal,
  sanitizeProposal,
  validateProposalAgainstSchema,
  buildProposalPrompt,
  type CreateMessagesClient,
  type LayoutMessage,
} from "./layoutProposal";
import { AgentError } from "./types";
import type { LayoutProposal, ProposalChannel } from "./layoutProposal.types";

function ch(id: string, name: string, kind = "scalar"): ProposalChannel {
  return { id, name, kind, dtype: "f64", unit: null, sampleCount: 10 };
}

const CHANNELS = [
  ch("a", "vehicle/speed"),
  ch("b", "vehicle/brake"),
  ch("lat", "gps/latitude"),
  ch("lon", "gps/longitude"),
];

/** A factory that returns a canned assistant message (structured-output text). */
function fakeClient(message: LayoutMessage | (() => Promise<LayoutMessage>)) {
  const factory: CreateMessagesClient = () => ({
    async createMessage() {
      return typeof message === "function" ? await message() : message;
    },
  });
  return factory;
}

function textMessage(obj: unknown): LayoutMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(obj) }],
    stop_reason: "end_turn",
  };
}

describe("validateProposalAgainstSchema", () => {
  it("accepts a valid proposal", () => {
    const r = validateProposalAgainstSchema({
      panels: [{ kind: "plot", title: "X", channelIds: ["a"] }],
      rationale: "ok",
    });
    expect(r).toHaveProperty("proposal");
  });

  it("rejects an unknown panel kind", () => {
    const r = validateProposalAgainstSchema({
      panels: [{ kind: "scatter", channelIds: ["a"] }],
      rationale: "x",
    });
    expect(r).toHaveProperty("error");
  });

  it("rejects a missing rationale", () => {
    const r = validateProposalAgainstSchema({ panels: [] });
    expect(r).toHaveProperty("error");
  });
});

describe("buildProposalPrompt", () => {
  it("includes ids, names and stats", () => {
    const prompt = buildProposalPrompt([ch("a", "vehicle/speed")], {
      a: { min: 0, max: 30, constant: false },
    });
    expect(prompt).toContain('id="a"');
    expect(prompt).toContain("vehicle/speed");
    expect(prompt).toContain("min=0");
    expect(prompt).toContain("max=30");
  });
});

describe("sanitizeProposal", () => {
  it("drops unknown channel ids and empty panels", () => {
    const proposal: LayoutProposal = {
      panels: [
        { kind: "plot", title: "X", channelIds: ["a", "ghost"] },
        { kind: "plot", title: "Y", channelIds: ["ghost"] },
      ],
      rationale: "r",
    };
    const out = sanitizeProposal(proposal, CHANNELS);
    expect(out.panels).toHaveLength(1);
    expect(out.panels[0]).toMatchObject({ channelIds: ["a"] });
  });

  it("de-duplicates channel ids within a panel", () => {
    const proposal: LayoutProposal = {
      panels: [{ kind: "plot", title: "X", channelIds: ["a", "a", "b"] }],
      rationale: "r",
    };
    const out = sanitizeProposal(proposal, CHANNELS);
    expect(out.panels[0]).toMatchObject({ channelIds: ["a", "b"] });
  });

  it("clamps a plot to MAX_PLOT_SERIES", async () => {
    const { MAX_PLOT_SERIES } = await import("../panels/palette");
    const many = Array.from({ length: MAX_PLOT_SERIES + 5 }, (_, i) =>
      ch(`x${i}`, `bus/s${i}`),
    );
    const proposal: LayoutProposal = {
      panels: [{ kind: "plot", title: "X", channelIds: many.map((c) => c.id) }],
      rationale: "r",
    };
    const out = sanitizeProposal(proposal, many);
    expect(
      out.panels[0].kind === "plot" && out.panels[0].channelIds.length,
    ).toBe(MAX_PLOT_SERIES);
  });

  it("drops a map panel with an unknown lat/lon id", () => {
    const proposal: LayoutProposal = {
      panels: [{ kind: "map", latChannelId: "lat", lonChannelId: "ghost" }],
      rationale: "r",
    };
    const out = sanitizeProposal(proposal, CHANNELS);
    expect(out.panels).toHaveLength(0);
  });

  it("keeps a valid map panel", () => {
    const proposal: LayoutProposal = {
      panels: [{ kind: "map", latChannelId: "lat", lonChannelId: "lon" }],
      rationale: "r",
    };
    const out = sanitizeProposal(proposal, CHANNELS);
    expect(out.panels).toHaveLength(1);
  });

  it("filters yAxisGroups down to surviving ids", () => {
    const proposal: LayoutProposal = {
      panels: [
        {
          kind: "plot",
          title: "X",
          channelIds: ["a", "b"],
          yAxisGroups: [["a", "ghost"], ["ghost"]],
        },
      ],
      rationale: "r",
    };
    const out = sanitizeProposal(proposal, CHANNELS);
    const panel = out.panels[0];
    expect(panel.kind === "plot" && panel.yAxisGroups).toEqual([["a"]]);
  });
});

describe("requestLayoutProposal", () => {
  const signal = new AbortController().signal;

  it("passes a valid proposal through (sanitized)", async () => {
    const proposal = {
      panels: [{ kind: "plot", title: "Vehicle", channelIds: ["a", "b"] }],
      rationale: "grouped vehicle signals",
    };
    const out = await requestLayoutProposal({
      channels: CHANNELS,
      apiKey: "sk-test",
      signal,
      createClient: fakeClient(textMessage(proposal)),
    });
    expect(out.panels).toHaveLength(1);
    expect(out.rationale).toBe("grouped vehicle signals");
  });

  it("sanitizes an over-cap / unknown-id / duplicate proposal", async () => {
    const proposal = {
      panels: [
        { kind: "plot", title: "X", channelIds: ["a", "a", "ghost"] },
        { kind: "map", latChannelId: "lat", lonChannelId: "nope" },
      ],
      rationale: "r",
    };
    const out = await requestLayoutProposal({
      channels: CHANNELS,
      apiKey: "sk-test",
      signal,
      createClient: fakeClient(textMessage(proposal)),
    });
    // The bad map is dropped; the plot keeps only the real, de-duped id.
    expect(out.panels).toHaveLength(1);
    expect(out.panels[0]).toMatchObject({ channelIds: ["a"] });
  });

  it("surfaces a refusal as a typed AgentError", async () => {
    const refusal: LayoutMessage = {
      role: "assistant",
      content: [],
      stop_reason: "refusal",
      stop_details: { explanation: "policy" },
    };
    await expect(
      requestLayoutProposal({
        channels: CHANNELS,
        apiKey: "sk-test",
        signal,
        createClient: fakeClient(refusal),
      }),
    ).rejects.toMatchObject({ kind: "refusal" });
  });

  it("maps a 401 to key-rejected", async () => {
    const factory: CreateMessagesClient = () => ({
      async createMessage() {
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      },
    });
    await expect(
      requestLayoutProposal({
        channels: CHANNELS,
        apiKey: "bad",
        signal,
        createClient: factory,
      }),
    ).rejects.toMatchObject({ kind: "key-rejected" });
  });

  it("rejects non-JSON model output", async () => {
    const msg: LayoutMessage = {
      role: "assistant",
      content: [{ type: "text", text: "not json {" }],
      stop_reason: "end_turn",
    };
    await expect(
      requestLayoutProposal({
        channels: CHANNELS,
        apiKey: "sk-test",
        signal,
        createClient: fakeClient(msg),
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it("refuses a non-Anthropic base URL", async () => {
    await expect(
      requestLayoutProposal({
        channels: CHANNELS,
        apiKey: "sk-test",
        baseUrl: "https://evil.example.com",
        signal,
        createClient: fakeClient(textMessage({ panels: [], rationale: "" })),
      }),
    ).rejects.toThrow(/non-Anthropic/);
  });
});
