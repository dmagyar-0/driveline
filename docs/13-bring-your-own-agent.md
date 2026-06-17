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

The **Format Agent (BYOK)** is about _unknown file formats_: a model reverse-
engineers a binary log's framing and emits a declarative **Ingest Recipe** that
a Rust reader decodes on the user's machine. It is server-assisted (BYOK), the
data is the user's file, and the output is a reusable recipe.

**BYOA** is the inverse: the agent already _has_ the data (it computed it, or
pulled it from elsewhere) and just wants Driveline to plot it. There is no
file, no format to reverse-engineer, no Rust reader, and no recipe — the agent
hands over decoded columns and Driveline renders them. It is pure JS, runs
entirely in the browser, and needs no API key.

|               | Format Agent (docs/12)           | Bring Your Own Agent (this doc)        |
| ------------- | -------------------------------- | -------------------------------------- |
| Input         | Bytes of an unknown file         | Decoded columnar channels              |
| Decoder       | Rust reader + declarative recipe | None — data is already decoded         |
| Where it runs | Sandbox + wasm reader            | Main thread, in-memory                 |
| Output        | A reusable Ingest Recipe         | An in-session `inline` source          |
| Who drives    | BYOK LLM via the Format Agent UI | Any agent on `window.__drivelineAgent` |

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

### Reading a moment without playing it (v5)

An agent does not have to drive the transport — or open any panel — to inspect
a frame. `captureVideoFrameAt(channelId, ns)` decodes the camera frame nearest
`ns` on a throwaway decoder in a dedicated capture worker and returns it as a
PNG `data:` URL; `snapshotAt(ns)` bundles a whole instant
(`{ tsNs, cameras[], pointClouds[], scalars[], channels[] }`) in one call. Both
run off the live playback path: no cursor move, no panel required, and a human
watching at 1× is undisturbed. This is the intended path for autonomous,
headless analysis (e.g. seek-free VLM classification at chosen timestamps) and
for an agent working alongside a human who is scrubbing the same session. Raw
LiDAR points stay out of the snapshot bundle — fetch them per spin with
`fetchChannelRange(channelId, spinTsNs, spinTsNs+1)` using the `spinTsNs` the
bundle reports.

### 3D scene geometry, including road maps

The `scene` panel renders 3D geometry channels — `point_cloud` (LiDAR),
`bounding_box` (OpenLABEL boxes), `trajectory` (predicted ego paths), and
`map_geometry` (road networks). These bind one-at-a-time via
`setSceneBinding(panelId, channelId)` (added in agent API v4;
`setSceneChannelBinding` on the dev hooks, or the PanelDrawer in the UI),
**not** `bindChannels` (which targets the plot/enum/table/value list kinds). An
agent loads geometry through the file-open path (`openFiles` / drag-drop on
`[data-testid="drop-zone"]`) rather than `addDataSource` (which is scalar/enum
only) — e.g. a raw **NVIDIA Alpamayo** LiDAR `.parquet`, Draco-decoded
in-browser (no conversion) into a `point_cloud` channel. The full display flow
is then `createPanel("scene")` → `setSceneBinding(panel, cloudChannelId)`.

**Road maps (`map_geometry`).** Two input shapes load straight into a scene
panel: an OpenDRIVE `.xodr` (routed by extension) and a simple `drivelineMap`
JSON, content-sniffed for a top-level `"drivelineMap"` key:

```json
{
  "drivelineMap": {
    "version": 1,
    "name": "intersection",
    "features": [
      {
        "id": "b0",
        "type": "lane_boundary",
        "polyline": [
          [0, 0, 0],
          [10, 0, 0]
        ]
      },
      {
        "type": "road_edge",
        "polyline": [
          [0, -2],
          [10, -2]
        ]
      }
    ]
  }
}
```

`polyline` is an array of `[x,y]` or `[x,y,z]` (z optional → 0; ≥2 points or
the feature is skipped). `type` is one of `lane_boundary`, `road_edge`,
`centerline`, `crosswalk`, `stop_line`, `driving`, `other` (optional/unknown →
`other`); each maps to a distinct vertex colour. Map geometry is **static** (a
single frame at ts=0), so binding it to a scene panel renders the network
immediately — no cursor scrubbing. The native `driveline-data` CLI opens the
same `.xodr`/`drivelineMap` inputs over the shared reader for shell-only flows.

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

## Demo screencast

There is a recorded walkthrough of this whole loop for sharing — the clip we
hand to people trying Driveline as an open-source tool. It is produced by
`apps/e2e/tests/_demo-byoa-agent.spec.ts` (driven through the production
`window.__drivelineAgent` surface) and stitched by `scripts/record-byoa-demo.sh`
into `demo/byoa-demo.webm`:

- **Scene 1 — pure BYOA.** Everything runs through the agent surface: discover
  the API, `addDataSource` an inline drive (speed + longitudinal accel + gear),
  bind it to a plot and an enum strip, `fetchChannelRange` it back, scan for the
  hardest braking / strongest relaunch, and `addEvent` agent-authored findings
  (each gets an "agent NN%" confidence badge + tag chips). No fixtures — runs
  anywhere.
- **Scene 2 — BYOA on a real dashcam.** Loads the comma2k19 segment-10 dashcam
  - CAN signals, then the agent reads the real `/vehicle/speed` channel, finds
    the steepest deceleration, tags it, and jumps the dashcam to that frame.

```bash
scripts/record-byoa-demo.sh                # both scenes (fetches comma2k19)
scripts/record-byoa-demo.sh --scene1-only  # no dataset download
```

Scene 2 self-skips when the comma2k19 fixtures are absent, so scene 1 always
records. See `sample-data/realworld/README.md` for the fixture pipeline. The
stitched `.webm` is a generated artefact (git-ignored, like the WASM bundle) —
regenerate it locally rather than committing it.

### Live agent-driven recording

The spec above is deterministic. To capture a **real agent driving the surface
live** — making decisions from data it actually reads back, with its calls and
reasoning shown on-screen — `scripts/agent-drive/live-driver.mjs` keeps one
screen-recorded browser alive and executes commands handed to it turn-by-turn
over a tiny file/FIFO protocol:

- **Results FIFO** (`$AGENT_Q/results`): the driver writes `READY` once the
  browser has booted and the HUD is installed, then one JSON line per command.
  The caller `cat`s it to stay in lockstep — no polling.
- **Commands**: the caller atomically `mv`s a file to `$AGENT_Q/cmd-<n>.js`
  whose contents are a JS expression (sync or promise-returning) evaluated in
  the page against `window.__drivelineAgent`. `__QUIT__` closes the context
  (flushing the `.webm`) and exits.

The driver can be any agent; Claude Code itself can drive it (no API key needed
— it is already a live model in the loop). An on-screen "agent HUD" logs every
call + decision via `window.__agentLog(...)`, so the recording is
self-evidently agent-driven rather than a hand-clicked walk.

**Reproduce the committed live clip with one command:**

```bash
scripts/agent-drive/record-byoa-live.sh   # -> demo/byoa-agent-live.webm
```

It starts the dev server (if needed), launches the recorded browser, replays
the exact call sequence the agent issued when the clip was recorded — discover
→ load the comma2k19 dashcam + CAN → bind → `fetchChannelRange` + profile the
real data → tag the honest findings (no hard braking; it is a steady ~31 m/s
cruise, with one notable maneuver, the −11.7° steering peak at 28.3 s) → jump
the dashcam there and play — then compacts the recording to VP9. Because the
replay runs back-to-back there is no dead air; the only pauses are deliberate
in-page dwells.

When an agent drives the harness _interactively_ (one command per turn), its
between-turn thinking shows up as dead air. Trim that case with ffmpeg's
`mpdecimate`, which drops near-duplicate frames:

```bash
ffmpeg -i raw.webm -vf "mpdecimate=hi=64*16:lo=64*6:frac=0.30,setpts=N/FRAME_RATE/TB" \
  -c:v libvpx-vp9 -b:v 2M -an tight.webm
```
