# 11 · Agent interface

Driveline sessions can be driven by automation — LLM agents, analysis
scripts, CI jobs — through three surfaces that share one contract:

1. **`window.__drivelineAgent`** — a JSON-safe browser API for analysis
   and tagging, available in production behind a `?agent` opt-in.
2. **Event JSON import / export** — a portable file format for the
   event list (bookmarks + tags), usable from the Events drawer or the
   agent API.
3. **`driveline-data`** — a native CLI over `data-core`'s readers, for
   signal queries without a browser.

The shared contract rule: **every nanosecond timestamp crosses a
serialisation boundary as a decimal string.** ns values exceed 2^53, so
JSON numbers and `page.evaluate` cannot carry them losslessly (the same
project-wide BigInt rule the UI follows).

## Why a separate surface from the dev hooks

`window.__drivelineDevHooks` is the Playwright seam: ~60 store-mutating
methods, DEV-only, tree-shaken out of production. Agents need a _small_,
_stable_, _production-available_ surface scoped to what an analysis
session actually does: discover channels, pull ranges, seek, look at the
video, and record findings as tagged events. `__drivelineAgent` is that
surface — nothing on it can ingest files, mutate layout, or touch
anything the user at the keyboard couldn't already do.

It installs in two tiers (see docs/13 for the BYOA rationale):

- **Always on (any build, no opt-in):** the read-only discovery trio
  `version`, `getSkill()`, `describe()` — pure documentation + a capability
  manifest, no mutation and no session-data read.
- **Gated:** the full mutating / data-reading surface (the v1/v2 ops plus
  v3's `addDataSource`) installs only when the page URL carries `?agent`
  (any value), or the app runs in DEV (so e2e and local automation get it
  for free).

Every load prints a one-line console banner pointing agents at `getSkill()`
and noting that `?agent` unlocks the full surface. App unmount uninstalls the
whole thing (mirrors the dev hooks).

## `window.__drivelineAgent` (v3)

Defined in `apps/web/src/agent/agentApi.ts` — the `AgentApi` interface
is the authoritative reference. The `version` field reports `3`; v3 is a
superset of v2 (itself a superset of v1) and adds the always-on discovery
trio (`getSkill`/`describe`) plus inline data-source ingestion
(`addDataSource`, the "Bring Your Own Agent" surface — see
docs/13-bring-your-own-agent.md). Summary:

| Group              | Methods                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery (always on, v3) | `getSkill()`, `describe()`                                                                                                                                                |
| Ingestion (v3)     | `addDataSource(spec)` — register an inline columnar source                                                                                                                       |
| Session (read)     | `getSessionSnapshot()`, `listSources()`, `listChannels()`                                                                                                                        |
| Data (read)        | `fetchChannelRange(channelId, startNs, endNs, includePrev?)`                                                                                                                     |
| Transport          | `setCursor(ns)`, `play()`, `pause()`, `setSpeed(x)`                                                                                                                              |
| Events             | `getEventTagConfig()`, `listEvents()`, `addEvent(input?)`, `setEventTag(id, attrId, value)`, `setEventRange(id, beforeNs, afterNs)`, `renameEvent(id, label)`, `removeEvent(id)` |
| Events IO          | `exportEvents()`, `importEvents(json, mode?)`                                                                                                                                    |
| Video              | `listVideoPanels()`, `captureVideoFrame(panelId?)`                                                                                                                               |
| Layout (write, v2) | `createPanel(kind)`, `bindChannels(panelId, channelIds)`, `setMapBinding(panelId, latId, lonId)`, `closePanel(panelId)`                                                          |

Behavioural notes:

- `fetchChannelRange` resolves the Arrow batch into
  `{ rows, columns: [{ name, values }] }`. 64-bit integer / timestamp
  columns arrive as decimal strings (read from the BigInt64 backing
  buffer — `.get(i)` on a Timestamp column drops sub-ms precision, see
  `seriesFromArrow.ts`); float columns arrive as numbers. Unknown
  channel ids and unparseable ns bounds resolve `null` rather than
  throwing, so agents can probe without try/catch scaffolding.
- `addEvent` defaults `ns` to the current cursor and always stamps
  `origin: "agent"`; an optional `confidence` in `[0, 1]` (clamped) is
  stored on the event and surfaced in the Events drawer as an
  `agent NN%` badge, so reviewers can tell machine findings from human
  ones.
- `captureVideoFrame` returns a PNG data URL of the decoded frame
  currently blitted to a video panel's canvas (pixels only, no UI
  chrome) — pair with `setCursor` + a readiness wait to grab the frame
  at a moment of interest for VLM classification.
- The transport methods go through the store's normal actions, so the
  cursor hot-path rules (rAF coalescing, decode-aware gating) apply
  unchanged.

### v2 layout write ops

v1 was analysis-and-annotation only — layout mutation lived on the
DEV-only dev-hook surface. v2 lifts the _minimum_ layout surface the
Format Agent's visualisation bootstrap needs (docs/12 §7: the
`LayoutProposal` applier) onto the production agent API, so the same code
path serves external agents and Playwright. The applier
(`apps/web/src/llm/applyLayoutProposal.ts`) places a proposal's panels by
calling exactly these v2 ops (`createPanel` → `bindChannels` /
`setMapBinding`) — it has no parallel panel-creation path. These are thin wrappers over
the existing FlexLayout workspace and the store's binding actions — exactly
what the Layout drawer does when a human clicks "add a panel" and binds
channels — not a new layout engine.

The four methods reach the live FlexLayout `Model` through a module-scoped
**workspace bridge** (`apps/web/src/layout/workspaceBridge.ts`): the
`Workspace` component registers its panel-mint / panel-close / reset handle
on mount and clears it on unmount, mirroring `videoCanvasRegistry.ts`. No
React Context is involved (the project bans adding one), and the dev hooks
mint/close panels through the same `Workspace` handle, so panel creation
lives in one place.

| Method                                 | Returns             | Semantics                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPanel(kind)`                    | `panelId` or `null` | `kind` is a `PanelKind` (`plot` / `map` / `enum` / `table` / `value` / `video` / `scene`). Mints a tab and returns its freshly-minted id. `null` when the kind is unknown/unsupported, or when the workspace has not mounted yet. |
| `bindChannels(panelId, channelIds)`    | `boolean`           | Appends scalar channels to a `plot` / `enum` / `table` / `value` panel via the matching store action.                                                                                                                             |
| `setMapBinding(panelId, latId, lonId)` | `boolean`           | Sets a `map` panel's lat/lon pair.                                                                                                                                                                                                |
| `closePanel(panelId)`                  | `boolean`           | Deletes the tab via FlexLayout `Actions.deleteTab`. `true` if the tab existed, else `false`.                                                                                                                                      |

Validation & caps (mechanically enforced, never trusted from the caller —
the Format Agent's proposal is model-authored, see docs/12 §6):

- **Channel existence.** Every channel id passed to `bindChannels` /
  `setMapBinding` must name a loaded channel. If _any_ id is unknown the
  whole call is rejected (`false`) and nothing is bound — a partial bind
  would silently drop a proposal's intent.
- **Panel existence + kind.** The `panelId` must name a live tab in the
  layout and be of a kind the call supports. `bindChannels` only accepts
  the four list-binding kinds; `map` (use `setMapBinding`) and
  `video`/`scene` (single-channel store actions) return `false`.
- **Per-panel cap.** `bindChannels` enforces `MAX_PLOT_SERIES` against the
  panel's _current_ bindings: a request that would push the total over the
  cap is rejected whole (`false`), binding nothing. Re-binding an
  already-bound channel is a no-op and is not counted against the cap, so
  an idempotent re-apply of the same proposal succeeds. (docs/12 §7 quotes
  the cap as 8; the live constant in `panels/palette.ts` is the source of
  truth — the API reads it, it doesn't hard-code a number.)
- **Null/false-safe.** Like the rest of the surface, these never throw for
  "not found"; an agent can probe with plain return-value checks.

Because every write goes through the same store actions and FlexLayout
model the UI uses, a panel an agent creates is indistinguishable from one a
user dragged in — it persists, reloads, and re-binds identically.

**Scene geometry channels.** The `scene` panel renders four 3D geometry
kinds — `point_cloud`, `bounding_box`, `trajectory`, and `map_geometry` (road
networks). These bind one-at-a-time through the single-channel scene action
(`setSceneChannelBinding` on the dev hooks, or the PanelDrawer), **not**
`bindChannels`. Geometry sources load through the file-open path (`openFiles` /
drag-drop), not `addDataSource`. A `map_geometry` source comes from an
OpenDRIVE `.xodr` (routed by extension) or a simple `drivelineMap` JSON
(content-sniffed for a top-level `"drivelineMap"` key, like OpenLABEL and
trajectory). Map geometry is **static** — a single frame at ts=0 — so it
renders on bind without scrubbing the cursor. The `drivelineMap` shape:

```json
{ "drivelineMap": { "version": 1, "name": "intersection", "features": [
  { "type": "lane_boundary", "polyline": [[0,0,0],[10,0,0]] },
  { "type": "road_edge", "polyline": [[0,-2],[10,-2]] }
] } }
```

Feature `type` is one of `lane_boundary` / `road_edge` / `centerline` /
`crosswalk` / `stop_line` / `driving` / `other` (optional/unknown → `other`),
each rendered in a distinct colour.

A minimal Playwright session against the deployed app:

```ts
await page.goto("https://driveline.pages.dev/?demo&agent");
// … wait for the session to load …
await page.evaluate(async () => {
  const agent = window.__drivelineAgent!;
  const speed = agent.listChannels().find((c) => c.name === "/vehicle/speed")!;
  const r = agent.getSessionSnapshot().globalRange!;
  const data = await agent.fetchChannelRange(speed.id, r.startNs, r.endNs);
  // …detect an event, then record it:
  agent.setCursor("1532671467005757531");
  agent.addEvent({
    label: "Overtake: pass slower vehicle in right lane",
    tags: { maneuver: "Overtake", lighting: "Night", road_type: "Highway" },
    confidence: 0.9,
  });
  return agent.exportEvents();
});
```

### v3 additions: discovery + inline ingestion

v3 lifts two capabilities onto the surface for the "Bring Your Own Agent"
flow (docs/13). The mutating split changed: the discovery trio installs on
every load, the rest stays gated.

| Method                       | Availability      | Returns                                              | Semantics                                                                                                                       |
| ---------------------------- | ----------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `getSkill()`                 | always (no opt-in)| `string`                                            | The full BYOA guide as Markdown (what Driveline is, the timestamp rule, the `AgentDataSourceSpec` shape + worked example).      |
| `describe()`                 | always (no opt-in)| `{ version, capabilities[], agentParamRequired }`   | Machine-readable manifest of every method (name, summary, `mutating`). `agentParamRequired: true` when the gated ops are off.  |
| `addDataSource(spec)`        | gated (`?agent`)  | `{ sourceId, channels: [{ id, name }] } \| null`    | Register the agent's own inline columnar data source (no file bytes, no URL). `null` on any validation failure; never throws.   |

`addDataSource` takes an `AgentDataSourceSpec`: a source `name` plus
`channels[]`, each with a `name` (slashes build the Channels tree), optional
`unit`, optional `kind` (`"scalar"` default / `"enum"`), a `timestampsNs`
decimal-string array (non-decreasing, length N), and a `values` number array
(length N; enum → integer codes). The data is held on the main thread and
ranged-fetched as Arrow IPC matching the exact scalar/enum schema
`seriesFromArrow.ts` expects, so an inline source is indistinguishable to the
panels from a reader-backed one. See docs/13 for the inline-source model and
how BYOA differs from the BYOK Format Agent (docs/12).

## Event JSON format

`exportEvents()` / the drawer's **Export** button write the same
schema-versioned shape the `localStorage` adapter persists
(`{ version: 2, bookmarks: [...] }`), so an exported file imports
losslessly and a raw storage payload is itself importable.

Import (`importEvents()` / the drawer's **Import** button) is lenient —
per entry only `ns` is required; `id`, `label`, `beforeNs`/`afterNs`,
`tags`, `color`, `createdAt`, `origin`, `confidence` all default. A
bare array of `{ ns, label?, tags? }` objects is accepted, so an agent
can hand-write findings without replicating the full schema:

```json
[
  {
    "ns": "1532671467005757531",
    "label": "cut-in from right lane",
    "beforeNs": "2000000000",
    "afterNs": "3000000000",
    "tags": { "maneuver": "Lane change", "weather": "Clear" },
    "origin": "agent",
    "confidence": 0.85
  }
]
```

The drawer's Import always **merges by id** (collisions update in
place, so re-importing a reviewed file is idempotent); the agent API
can also `importEvents(json, "replace")`. A malformed entry fails the
whole file — a partial import would silently drop findings.

Provenance fields (`origin`, `confidence`) are optional on disk and in
imports; absent fields hydrate to `"user"` / `null`, so every
pre-existing payload keeps loading and older builds ignore the keys.

## `driveline-data` CLI

`crates/data-cli` wraps the exact readers the WASM build uses
(`McapReader`, `Mf4Reader`, `Ros1BagReader`, `Ros2Db3Reader`) in a
native binary, so agents with shell access can query signals at native
speed without booting a browser:

```sh
cargo run -p data-cli --release -- info drive.mcap
cargo run -p data-cli --release -- fetch drive.mcap /vehicle/speed \
    --start 1532671437000000000 --end 1532671497000000000
cargo run -p data-cli --release -- fetch drive.mf4 WheelSpeedFL --json
```

`info` prints source metadata + the channel list as JSON. `fetch`
prints one channel over `[--start, --end)` (default: the channel's full
range) as CSV, or as `{ rows, columns }` JSON with `--json` — the same
shape as `fetchChannelRange` in the browser, including
timestamps-as-strings. The crate is native-only (not a workspace member
of the WASM build) and adds nothing to the web bundle.

## Stability

`data-testid` attributes and ARIA roles/labels in the shell (scrubber,
transport buttons, Events drawer) double as the DOM-level automation
contract — they are what the agent API does _not_ cover (file drop, and
layout operations beyond the v2 create/bind/close ops, e.g. drag-rearrange
and saved layouts). Treat renaming them as a breaking change to automation,
same as a method change on `AgentApi`. Bump `AGENT_API_VERSION` on any
breaking change to the `window.__drivelineAgent` surface (it was raised to
`2` when the layout write ops landed, and to `3` for the always-on
discovery trio + inline `addDataSource` ingestion — see docs/13).
