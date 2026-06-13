// The "Bring Your Own Agent" (BYOA) skill — a self-contained guide returned by
// `window.__drivelineAgent.getSkill()`. It lets an external agent that has ONLY
// the running page (no repository, no docs) drive Driveline end-to-end: push
// its own data inline, lay out panels to visualise it, read data back, and
// drive the transport.
//
// This constant is fixture-tested (see agentSkill.test.ts), the same posture as
// `llm/prompts.ts`: the snapshot pins the exact bytes so any change to the
// agent-facing instructions is deliberate and reviewed. Keep it accurate to the
// real `AgentApi` method signatures in `agentApi.ts`.
//
// The version is inlined as a literal (not imported from `agentApi.ts`) to
// avoid a circular module-init dependency: `agentApi.ts` imports this constant,
// so importing `AGENT_API_VERSION` back here would read it before it
// initialises. `agentSkill.test.ts` asserts this literal matches
// `AGENT_API_VERSION`, so a version bump that forgets to update it fails CI.

export const AGENT_SKILL = `# Driveline — Bring Your Own Agent (BYOA) skill (v3)

Driveline is a browser-first, server-less viewer for synchronised video and
high-rate signal data. Everything runs in the page: the data you push stays in
this browser tab, is never uploaded, and is held in memory for the session.

\`window.__drivelineAgent\` is the automation surface. You are reading its
self-describing guide right now via \`getSkill()\`. Pair it with
\`describe()\` for a machine-readable manifest of every method.

## Unlock the full surface

Discovery is always on: \`version\`, \`getSkill()\` and \`describe()\` work on any
page load. Every MUTATING or data-reading op (\`addDataSource\`,
\`fetchChannelRange\`, \`createPanel\`, \`bindChannels\`, \`setCursor\`, events, …) is
gated behind the \`?agent\` query param. If those methods are missing, reload
the page with \`?agent\` appended to the URL, e.g.
\`https://<host>/?agent\`, then read this skill again.

## The timestamp rule (important)

Every nanosecond timestamp crosses this API as a DECIMAL STRING, never a JS
number. Nanosecond values exceed 2^53, so a JS \`number\` (and JSON) would lose
precision. Pass and read ns as strings like \`"1532671467005757531"\`.

## Push your own data — addDataSource

Send channels as columnar JSON. No files, no URLs:

\`\`\`ts
interface AgentDataSourceSpec {
  name: string;                       // source label, e.g. "my-agent-run"
  channels: Array<{
    name: string;                     // e.g. "vehicle/speed" (slashes build the tree)
    unit?: string;                    // e.g. "m/s"
    kind?: "scalar" | "enum";         // default "scalar"
    timestampsNs: string[];           // decimal-string ns, non-decreasing, length N
    values: number[];                 // length N; enum -> integer codes
  }>;
}

// returns { sourceId, channels: [{ id, name }] }  — or null on any validation
// failure (empty name/channels, mismatched array lengths, unparseable or
// non-decreasing timestamps). It never throws.
addDataSource(spec: AgentDataSourceSpec): { sourceId: string; channels: Array<{ id: string; name: string }> } | null;
\`\`\`

### Worked example — push a sine wave and plot it

\`\`\`js
const agent = window.__drivelineAgent;

// 1. Build ~600 samples of a 0.2 Hz sine "vehicle/speed" channel at 50 Hz,
//    starting at an arbitrary epoch. ns are DECIMAL STRINGS.
const N = 600;
const startNs = 1_700_000_000_000_000_000n; // bigint while building
const stepNs = 20_000_000n;                 // 20 ms = 50 Hz
const timestampsNs = [];
const values = [];
for (let i = 0; i < N; i++) {
  timestampsNs.push((startNs + stepNs * BigInt(i)).toString());
  values.push(20 + 15 * Math.sin((2 * Math.PI * 0.2 * i) / 50));
}

const added = agent.addDataSource({
  name: "my-agent-run",
  channels: [{ name: "vehicle/speed", unit: "m/s", kind: "scalar", timestampsNs, values }],
});
// added.channels[0].id is the qualified channel id used by every other op.
const speedId = added.channels[0].id;

// 2. Visualise it: mint a plot panel and bind the channel.
const panelId = agent.createPanel("plot");
agent.bindChannels(panelId, [speedId]);

// 3. Park the cursor in the middle so the plot + transport line up.
const snap = agent.getSessionSnapshot();
agent.setCursor(snap.globalRange.startNs); // ns string
\`\`\`

### Map example — bind lat/lon

\`\`\`js
const added = agent.addDataSource({
  name: "gps-run",
  channels: [
    { name: "gps/latitude",  unit: "deg", timestampsNs, values: lat },
    { name: "gps/longitude", unit: "deg", timestampsNs, values: lon },
  ],
});
const byName = Object.fromEntries(added.channels.map((c) => [c.name, c.id]));
const panelId = agent.createPanel("map");
agent.setMapBinding(panelId, byName["/gps/latitude"], byName["/gps/longitude"]);
\`\`\`

## Lay out panels

- \`createPanel(kind)\` → \`panelId | null\`. \`kind\` is one of
  \`plot\`/\`map\`/\`enum\`/\`table\`/\`value\`/\`video\`/\`scene\`.
- \`bindChannels(panelId, channelIds)\` → \`boolean\`. Appends scalar/enum channels
  to a \`plot\`/\`enum\`/\`table\`/\`value\` panel. Rejected whole (\`false\`) if any id
  is unknown or the per-panel cap would be exceeded.
- \`setMapBinding(panelId, latId, lonId)\` → \`boolean\` for a \`map\` panel.
- \`closePanel(panelId)\` → \`boolean\`.

## Read data back & drive transport

- \`listSources()\` / \`listChannels()\` — enumerate what is loaded (channel
  \`id\` + \`name\`; for an inline source the displayed name is leading-slashed,
  e.g. \`"/vehicle/speed"\`).
- \`fetchChannelRange(channelId, startNs, endNs, includePrev?)\` →
  \`{ rows, columns: [{ name, values }] }\` for \`[startNs, endNs)\`. The \`ts\`
  column arrives as decimal-string ns; \`value\` (scalar) or \`code\` (enum) as
  numbers. \`includePrev\` also returns the last sample before the window
  (step-hold). Resolves \`null\` for an unknown channel / unparseable bounds.
- \`getSessionSnapshot()\` → \`{ cursorNs, playing, speed, globalRange }\` (ns as
  strings; \`globalRange\` covers every loaded source, including yours).
- \`setCursor(ns)\` / \`play()\` / \`pause()\` / \`setSpeed(x)\` drive the transport.
- Events: \`addEvent({ ns?, label?, tags?, confidence? })\`, \`listEvents()\`,
  \`exportEvents()\`, \`importEvents(json, mode?)\` record machine findings.

## Privacy

Everything stays in this browser tab. \`addDataSource\` holds your samples in
memory and serves them as ranged Arrow batches to the panels — nothing is
uploaded, written to disk, or sent to a server.
`;
