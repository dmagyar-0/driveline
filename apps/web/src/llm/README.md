# `llm/` — Format Agent engine (Phase 2)

Pure-logic engine for the Format Agent (docs/12 §4). **No React, no UI** — the
dialog/consent/progress surface and the e2e live elsewhere (a later subagent).
This directory is the BYOK key manager, the file sampler, the prompts, the
client-orchestrated tool-use loop, and their unit tests.

## The lazy-chunk contract (READ THIS BEFORE IMPORTING)

This whole directory — **including `@anthropic-ai/sdk`** — must ship as a
**separate Vite chunk**, loaded only when the user clicks "Decode with Claude".
The first-load bundle (docs/07: <2.5 MB gzip) must stay untouched.

The rule that guarantees it:

> **Nothing anywhere in the app may import from `llm/` at module top level.**
> The UI layer reaches the engine through a dynamic `import("../llm/...")`
> inside the dialog's CTA handler. That dynamic import is the chunk boundary.

`@anthropic-ai/sdk` is itself reached **only** through a nested dynamic
`import("@anthropic-ai/sdk")` inside `engine.ts`'s `defaultCreateClient`, so even
loading the `llm/` chunk doesn't pull the SDK until a real run starts. Tests
inject a fake client via `createClient`, so they never touch the SDK or the
network.

If you add a new module here, keep it import-clean: a static
`import { … } from "../llm/…"` from any always-loaded module (App, store,
panels, workers) silently folds the SDK into the entry chunk and blows the size
budget. CI/build verification greps the dist chunk graph for this.

## What's here

| File            | Role                                                                                |
| --------------- | ----------------------------------------------------------------------------------- |
| `types.ts`      | `SampleBundle`, `AgentProgress`, `FormatAgentEngine`, typed errors.                 |
| `keyManager.ts` | BYOK key (memory by default, opt-in persistence) + base-URL guard.                  |
| `sampler.ts`    | `buildSampleBundle(file)` — head/tail/stratified slices via `File.slice()`, sha256. |
| `prompts.ts`    | Fixture-tested system prompt + kickoff builder.                                     |
| `engine.ts`     | `ClientOrchestratedEngine` — the tool-use loop, acceptance gate, cost tally.        |
| `index.ts`      | Barrel for the UI's dynamic import.                                                 |

## Engine shape

`ClientOrchestratedEngine` is constructed with `{ apiKey, model?, baseUrl?,
relaxMonotonicity?, createClient? }`. The injectable `createClient` factory
defaults to building the real SDK (`dangerouslyAllowBrowser: true`, base URL
guarded). The engine drives the loop against the small `AnthropicLike` adapter
interface, so the exact beta tool / Files-API / structured-output shapes live in
exactly one clearly-commented place (`defaultCreateClient`).

`engine.run({ sample, hint?, validateLocally, onProgress, signal })`:

- uploads the sample once (Files API), attaches it to the code-execution
  container, reuses the container across iterations;
- tools: server-side `code_execution`; client `validate_recipe` (calls the
  injected `validateLocally`, returns the dry-run report JSON-safe — bigints →
  decimal strings); client `report_unsupported`;
- bounds: max 12 iterations, honours `AbortSignal`, accumulates `usage` into a
  cost tally emitted via `onProgress`;
- checks `stop_reason: "refusal"` before reading content;
- **client-enforced acceptance gate** (does NOT trust the model): final recipe
  must schema-validate, dry-run `coverage ≥ 0.99`, `monotonic_violations == 0`
  (unless `relaxMonotonicity`), and have ≥ 1 non-constant channel;
- best-effort deletes the uploaded sample on completion AND abort.

`validateLocally` is injected by the UI layer (it adapts the store's
`dryRunRecipe` worker action). The engine never imports the store or worker.
