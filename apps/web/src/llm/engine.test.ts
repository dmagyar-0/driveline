import { describe, expect, it, vi } from "vitest";
import type { RawRecipeDryRunReport } from "../state/recipe";
import {
  applyAcceptanceGate,
  ClientOrchestratedEngine,
  reportToJsonSafe,
  type AnthropicLike,
  type LlmContentBlock,
  type LlmMessage,
} from "./engine";
import { AcceptanceGateError, AgentError, type AgentProgress } from "./types";
import type { SampleBundle } from "./types";

// --- Fixtures ---------------------------------------------------------------

/** A schema-valid recipe (matches recipe.v1.schema.json) as a JSON string. */
const GOOD_RECIPE_JSON = JSON.stringify({
  recipeVersion: 1,
  name: "Synthetic Acme",
  container: { type: "fixed_record", headerSkipBytes: 0, recordSizeBytes: 16 },
  time: { field: "t", unit: "micros", monotonicity: "non_decreasing" },
  fields: [
    { name: "t", offset: 0, dtype: "u64", endian: "le" },
    { name: "v", offset: 8, dtype: "f32", endian: "le" },
  ],
  channels: [{ nativeId: "v", name: "signal", kind: "scalar", fields: ["v"] }],
});

function passingReport(): RawRecipeDryRunReport {
  return {
    records_decoded: 3000n,
    records_rejected: 0n,
    first_error: null,
    time_stats: {
      start_ns: 0n,
      end_ns: 1_000_000_000n,
      monotonic_violations: 0n,
      median_delta_ns: 10_000n,
    },
    per_channel: [
      {
        native_id: "v",
        count: 3000n,
        min: 0,
        max: 42.5,
        nan_count: 0n,
        constant: false,
      },
    ],
    coverage: 1.0,
  };
}

function badReport(coverage = 0.4): RawRecipeDryRunReport {
  return {
    records_decoded: 1200n,
    records_rejected: 800n,
    first_error: { byte_offset: 51_200n, reason: "framing violation" },
    time_stats: {
      start_ns: 0n,
      end_ns: 500_000n,
      monotonic_violations: 17n,
      median_delta_ns: 0n,
    },
    per_channel: [
      {
        native_id: "v",
        count: 1200n,
        min: 0,
        max: 0,
        nan_count: 0n,
        constant: true,
      },
    ],
    coverage,
  };
}

function fakeBundle(): SampleBundle {
  return {
    manifest: {
      filename: "x.acme",
      fileSize: 1024,
      sha256: "ab".repeat(32),
      slices: [{ kind: "head", byteOffset: 0, length: 1024, bundleOffset: 0 }],
      totalSampledBytes: 1024,
    },
    blob: new Blob([new Uint8Array(1024)]),
  };
}

// --- A scripted fake client -------------------------------------------------

function textBlock(text: string): LlmContentBlock {
  return { type: "text", text };
}
function toolUse(id: string, name: string, input: unknown): LlmContentBlock {
  return { type: "tool_use", id, name, input };
}
function validateCall(id: string, recipeJson: string): LlmContentBlock {
  return toolUse(id, "validate_recipe", { recipe: recipeJson });
}

interface ScriptedTurn {
  content: LlmContentBlock[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string } | null;
  usage?: LlmMessage["usage"];
}

/** Builds a fake AnthropicLike that replays `turns` in order. */
function fakeClient(
  turns: ScriptedTurn[],
  hooks?: {
    onCreate?: (callIndex: number, signal: AbortSignal) => void;
    deleteFile?: () => void;
  },
): AnthropicLike & { createCalls: number; deleted: string[] } {
  let i = 0;
  const deleted: string[] = [];
  const client = {
    createCalls: 0,
    deleted,
    async createMessage(
      _params: unknown,
      opts: { signal: AbortSignal },
    ): Promise<LlmMessage> {
      hooks?.onCreate?.(client.createCalls, opts.signal);
      client.createCalls += 1;
      if (opts.signal.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      const turn = turns[i++];
      if (!turn) throw new Error("fake client ran out of scripted turns");
      return {
        role: "assistant",
        content: turn.content,
        stop_reason: turn.stop_reason ?? null,
        stop_details: turn.stop_details ?? null,
        usage: turn.usage,
        container: { id: "container_fake" },
      };
    },
    async uploadSample() {
      return { id: "file_fake" };
    },
    async deleteFile(fileId: string) {
      hooks?.deleteFile?.();
      deleted.push(fileId);
    },
  };
  return client;
}

function makeEngine(client: AnthropicLike, relaxMonotonicity = false) {
  return new ClientOrchestratedEngine({
    apiKey: "sk-ant-test",
    createClient: () => client,
    relaxMonotonicity,
  });
}

function collectProgress() {
  const events: AgentProgress[] = [];
  return { events, onProgress: (m: AgentProgress) => events.push(m) };
}

// --- Tests ------------------------------------------------------------------

describe("applyAcceptanceGate", () => {
  it("passes a schema-valid, high-coverage, non-constant recipe", () => {
    const recipe = applyAcceptanceGate(GOOD_RECIPE_JSON, passingReport(), {});
    expect(recipe.recipeVersion).toBe(1);
  });

  it("fails on low coverage", () => {
    expect(() =>
      applyAcceptanceGate(
        GOOD_RECIPE_JSON,
        { ...passingReport(), coverage: 0.5 },
        {},
      ),
    ).toThrow(AcceptanceGateError);
  });

  it("fails on monotonic violations unless relaxed", () => {
    const report = {
      ...passingReport(),
      time_stats: { ...passingReport().time_stats!, monotonic_violations: 3n },
    };
    expect(() => applyAcceptanceGate(GOOD_RECIPE_JSON, report, {})).toThrow(
      AcceptanceGateError,
    );
    expect(
      applyAcceptanceGate(GOOD_RECIPE_JSON, report, {
        relaxMonotonicity: true,
      }).recipeVersion,
    ).toBe(1);
  });

  it("fails when every channel is constant", () => {
    const report = {
      ...passingReport(),
      per_channel: [
        {
          native_id: "v",
          count: 3000n,
          min: 1,
          max: 1,
          nan_count: 0n,
          constant: true,
        },
      ],
    };
    expect(() => applyAcceptanceGate(GOOD_RECIPE_JSON, report, {})).toThrow(
      AcceptanceGateError,
    );
  });

  it("fails on a schema-invalid recipe", () => {
    const bad = JSON.stringify({ recipeVersion: 2 });
    expect(() => applyAcceptanceGate(bad, passingReport(), {})).toThrow(
      AcceptanceGateError,
    );
  });
});

describe("reportToJsonSafe", () => {
  it("renders bigints as decimal strings (JSON-safe)", () => {
    const json = reportToJsonSafe(passingReport());
    const parsed = JSON.parse(json);
    expect(parsed.records_decoded).toBe("3000");
    expect(parsed.time_stats.median_delta_ns).toBe("10000");
    expect(parsed.coverage).toBe(1);
    // round-trips without throwing on bigint
    expect(typeof json).toBe("string");
  });
});

describe("ClientOrchestratedEngine.run", () => {
  it("drives bad → bad → good and returns the gated recipe", async () => {
    const client = fakeClient([
      // attempt 1 — bad
      {
        content: [
          textBlock("Trying 12-byte records…"),
          validateCall("t1", GOOD_RECIPE_JSON),
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      // attempt 2 — bad
      {
        content: [validateCall("t2", GOOD_RECIPE_JSON)],
        usage: { input_tokens: 80, output_tokens: 40 },
      },
      // attempt 3 — good
      {
        content: [validateCall("t3", GOOD_RECIPE_JSON)],
        usage: { input_tokens: 80, output_tokens: 40 },
      },
      // final turn: model ends without tools → gate the last (passing) recipe
      {
        content: [textBlock("Done — recipe verified.")],
        stop_reason: "end_turn",
      },
    ]);

    // First two validations fail, third passes.
    const reports = [badReport(0.4), badReport(0.95), passingReport()];
    let call = 0;
    const validateLocally = vi.fn(async () => reports[call++]);

    const { events, onProgress } = collectProgress();
    const result = await makeEngine(client).run({
      sample: fakeBundle(),
      validateLocally,
      onProgress,
      signal: new AbortController().signal,
    });

    expect(result.recipe.recipeVersion).toBe(1);
    expect(validateLocally).toHaveBeenCalledTimes(3);

    // Three validation verdicts, the third with the passing report.
    const verdicts = events.filter((e) => e.type === "validation-verdict");
    expect(verdicts).toHaveLength(3);

    // A terminal done event with the recipe.
    expect(events.some((e) => e.type === "done")).toBe(true);

    // The sample was deleted afterwards (best-effort cleanup).
    expect(client.deleted).toEqual(["file_fake"]);
  });

  it("accumulates the cost tally across turns", async () => {
    const client = fakeClient([
      {
        content: [validateCall("t1", GOOD_RECIPE_JSON)],
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
      {
        content: [textBlock("done")],
        stop_reason: "end_turn",
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    ]);
    const validateLocally = vi.fn(async () => passingReport());
    const { events, onProgress } = collectProgress();

    await makeEngine(client).run({
      sample: fakeBundle(),
      validateLocally,
      onProgress,
      signal: new AbortController().signal,
    });

    const costs = events.filter(
      (e): e is Extract<AgentProgress, { type: "cost" }> => e.type === "cost",
    );
    const last = costs[costs.length - 1];
    expect(last.tally.inputTokens).toBe(1500);
    expect(last.tally.outputTokens).toBe(300);
    // $5/MTok in + $25/MTok out
    expect(last.tally.estimatedUsd).toBeCloseTo(
      (1500 * 5 + 300 * 25) / 1_000_000,
      9,
    );
  });

  it("throws AcceptanceGateError when it never converges (coverage stays low)", async () => {
    // Model keeps validating with low-coverage reports, then ends its turn.
    const client = fakeClient([
      { content: [validateCall("t1", GOOD_RECIPE_JSON)] },
      {
        content: [textBlock("I think this is as good as it gets.")],
        stop_reason: "end_turn",
      },
    ]);
    const validateLocally = vi.fn(async () => badReport(0.5));
    const { onProgress } = collectProgress();

    await expect(
      makeEngine(client).run({
        sample: fakeBundle(),
        validateLocally,
        onProgress,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "acceptance-gate" });
    // even on failure the sample is cleaned up
    expect(client.deleted).toEqual(["file_fake"]);
  });

  it("surfaces report_unsupported as a typed AgentError", async () => {
    const client = fakeClient([
      {
        content: [
          toolUse("u1", "report_unsupported", {
            reason: "zstd-compressed chunks",
            findings: "magic 28 b5 2f fd at each chunk header",
            suggestedExport: "Export to MCAP from your vendor tool.",
          }),
        ],
      },
    ]);
    const validateLocally = vi.fn();
    const { events, onProgress } = collectProgress();

    await expect(
      makeEngine(client).run({
        sample: fakeBundle(),
        validateLocally,
        onProgress,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "unsupported" });

    expect(validateLocally).not.toHaveBeenCalled();
    const unsupported = events.find((e) => e.type === "unsupported");
    expect(unsupported).toMatchObject({ reason: "zstd-compressed chunks" });
  });

  it("surfaces a refusal stop_reason as a typed AgentError", async () => {
    const client = fakeClient([
      {
        content: [],
        stop_reason: "refusal",
        stop_details: { category: "cyber", explanation: "policy decline" },
      },
    ]);
    await expect(
      makeEngine(client).run({
        sample: fakeBundle(),
        validateLocally: vi.fn(),
        onProgress: () => {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "refusal" });
  });

  it("honors an AbortSignal raised mid-loop", async () => {
    const controller = new AbortController();
    // Abort right after the first createMessage call returns.
    const client = fakeClient(
      [
        { content: [validateCall("t1", GOOD_RECIPE_JSON)] },
        { content: [textBlock("more")], stop_reason: "end_turn" },
      ],
      {
        onCreate: (idx) => {
          if (idx === 1) controller.abort();
        },
      },
    );
    const validateLocally = vi.fn(async () => badReport());

    await expect(
      makeEngine(client).run({
        sample: fakeBundle(),
        validateLocally,
        onProgress: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("stops at the iteration cap (12) without converging", async () => {
    // 12 turns that each only run code_execution-style narration + a validate
    // call returning low coverage — never gated, never ends turn.
    const turns: ScriptedTurn[] = [];
    for (let i = 0; i < 12; i++) {
      turns.push({ content: [validateCall(`t${i}`, GOOD_RECIPE_JSON)] });
    }
    const client = fakeClient(turns);
    const validateLocally = vi.fn(async () => badReport(0.5));

    await expect(
      makeEngine(client).run({
        sample: fakeBundle(),
        validateLocally,
        onProgress: () => {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "iteration-cap" });
    expect(client.createCalls).toBe(12);
  });

  it("maps a 401 to a key-rejected error", async () => {
    const client: AnthropicLike = {
      async createMessage() {
        const e = new Error("unauthorized") as Error & { status: number };
        e.status = 401;
        throw e;
      },
      async uploadSample() {
        return { id: "file_fake" };
      },
      async deleteFile() {},
    };
    await expect(
      makeEngine(client).run({
        sample: fakeBundle(),
        validateLocally: vi.fn(),
        onProgress: () => {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "key-rejected" });
  });

  it("refuses a non-Anthropic base URL at construction", () => {
    expect(
      () =>
        new ClientOrchestratedEngine({
          apiKey: "sk",
          baseUrl: "https://evil.example.com",
          createClient: () => ({}) as AnthropicLike,
        }),
    ).toThrow(/non-Anthropic base URL/);
  });
});

// Sanity: AgentError is the base of AcceptanceGateError.
describe("error types", () => {
  it("AcceptanceGateError is an AgentError with kind acceptance-gate", () => {
    const e = new AcceptanceGateError("x", passingReport());
    expect(e).toBeInstanceOf(AgentError);
    expect(e.kind).toBe("acceptance-gate");
    expect(e.report).toBeDefined();
  });
});
