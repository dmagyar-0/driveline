# 13 — Bring Your Own Agent (BYOA): runtime skill & inline ingestion

Status: **implemented** · Owner: core · Depends on: 11-agent-interface, 06-ui-and-panels

## Summary

BYOA lets ANY external agent driving the live page — a computer-use model, a
JS console, a Playwright script — push its **own** data into a Driveline
session and visualise it, **in production, with no source-code access**. It
adds two things to the production `window.__drivelineAgent` surface (v3):

1. **A runtime-discoverable skill.** `getSkill()` returns a self-contained
   Markdown guide that takes an agent with only the running page end-to-end:
   what Driveline is, the timestamp rule, the data-source spec with a
   copy-pasteable worked example, and how to lay out panels and read data back.
   `describe()` returns a machine-readable manifest of every method.
2. **Inline data-source ingestion.** `addDataSource(spec)` accepts the agent's
   own channels as columnar JSON (no file bytes, no URL fetch) and registers
   them as a first-class source — they appear in the Channels rail, the
   scrubber widens to cover them, and they are fetchable and bindable exactly
   like a file-backed source.

## How it differs from the Format Agent (docs/12)

The **Format Agent (BYOK)** is about *unknown file formats*: a model reverse-
engineers a binary log's framing and emits a declarative **Ingest Recipe** that
a Rust reader decodes on the user's machine. It is server-assisted (BYOK), the
data is the user's file, and the output is a reusable recipe.

**BYOA** is the inverse: the agent already *has* the data (it computed it, or
pulled it from elsewhere) and just wants Driveline to plot it. There is no
file, no format to reverse-engineer, no Rust reader, and no recipe — the agent
hands over decoded columns and Driveline renders them. It is pure JS, runs
entirely in the browser, and needs no API key.

| | Format Agent (docs/12) | Bring Your Own Agent (this doc) |
| --- | --- | --- |
| Input | Bytes of an unknown file | Decoded columnar channels |
| Decoder | Rust reader + declarative recipe | None — data is already decoded |
| Where it runs | Sandbox + wasm reader | Main thread, in-memory |
| Output | A reusable Ingest Recipe | An in-session `inline` source |
| Who drives | BYOK LLM via the Format Agent UI | Any agent on `window.__drivelineAgent` |

## The inline source model

A new JS-only `SourceKind` `"inline"` (in `state/store.ts`; the Rust
`SourceKind` is untouched — inline sources never reach a reader). The whole
thing is main-thread:

- **Storage** (`state/inlineSource.ts`): a module-scoped map keyed by source id
  → native channel id → `{ tsNs: BigInt64Array, values: Float64Array |
  Int32Array }`. Timestamps cross the API as decimal strings (the BigInt rule)
  and are parsed to `bigint` / stored as `BigInt64Array` at the
  `addInlineSource` boundary.
- **Ranged Arrow IPC**: `fetchRange(sourceId, nativeId, startNs, endNs,
  includePrev)` builds an Arrow batch matching the EXACT scalar/enum schema
  `panels/seriesFromArrow.ts` (`decodeSeries`) validates — scalar `{ ts:
  Timestamp(ns, UTC) [BigInt64], value: Float64 }`, enum `{ ts, code: Int32 }`
  — using apache-arrow builders (`makeData`/`makeVector` + `new Table` +
  `tableToIPC`, stream format). It serves only samples in `[startNs, endNs)`,
  and with `includePrev` prepends the last sample with `ts < startNs`
  (step-hold), matching the worker readers so a cursor parked mid-gap draws the
  held value. A degenerate/inverted window clamps to empty.
- **Store wiring**: `addInlineSource(spec)` validates the spec, builds the
  `Channel[]` (qualified ids via `qualifiedChannelId`, kind/unit/dtype/
  sampleCount/per-channel `timeRange`), registers a `SourceMeta` with `kind:
  "inline"` and a synthetic handle (`-1`), and runs the same derived-state
  recompute (`commitOpenedSources`) a file open uses — so `globalRange` and the
  cursor reseat. `fetchChannelRange` gained an `inline` branch that serves from
  the module (no worker call) while honouring the per-source `timeOffsetNs`
  shift contract (`0n` default = pass-through). `clear()` and `removeSource()`
  drop the inline storage.

Validation returns `null` (never throws) on any violation: empty name or
channel list, mismatched/empty `timestampsNs`/`values` lengths, unparseable or
non-decreasing timestamps, duplicate channel names. This matches the rest of
the agent surface's probe-without-try/catch posture.

## The skill workflow

`getSkill()` returns `agent/agentSkill.ts`'s `AGENT_SKILL` constant — a
fixture-tested Markdown guide (snapshot-pinned like `llm/prompts.ts`). A
minimal session:

```js
const agent = window.__drivelineAgent; // append ?agent to the URL first
// 1. Push N samples of a sine "vehicle/speed" channel (ns as decimal strings).
const added = agent.addDataSource({
  name: "my-agent-run",
  channels: [{ name: "vehicle/speed", unit: "m/s", timestampsNs, values }],
});
// 2. Visualise it.
const panelId = agent.createPanel("plot");
agent.bindChannels(panelId, [added.channels[0].id]);
agent.setCursor(agent.getSessionSnapshot().globalRange.startNs);
```

The skill also documents the map case (`createPanel("map")` +
`setMapBinding`), reading data back (`listChannels` / `fetchChannelRange`), and
driving the transport (`setCursor` / `play` / `pause`).

## Always-on discovery vs. gated mutation

The discovery trio — `version`, `getSkill()`, `describe()` — installs on
**every** page load, even without `?agent`: it is pure documentation +
introspection, with no mutation and no session-data read. `describe()` reports
`agentParamRequired: true` so an agent knows to reload with `?agent` appended.
Every mutating / data-reading op (`addDataSource`, `fetchChannelRange`, the
v1/v2 read/transport/event/video/layout surface) installs only under `?agent`
(or in DEV). A one-line console banner on every load points agents at
`getSkill()` and notes that `?agent` unlocks the full surface.

## Privacy

`addDataSource` holds the agent's samples in memory and serves them as ranged
Arrow batches to the panels. Nothing is uploaded, written to disk, or sent to a
server — it stays in the browser tab, like every other Driveline source.
