/**
 * Live smoke for the Format Agent (docs/12 §11). OPT-IN — requires a real
 * `ANTHROPIC_API_KEY`; exits 0 with a skip notice when absent, so it never
 * blocks CI (it is not wired into CI at all). It runs the REAL
 * `ClientOrchestratedEngine` end to end against api.anthropic.com:
 *
 *   1. Builds a `SampleBundle` from the committed synthetic alien fixture
 *      `sample-data/sample.acme` with the production sampler.
 *   2. Runs the real engine — Files-API upload, code-execution loop, structured
 *      output — with a local `validateLocally` that decodes the FULL fixture
 *      (a self-contained `fixed_record` dry-run mirroring `crates/data-core`,
 *      since the WASM `recipe_dry_run` is browser-only).
 *   3. Asserts the client-enforced acceptance gate passed (the engine only
 *      resolves on a gated recipe) and that the produced recipe decodes the
 *      fixture cleanly (coverage ≥ 0.99, zero rejects, ≥ 1 non-constant
 *      channel).
 *
 * Run it via the lazy `llm/` source through Vite's resolver:
 *   pnpm format-agent:smoke           (npm alias; see root package.json)
 *   ANTHROPIC_API_KEY=sk-ant-… pnpm format-agent:smoke
 *
 * It deliberately imports the SAME modules the app ships, so a real run
 * exercises the exact engine/sampler/gate the dialog uses.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildSampleBundle } from "../apps/web/src/llm/sampler.ts";
import { ClientOrchestratedEngine } from "../apps/web/src/llm/engine.ts";
import type { AgentProgress } from "../apps/web/src/llm/types.ts";
import type {
  Recipe,
  RawRecipeDryRunReport,
} from "../apps/web/src/state/recipe.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "../sample-data/sample.acme");

const MIN_COVERAGE = 0.99;

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      "[format-agent-smoke] SKIP — set ANTHROPIC_API_KEY to run the live smoke.",
    );
    process.exit(0);
  }

  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const file = new File([bytes], "sample.acme");
  console.log(
    `[format-agent-smoke] fixture ${FIXTURE} (${bytes.length} bytes)`,
  );

  const sample = await buildSampleBundle(file);
  console.log(
    `[format-agent-smoke] sample: ${sample.manifest.totalSampledBytes} bytes across ${sample.manifest.slices.length} slice(s)`,
  );

  // Local validation: decode the FULL fixture for every candidate recipe.
  const validateLocally = (
    recipeJson: string,
  ): Promise<RawRecipeDryRunReport> =>
    Promise.resolve(dryRunFixedRecord(bytes, JSON.parse(recipeJson) as Recipe));

  const engine = new ClientOrchestratedEngine({ apiKey });
  const controller = new AbortController();

  console.log("[format-agent-smoke] running the real engine…");
  const { recipe, transcriptSummary } = await engine.run({
    sample,
    hint: "Synthetic ACME vehicle telemetry: fixed-size little-endian records at 100 Hz.",
    validateLocally,
    onProgress: (msg: AgentProgress) => logProgress(msg),
    signal: controller.signal,
  });

  console.log(`[format-agent-smoke] transcript: ${transcriptSummary}`);

  // The engine only resolves on a gated recipe; re-assert here for the smoke.
  const report = dryRunFixedRecord(bytes, recipe);
  assert(
    report.coverage >= MIN_COVERAGE,
    `coverage ${report.coverage} < ${MIN_COVERAGE}`,
  );
  assert(Number(report.records_rejected) === 0, "records were rejected");
  assert(Number(report.records_decoded) > 0, "no records decoded");
  assert(
    report.per_channel.some((c) => !c.constant),
    "every channel is constant",
  );
  const violations = report.time_stats
    ? Number(report.time_stats.monotonic_violations)
    : 0;
  assert(violations === 0, `${violations} monotonic violations`);

  console.log(
    `[format-agent-smoke] PASS — ${Number(report.records_decoded)} records, ` +
      `coverage ${(report.coverage * 100).toFixed(2)}%, ` +
      `${report.per_channel.length} channels.`,
  );
}

function logProgress(msg: AgentProgress): void {
  switch (msg.type) {
    case "thinking":
      console.log(`  · thinking: ${truncate(msg.text)}`);
      break;
    case "sandbox-action":
      console.log(`  · ${msg.text}`);
      break;
    case "validation-verdict":
      console.log(
        `  · attempt ${msg.attempt}: coverage ${(msg.report.coverage * 100).toFixed(1)}%, ` +
          `${Number(msg.report.records_rejected)} rejected`,
      );
      break;
    case "cost":
      console.log(
        `  · cost: ${msg.tally.inputTokens}+${msg.tally.outputTokens} tok, est $${msg.tally.estimatedUsd.toFixed(2)}`,
      );
      break;
    case "unsupported":
      console.log(`  · unsupported: ${msg.reason}`);
      break;
    default:
      break;
  }
}

function truncate(s: string, n = 100): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// --- Self-contained `fixed_record` dry-run -----------------------------------
//
// Mirrors `crates/data-core/src/recipe.rs::dry_run` for the `fixed_record`
// container (the only v1 container) closely enough to drive the acceptance
// gate: timestamp conversion in the integer domain, per-field f64 decode with
// scale/offset, coverage = consumed/total, monotonic-violation count, and a
// per-channel min/max/constant summary. The browser path uses the audited WASM
// reader; this is the native-smoke equivalent.

const UNIT_SCALE_NS: Record<string, bigint> = {
  nanos: 1n,
  micros: 1_000n,
  millis: 1_000_000n,
  seconds: 1_000_000_000n,
};

const DTYPE_SIZE: Record<string, number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  f32: 4,
  f64: 8,
};

function isInteger(dtype: string): boolean {
  return dtype !== "f32" && dtype !== "f64";
}

function readI64(
  view: DataView,
  base: number,
  offset: number,
  dtype: string,
  le: boolean,
): bigint | null {
  const size = DTYPE_SIZE[dtype];
  if (offset + size > view.byteLength - base) return null;
  const at = base + offset;
  switch (dtype) {
    case "u8":
      return BigInt(view.getUint8(at));
    case "i8":
      return BigInt(view.getInt8(at));
    case "u16":
      return BigInt(view.getUint16(at, le));
    case "i16":
      return BigInt(view.getInt16(at, le));
    case "u32":
      return BigInt(view.getUint32(at, le));
    case "i32":
      return BigInt(view.getInt32(at, le));
    case "u64":
      return view.getBigUint64(at, le);
    case "i64":
      return view.getBigInt64(at, le);
    default:
      return null;
  }
}

function readF64(
  view: DataView,
  base: number,
  offset: number,
  dtype: string,
  le: boolean,
  scale: number,
  valueOffset: number,
): number | null {
  const size = DTYPE_SIZE[dtype];
  if (offset + size > view.byteLength - base) return null;
  const at = base + offset;
  let raw: number;
  switch (dtype) {
    case "u8":
      raw = view.getUint8(at);
      break;
    case "i8":
      raw = view.getInt8(at);
      break;
    case "u16":
      raw = view.getUint16(at, le);
      break;
    case "i16":
      raw = view.getInt16(at, le);
      break;
    case "u32":
      raw = view.getUint32(at, le);
      break;
    case "i32":
      raw = view.getInt32(at, le);
      break;
    case "u64":
      raw = Number(view.getBigUint64(at, le));
      break;
    case "i64":
      raw = Number(view.getBigInt64(at, le));
      break;
    case "f32":
      raw = view.getFloat32(at, le);
      break;
    case "f64":
      raw = view.getFloat64(at, le);
      break;
    default:
      return null;
  }
  return raw * scale + valueOffset;
}

function dryRunFixedRecord(
  bytes: Uint8Array,
  recipe: Recipe,
): RawRecipeDryRunReport {
  if (recipe.container.type !== "fixed_record") {
    throw new Error(
      `smoke dry-run only supports fixed_record (got ${recipe.container.type})`,
    );
  }
  const headerSkip = recipe.container.headerSkipBytes ?? 0;
  const recordSize = recipe.container.recordSizeBytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const fieldByName = new Map(recipe.fields.map((f) => [f.name, f]));
  const timeField = fieldByName.get(recipe.time.field);
  if (!timeField) throw new Error(`time field ${recipe.time.field} not found`);
  const timeScale = UNIT_SCALE_NS[recipe.time.unit] ?? 1n;
  const epochOffset = BigInt(recipe.time.epochOffsetNs ?? "0");
  const timeIsInt = isInteger(timeField.dtype);

  const channelCols = recipe.channels.map((ch) => {
    const f = fieldByName.get(ch.fields[0]);
    if (!f)
      throw new Error(`channel ${ch.nativeId} field ${ch.fields[0]} missing`);
    return { nativeId: ch.nativeId, field: f, values: [] as number[] };
  });

  const tsList: bigint[] = [];
  let rejected = 0;
  let firstError: RawRecipeDryRunReport["first_error"] = null;
  let consumed = 0;

  let pos = headerSkip;
  while (pos + recordSize <= bytes.length) {
    let ts: bigint | null;
    if (timeIsInt) {
      const raw = readI64(
        view,
        pos,
        timeField.offset,
        timeField.dtype,
        timeField.endian !== "be",
      );
      ts = raw === null ? null : raw * timeScale + epochOffset;
    } else {
      const raw = readF64(
        view,
        pos,
        timeField.offset,
        timeField.dtype,
        timeField.endian !== "be",
        1,
        0,
      );
      ts =
        raw === null
          ? null
          : BigInt(Math.round(raw * Number(timeScale))) + epochOffset;
    }
    if (ts === null) {
      rejected += 1;
      if (!firstError) {
        firstError = {
          byte_offset: BigInt(pos),
          reason: "time field out of bounds",
        };
      }
      pos += recordSize;
      continue;
    }
    tsList.push(ts);
    for (const col of channelCols) {
      const v = readF64(
        view,
        pos,
        col.field.offset,
        col.field.dtype,
        col.field.endian !== "be",
        col.field.scale ?? 1,
        col.field.valueOffset ?? 0,
      );
      col.values.push(v ?? NaN);
    }
    consumed += recordSize;
    pos += recordSize;
  }

  // Monotonic-violation count over the decode order (records are emitted in
  // file order; the WASM reader sorts, but the violation count is computed on
  // the as-read sequence).
  let violations = 0;
  let start = 0n;
  let end = 0n;
  if (tsList.length > 0) {
    start = tsList[0];
    end = tsList[tsList.length - 1];
    for (let i = 1; i < tsList.length; i++) {
      if (tsList[i] < tsList[i - 1]) violations += 1;
    }
  }

  const perChannel = channelCols.map((col) => {
    let min = Infinity;
    let max = -Infinity;
    let nan = 0;
    for (const v of col.values) {
      if (Number.isNaN(v)) {
        nan += 1;
        continue;
      }
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 0;
    return {
      native_id: col.nativeId,
      count: BigInt(col.values.length),
      min,
      max,
      nan_count: BigInt(nan),
      constant: Math.abs(max - min) < Number.EPSILON,
    };
  });

  const total = bytes.length;
  const coverage = total > 0 ? (headerSkip + consumed) / total : 0;

  return {
    records_decoded: BigInt(tsList.length),
    records_rejected: BigInt(rejected),
    first_error: firstError,
    time_stats: {
      start_ns: start,
      end_ns: end,
      monotonic_violations: BigInt(violations),
      median_delta_ns: 0n,
    },
    per_channel: perChannel,
    coverage,
  };
}

main().catch((err) => {
  console.error("[format-agent-smoke] FAIL:", err);
  process.exit(1);
});
