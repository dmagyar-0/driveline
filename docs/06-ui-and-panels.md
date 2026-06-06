# 06 — UI and Panels

## UI stack

- **React 19** + **TypeScript**, built with **Vite 6**.
- **FlexLayout** (`flexlayout-react`) for dockable, resizable, serialisable
  panels.
- **Zustand** for global UI state. A single store; slices by concern.
- **uPlot** for signal plotting.
- **Leaflet** (BSD-2-Clause) for the MapPanel, driven through its imperative
  API directly — no React wrapper, to keep the dependency tree fully
  OSI-permissive.
- **CSS Modules** for styling. Design tokens live in
  `apps/web/src/styles/tokens.css` and are the single source of truth for
  colour, type scale, radius, motion, focus rings. No Tailwind, no
  CSS-in-JS, no global utility classes — keep the bundle lean.

No UI component library. The app is small and opinionated; hand-rolled
controls keep styling under our control and the bundle small.

## App shell

```
┌──────────────────────────────────────────────────────────────────────┐
│ TopBar: brand mark · cursor time · sources count · worker status     │
├────┬─────────────┬───────────────────────────────────────────────────┤
│    │             │                                                   │
│ R  │  Drawer     │            FlexLayout work area                   │
│ a  │  (one of    │  ┌──────────────────────┐ ┌────────────────────┐  │
│ i  │   five      │  │     VideoPanel       │ │      PlotPanel     │  │
│ l  │   tabs)     │  │                      │ │                    │  │
│    │             │  └──────────────────────┘ └────────────────────┘  │
├────┴─────────────┴───────────────────────────────────────────────────┤
│ Transport: │◀ ▶/❚❚ ▶│  ──●─────────  00:03.412 / 00:10  [1×▾]        │
│            readout · [absolute | relative]                           │
└──────────────────────────────────────────────────────────────────────┘
```

The shell is a CSS-grid in `apps/web/src/shell/Shell.tsx`:
`top-row → work-row → transport-row`. The work row is itself a row of
`Rail → Drawer → workMain` (FlexLayout). The whole `<main>` root is the
drag-and-drop target.

### TopBar

`apps/web/src/shell/TopBar.tsx`. Brand mark + wordmark on the left;
right-aligned meta strip with the elapsed cursor time, source count, and
the load-bearing `data-testid="worker-status"` span ("workers ready" /
"workers initialising").

### Left rail + drawers

`apps/web/src/shell/Rail.tsx` is a 40 px column of five icon buttons —
**Sources / Channels / Layout / Panel / Events**. Clicking the active rail
button collapses the drawer (VS Code behaviour). Each button carries
`aria-label`, `aria-pressed`, `aria-expanded`, and
`aria-controls={DRAWER_REGION_ID}`; `DRAWER_REGION_ID` is exported from
`shell/Drawer.tsx` and stamped onto whichever drawer is currently rendered.

`shell/Drawer.tsx` is a discriminator switch over `activeRailTab`. Each
drawer lives at `shell/drawers/<Name>Drawer.tsx`, exposes
`role="region"` + `aria-labelledby` pointing to its `<h3>`, and reuses
`shell/drawers/_row.module.css` for the row primitive (swatch + label
grid):

| Drawer | Responsibility |
|---|---|
| **SourcesDrawer** | List loaded sources, swatch + kind badge, `+ drop / load file…` row, global-range readout. |
| **ChannelsDrawer** | Search + collapsible per-source groups. Click-to-bind: with no panel selected, mints a plot panel; with a plot panel selected, calls `addPlotChannel`; with a video panel selected, calls `setVideoBinding`. |
| **LayoutDrawer** | Saved layouts (`saveCurrentLayoutAs` / `restoreNamedLayout`) with `live` / `active` markers. `Add panel` section adds video / plot / 3D scene / map / table / enum. `Reset layout` row at the bottom. |
| **PanelDrawer** | Configures the selected panel (settings rail flip from the tab chrome). Body switches on `panelKindOf(selectedPanelId)`. Plot bodies list bound channels with × remove + `+ add channel…`, plus a **Gap threshold** toggle+input (on: inter-sample gaps longer than N s render as breaks; off: all gaps render as step-holds). Video body shows decoder label, HUD toggle, and the bound channel. |
| **EventsDrawer** | Bookmarks list with double-click rename, ×, and `+ bookmark at cursor` (one-click + "…" custom-label variant). Out-of-range rows render at 50 % opacity with a `title="Outside the current session's range"` tooltip and `aria-label` prefixed `Out of range — `. |

Drawer state (active tab + collapsed flag) persists via
`state/persist/ui.ts` (key `driveline.ui.v1`).

### Workspace + panel chrome

`apps/web/src/layout/Workspace.tsx` hosts the FlexLayout `<Layout>` and
configures `onRenderTab` to replace the stock tab content with a row of:

- 6-dot grip glyph
- panel name (16 ch ellipsis with `title={node.getName()}` for the full
  string on hover)
- kind badge from `layout/panelId.ts:kindLabel(kind)`
- four icon buttons: **settings** (flips the rail to the `panel` drawer
  for that panelId), **collapse** (greyed; flexlayout-react has no
  first-class collapse so it carries `aria-disabled="true"` +
  `aria-label="Collapse panel — coming soon"` until that lands),
  **maximize** (`Actions.maximizeToggle(tabsetId)`), **close**
  (`Actions.deleteTab(panelId)`).

Every icon button blocks `pointerdown` propagation so the chrome clicks
don't seed FlexLayout's tab-drag gesture. `panelFactory.tsx` wraps every
panel body in a `<div data-testid="panel-body-<id>" onPointerDown=…>` that
sets `selectedPanelId` on click — `display: contents` keeps the wrapper
layout-free.

### Transport

Two-row bar at the bottom of the shell (~54 px). The primary row carries
prev / play-pause / next, start time, scrub track with bookmark markers,
end time, and the speed pill. A 22 px meta row holds the readout and the
relative/absolute mode toggle.

- Pointer scrub uses an rAF coalescer (`pendingNs` + `scheduleCommit`) so
  `cursorNs` updates at most once per frame.
- Discrete keyboard / button steps (Space, Home, End, prev/next,
  ArrowLeft, ArrowRight) call `setCursor` synchronously — `setCursor`
  already clamps `[startNs, endNs]` and auto-pauses at the end. The
  arrow-key step is ±1 s (`ONE_SEC_NS`); the existing INPUT/SELECT focus
  guard ensures arrows never hijack speed cycling.
- `BookmarkMarkers.tsx` renders the bookmark dots over `.trackStrip`
  between the fill and the thumb. Markers are 2 px wide with a ±3 px
  pseudo-element hit-area; `pointerdown` on a marker calls `setCursor(b.ns)`.

## Zustand store shape

```ts
// apps/web/src/state/store.ts (shape only)
interface SessionState {
  // session
  sources: SourceMeta[];
  channels: Channel[];
  globalRange: TimeRange | null;

  // transport
  cursorNs: bigint;
  playing: boolean;
  speed: number;
  cursorMode: 'absolute' | 'relative';

  // panel bindings (one map per panel kind)
  videoBindings:     Record<PanelId, ChannelId | null>;
  plotBindings:      Record<PanelId, ChannelId[]>;
  sceneBindings:     Record<PanelId, ChannelId | null>;
  mapBindings:       Record<PanelId, MapBinding | null>;
  tableBindings:     Record<PanelId, ChannelId[]>;
  enumBindings:      Record<PanelId, ChannelId[]>;  // one state strip per channel
  videoHudOn:        Record<PanelId, boolean>;
  plotPanelSettings: Record<PanelId, PlotPanelSettings>; // gap threshold per panel

  // layout
  layoutJson: unknown;
  namedLayouts: NamedLayout[];
  activeNamedLayoutId: string | null;

  // bookmarks
  bookmarks: Bookmark[];

  // UI shell
  activeRailTab: RailTab | null;
  railCollapsed: boolean;
  selectedPanelId: PanelId | null;

  // actions (open/close, transport, bindings, layout, bookmarks, …)
}
```

Why Zustand:

- Tiny (~1 KB), no provider boilerplate, no context-induced re-renders.
- Selectors let each panel subscribe only to what it needs
  (`useSession(s => s.cursorNs)` — re-renders only when the cursor changes).
- BigInt everywhere for time. Convert to `Number` only at the rendering
  boundary; never `parseInt` a BigInt.
- Side-effectful actions live in the store next to state; no extra
  middleware.

Persistence is sliced into adapters under `state/persist/`:

- `layout.ts` — FlexLayout JSON + the six binding maps + `videoHudOn` +
  `plotPanelSettings` (`driveline.layout.v3`; `plotPanelSettings` is an
  optional field, defaulting to `{}` for pre-Phase-8 saved layouts).
- `namedLayouts.ts` — saved layouts (`driveline.layouts.named.v2`).
- `bookmarks.ts` — bookmark list with BigInts encoded as decimal strings
  (`driveline.bookmarks.v1`).
- `ui.ts` — `activeRailTab`, `railCollapsed` (`driveline.ui.v1`).

`clearSession()` deliberately preserves `layoutJson`, `namedLayouts`, and
`bookmarks` — those slices outlive a single session.

## Scrub → cursor propagation

Scrubbing is hot path. The store publishes `cursorNs` at most once per
animation frame:

1. The scrubber's `pointermove` handler converts pointer X to ns and calls
   `setCursor(ns)`.
2. `setCursor` updates state and schedules a rAF tick if one is not
   pending.
3. On the rAF tick, state is committed. Subscribers re-render with the
   new cursor.
4. `VideoPanel` applies an additional trailing debounce (50 ms) before
   issuing `seek` to the video-decode worker, so a drag produces one seek
   at the end of a flick, not hundreds in the middle.
5. `PlotPanel`, `EnumPanel`, and `BookmarkMarkers` redraw their cursor
   overlays immediately — cheap canvas work, data already in memory.

## Panels

The panel factory (`apps/web/src/layout/panelFactory.tsx`) maps the
FlexLayout component string to a React component:
`"video"` → `VideoPanel`, `"plot"` → `PlotPanel`, `"scene"` →
`ScenePanel`, `"map"` → `MapPanel`, `"table"` → `TablePanel`,
`"enum"` → `EnumPanel`. New panels are minted via the LayoutDrawer's
`Add panel` rows.

### VideoPanel

- Single `<canvas>` sized to the panel's content box; ResizeObserver
  re-sets canvas dimensions on resize.
- Subscribes to the bound `channelId`, `cursorNs`, and
  `videoHudOn[panelId]`.
- On mount: asks the `videoDecode` worker to `open(channelId)`.
- Receives `VideoFrame` objects via a `MessagePort`; blits with
  `canvas.getContext('2d').drawImage(frame, 0, 0, w, h)`.
- Keyboard when focused: `Space` toggles play; transport-bar keyboard
  shortcuts handle the rest.
- HUD overlay (toggleable from three surfaces — `h` keypress, in-panel
  button, PanelDrawer toggle): current PTS, frame index, decode queue
  length, dropped-frame counter. The `videoHudOn` slice is the single
  source of truth; the HUD button + PanelDrawer toggle + `h` keypress all
  dispatch `toggleVideoHudOn(panelId)`.

### PlotPanel

- `<canvas>` managed by uPlot.
- Subscribes to the bound `channelId[]` and to `cursorNs` and to the
  panel's visible `xRange` (starts equal to `globalRange`).
- Data fetch: on bind or on `xRange` change, call
  `fetchChannelRange(channelId, t0, t1)`. Receives Arrow IPC bytes;
  `seriesFromArrow` decodes to `[ts_array, value_array]` for uPlot.
- Cursor overlay is a vertical line at `cursorNs` projected to pixel X,
  drawn on a second canvas layered over uPlot's. Stroke colour comes from
  `panels/cursorOverlay.ts:cursorStrokeColor()` which reads
  `--color-accent-orange` off `:root`.
- Multi-series overlay: up to `MAX_PLOT_SERIES = 8` per panel. Colour
  assignment is deterministic via `panels/palette.ts:colorFor(channelId)`
  (FNV-1a over 8 palette slots).
- Panel controls live in the PanelDrawer: channel × remove, `+ add
  channel…` opens `panels/ChannelPicker.tsx`; a **Gap threshold**
  toggle switches between span-gaps (default) and step-hold-with-breaks
  mode, stored per-panel in `plotPanelSettings` via `persist.ts`.

### ScenePanel

3D point-cloud viewer (LiDAR). Binds a single `point_cloud` channel via
`sceneBindings[panelId]` and renders the spin active at the shared cursor
through a dependency-free **WebGL2** renderer (`pointCloudRenderer.ts`) —
no three.js (the size budget counts lazy chunks too, and a point cloud is
one `gl.POINTS` draw call). Points are coloured by **intensity** via a
turbo colormap LUT; orbit / pan / zoom with the mouse, over a ground grid.

Data path: the Rust core's `PointCloudReader` (`SourceKind::Lidar`,
`ChannelKind::PointCloud`) reads a *Driveline point-cloud Parquet*
(`*.lidar.parquet`, one row per spin) and `fetch_range` emits
`{ ts, positions: List<Float32>, intensities: List<Float32> }` per spin.
`pointCloudFromArrow.ts` decodes it. Time-sync is waste-free: the panel
pulls the source's spin start-times once (`lidarSpinTimes`) and
binary-searches them locally, refetching geometry **only when the cursor
crosses into a new spin**, so playback/scrub steps the cloud without a
per-tick fetch. See `tools/alpamayo_lidar_to_driveline.py` for the
NVIDIA-Alpamayo (Draco) → `.lidar.parquet` converter.

The PanelDrawer body auto-detects bindable channels by kind:
`SCENE_CHANNEL_KINDS` (`["point_cloud", "vector"]`) filters the
`ChannelPicker`, and `+ bind channel…` disables when none is loaded.

### MapPanel

OSM tile layer + lat/lon polyline via Leaflet. Lat/lon are explicitly
bound through the PanelDrawer (`MapBinding = { latChannelId,
lonChannelId }`); no `*.lat`/`*.lon` magic. Polyline is downsampled to
≤ 5000 points and auto-fits its bounds. Polyline colour comes from
`palette.ts:colorFor(panelId)` so two MapPanels in one workspace pick
distinct hues; the cursor stroke is a separate path
(`panels/cursorOverlay.ts:cursorStrokeColor()`).

### TablePanel

Hand-rolled value table (header + 8-row body, the same `MAX_PLOT_SERIES`
cap as plots). Values are sampled at the cursor via the same
`lastIndexAtOrBefore` binary-search pattern PlotPanel uses for its
cross-panel sync snapshot.

### EnumPanel

Binds multiple scalar channels and renders each as its own fixed-height
"lane" — a labelled, hand-rolled canvas strip of enum-state intervals
layered with the shared cursor overlay, plus a current-state pill that
reads the value at the cursor. Lanes stack from the top and the panel
scrolls once they overflow, so a single signal occupies one short lane
rather than filling the whole panel. Each enum value's colour comes from
`colorFor(String(value))` so two strips reading the same channel agree;
the value is drawn inside any segment wide enough to fit it.

## FlexLayout integration

- Layout JSON lives in the store as `layoutJson` and persists via
  `state/persist/layout.ts` alongside the binding maps.
- On mount, initial layout comes from `localStorage` (`driveline.layout.v3`)
  or the default horizontal split.
- `onRenderTab` replaces the stock chrome with the four-icon cluster
  documented under **Workspace + panel chrome**. `onRenderTabSet` is a
  no-op for v1.
- Panel factory maps `component` to React component (see **Panels**).
- New panels are minted via the LayoutDrawer's `Add panel` rows.

## Bookmarks

`Bookmark = { id, ns: bigint, label, color, createdAt }`. The store
`bookmarks` slice is mutated through four actions:

- `addBookmarkAtCursor(label?)` — defaults the label to
  `bookmark @ <relative-time>`, freezes the colour at create-time via
  `palette.ts:colorFor(id)`. Returns `null` when `globalRange === null`.
- `addBookmark(ns, label?)` — test seam, no clamping.
- `removeBookmark(id)`, `renameBookmark(id, label)`.

The transport scrubber renders `BookmarkMarkers.tsx` as a child of
`.trackStrip` between `.trackFill` and `.thumb`. Markers are
`pointer-events: none` except the individual 2 px markers; out-of-range
bookmarks clamp to `[0, 100]%` at 50 % opacity. Bookmarks survive
`clearSession()` (same posture as `layoutJson` / `namedLayouts`).

## Drag-and-drop ingest

- The whole shell `<main>` is a drop target. On drop:
  - Collect `File`s, bucket by extension (`.mcap`, `.mf4`, `.mp4`,
    `.mp4.timestamps`).
  - `.mcap` and `.mf4` files open immediately.
  - `.mp4` files wait for their matching `.mp4.timestamps`. Once paired,
    open as `mp4+ts` source.
- Errors surface alongside the source row in the SourcesDrawer.

## Accessibility floor

These are the non-negotiables; failing one blocks merge:

- Keyboard: every interactive control reachable by Tab. DOM order is
  Rail → Drawer → workspace → transport. Visible `:focus-visible` ring
  on every control via `var(--focus-ring)` from tokens.
- Targets: ≥ 44×44 px on the transport bar (touch-laptop usage). Tighter
  in dropdowns where the whole row is the target.
- Contrast: body text ≥ 4.5:1; large text and icon-only buttons ≥ 3:1.
- Semantics: drawers carry `role="region"` + `aria-labelledby` pointing
  at their `<h3>`. Rail buttons carry `aria-controls` pointing at the
  drawer region id.
- Motion: every animation > 150 ms has a `prefers-reduced-motion: reduce`
  fallback that completes immediately. The video panel itself is exempt
  (it's content, not chrome).
- Body font ≥ 16 px on the base; rem-based throughout. Type scale tokens
  `--fs-10` … `--fs-22` live in `styles/tokens.css`.

## Non-goals for UI (v1)

- No theme switcher. Default dark mode only.
- No i18n.
- No URL state sync / shareable session links.
- No resizable drawer width (fixed at 220 px); deferred to v2.
- No first-class FlexLayout collapse action; the chrome icon is greyed
  until upstream lands one.
- No drag-to-reposition bookmarks; delete + re-add at the new cursor.
