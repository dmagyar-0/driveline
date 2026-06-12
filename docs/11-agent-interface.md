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
methods, DEV-only, tree-shaken out of production. Agents need a *small*,
*stable*, *production-available* surface scoped to what an analysis
session actually does: discover channels, pull ranges, seek, look at the
video, and record findings as tagged events. `__drivelineAgent` is that
surface — nothing on it can ingest files, mutate layout, or touch
anything the user at the keyboard couldn't already do.

It installs when:

- the page URL carries `?agent` (any value), in any build, or
- the app runs in DEV (so e2e and local automation get it for free).

App unmount uninstalls it (mirrors the dev hooks).

## `window.__drivelineAgent` (v1)

Defined in `apps/web/src/agent/agentApi.ts` — the `AgentApi` interface
is the authoritative reference. Summary:

| Group | Methods |
| --- | --- |
| Session (read) | `getSessionSnapshot()`, `listSources()`, `listChannels()` |
| Data (read) | `fetchChannelRange(channelId, startNs, endNs, includePrev?)` |
| Transport | `setCursor(ns)`, `play()`, `pause()`, `setSpeed(x)` |
| Events | `getEventTagConfig()`, `listEvents()`, `addEvent(input?)`, `setEventTag(id, attrId, value)`, `setEventRange(id, beforeNs, afterNs)`, `renameEvent(id, label)`, `removeEvent(id)` |
| Events IO | `exportEvents()`, `importEvents(json, mode?)` |
| Video | `listVideoPanels()`, `captureVideoFrame(panelId?)` |

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
contract — they are what the agent API does *not* cover (file drop,
layout). Treat renaming them as a breaking change to automation, same
as a method change on `AgentApi`. Bump `AGENT_API_VERSION` on any
breaking change to the `window.__drivelineAgent` surface.
