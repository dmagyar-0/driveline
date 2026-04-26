# Driveline V1 shell — integration plan

Phased migration plan to replace the current `apps/web/` shell (single-pane
stack of `<h1>` + dropzone + summary + workspace + transport) with the V1
**VS Code-style left rail** design.

## Context

The design source-of-truth lives in this repo at
[`docs/design/wireframe-bundle/`](./wireframe-bundle/). Read the chat
transcript (`wireframe-bundle/chats/chat1.md`) and the HTML prototype
(`wireframe-bundle/project/Driveline Wireframes.html`) before starting Phase 0.

The user iterated to a single chosen variant — **V1 · Standard rail
(VS Code style)** — with these explicit decisions captured in the chat:

- Top bar is decorative: rounded-square logo + wordmark + right-aligned session meta.
- Left **icon rail** (40 px collapsed, 220 px drawer when expanded) with five
  sections: **Sources, Channels, Layout, Panel, Events**.
- Per-panel chrome: thin header strip (always visible) with grip, title,
  kind tag, and four icon buttons: settings, collapse, fullscreen, close.
- **Selected-panel indicator is neutral hover-gray (`--color-border-hover`),
  NOT brand orange** — explicit user pushback during the chat.
- Bottom transport stays sticky, refined to match the wireframe (small
  buttons, orange play, scrub track between two timestamps + speed pill).
- Six panel kinds in scope: video, plot, **3D scene, map, table, enum strip**
  (the last four are new).
- Bookmarks/events and named saved layouts are real features
  (not visible-only placeholders).

The design's `tokens.css` is intentionally a near-1:1 mirror of the existing
dark theme already used in `apps/web/src/**.module.css` and
`panels/palette.ts` — surface ramp `#000` → `#222`, accents `#f97316` (orange)
and `#2a6df4` (blue), 8-color plot palette unchanged. **No theme change is
required**, but tokens should be promoted to a shared `:root` so component
CSS can stop hard-coding hex values.

The point of this integration is purely UX/IA: the new shell gives every
existing function (sources, channels, panel add, panel settings) a fixed
home, plus introduces bookmarks and named layouts.

Goal: **replace the visual shell while preserving every dev hook, store
action, worker boundary, and Playwright contract that exists today.**

---

## Architectural mapping (current → designed)

| Current surface | File | Where it goes in the new shell |
|---|---|---|
| `<h1>Driveline</h1>` + workers ready text (`App.tsx:368-371`) | `App.tsx` | New `TopBar` component (logo + wordmark + session meta on right) |
| Dropzone (`App.tsx:372-380`, `App.module.css:.dropZone`) | `App.tsx` | Stays a window-level drag overlay; visible call-to-action moves into Sources drawer |
| `<SessionSummary>` (sources + channels render) | `App.tsx` | Split: source rows → Sources drawer; channel rows → Channels drawer |
| `<Workspace>` toolbar (`Workspace.tsx:181-207`) — `+ Video / + Plot / Reset layout` | `layout/Workspace.tsx` | Buttons move into Layout drawer (alongside new `+3D`, `+Map`, `+Table`, `+Enum`); workspace renders only the FlexLayout `<Layout>` |
| `<Transport>` | `timeline/Transport.tsx` | Visual refinement only — same store wiring, same shortcuts, same hot path |
| FlexLayout default tab strip | `Workspace.tsx` + flex CSS vars | Customised via `onRenderTab` + `onRenderTabSet` to inject grip / kind tag / custom icons; selected-panel border swapped to `--color-border-hover` |

The store (`apps/web/src/state/store.ts`) is extended with three new slices,
all following the existing single-store-with-actions pattern:

- **`ui` slice** — `activeRailTab: 'sources' | 'channels' | 'layout' | 'panel' | 'events' | null`,
  `railCollapsed: boolean`, `selectedPanelId: string | null`. Persisted to
  `localStorage[driveline.ui.v1]` (mirrors the existing `driveline.layout.v1` adapter).
- **`bookmarks` slice** — `bookmarks: Bookmark[]` where
  `Bookmark = { id: string; ns: bigint; label: string; color: string; createdAt: number }`.
  Persisted to `localStorage[driveline.bookmarks.v1]`. BigInts serialised as
  decimal strings (mirror the layout-persist adapter).
- **`namedLayouts` slice** — `namedLayouts: { id; name; layoutJson; videoBindings; plotBindings; … }[]`
  plus `activeNamedLayoutId`. Persisted to `localStorage[driveline.layouts.named.v1]`.

---

## Phases

Each phase is independently shippable. After each phase the app should boot,
all existing Playwright e2e specs should still pass, and the type-check +
Vitest suite must stay green.

### Phase 0 · Tokens, assets, fonts

1. Copy `docs/design/wireframe-bundle/project/tokens.css` to
   `apps/web/src/styles/tokens.css`. Import once from `apps/web/src/main.tsx`
   **before** `App.module.css`. Keep the file's `:root` block intact — it is
   the canonical token sheet from now on.
2. Sweep existing `*.module.css` files and replace literal hex values that
   match a token (`#0b0b0b` → `var(--color-bg-1)`,
   `#151515` → `var(--color-bg-3)`, `#2a6df4` → `var(--color-accent-blue)`,
   `#f97316` → `var(--color-accent-orange)`, `#666` → `var(--color-fg-6)`,
   etc.). Mechanical but enables the rest of the work to consume tokens.
3. Brand assets are **already** at `apps/web/public/brand/{logo,wordmark,favicon}.svg`
   (added alongside this plan). Update `apps/web/index.html`
   `<link rel="icon">` to `/brand/favicon.svg`.
4. **Do not** add Kalam/Caveat from Google Fonts. The wireframe uses them for
   low-fi placeholder text; production should stay on `system-ui` (already
   the default token family). If a designer wants a body font, that is a
   separate decision — flag it and stop, don't pick one.
5. Verify bundle size budget after the token+assets pass:
   `pnpm --filter web build` and read the gzip column in the Vite manifest.
   Token CSS is < 5 KB and adds nothing measurable.

### Phase 1 · Shell skeleton (top bar + rail + drawer host) — visual only

1. Create `apps/web/src/shell/` with five files: `Shell.tsx`, `TopBar.tsx`,
   `Rail.tsx`, `Drawer.tsx`, `Shell.module.css`. One component per file
   (frontend skill rule).
2. Add the `ui` slice to `state/store.ts`. Selectors that read it must follow
   the existing single-key pattern (`useSession((s) => s.activeRailTab)`) —
   no whole-slice destructuring (frontend skill rule on selectors).
3. `Shell.tsx` lays out a CSS grid: rows `36px 1fr 32px` (top, work area,
   transport); columns conditional on `railCollapsed`. The work-area row is
   itself a sub-grid of `40px [drawer 220px when open] 1fr`. **No `useEffect`
   for derived layout** — derive grid-template inline from `railCollapsed`.
4. `TopBar.tsx`: `<img>` brand mark (use `/brand/logo.svg`,
   `width=22 height=22`), wordmark (`driveline`, weight 600, 13 px).
   Right-aligned `.meta` slot — initially shows
   `${formatRelative(cursorNs)} · ${sources.length} sources`.
   Subscribe to `cursorNs` and `sources.length` via separate selectors.
5. `Rail.tsx`: vertical column of 5 `<button>` rail items with the SVG icons
   from `wireframe-bundle/project/wf-parts.jsx:RailIcons`. Active item =
   orange foreground + 2 px left accent bar (CSS `::before`). Click toggles
   `activeRailTab` (clicking the active one collapses to `null` — the user's
   stated VS Code-style behaviour). Each button: `aria-label`, visible
   `:focus-visible` ring (frontend skill a11y minimums).
6. `Drawer.tsx`: thin host that switches on `activeRailTab` and renders the
   corresponding drawer component. Hidden when `activeRailTab === null`.
   Drawer width fixed at 220 px; resizable handle is **out of scope** for
   this pass.
7. Mount `Shell` at the root of `App.tsx`, replacing the current
   `<main className={styles.shell}>` block. Keep dropzone behaviour by
   attaching `onDragOver`/`onDrop` to `Shell`'s root `<main>`. Existing
   `<Workspace>` and `<Transport>` are children of `Shell`.
8. **Dev hooks added** in `App.tsx` next to existing ones:
   - `setActiveRailTab(tab: string | null)`
   - `getActiveRailTab()`
   - `setRailCollapsed(b: boolean)`
9. **Existing dev hooks must keep working unchanged** (`getSessionSnapshot`,
   `addVideoPanel`, `setVideoChannelBinding`, `videoLastBlitPtsNs`, etc.).
   The Playwright e2e suite is the contract — run `pnpm --filter e2e test`
   after this phase and it must stay green.

### Phase 2 · Sources drawer

1. `apps/web/src/shell/drawers/SourcesDrawer.tsx`. Read `sources` and
   `globalRange` from the store via discrete selectors.
2. Render: `<h3>Sources <Pill>{sources.length}</Pill></h3>` + one row per
   source. Row = swatch (deterministic colour by `source.id` via
   `palette.ts:colourForId`) + name + kind badge (`MCAP`, `MF4`, `MP4+TS`).
3. Active source row gets `--color-bg-4` background + 2 px left orange
   border. Selected source is local UI state inside the drawer (not in the
   store) — selecting a source filters the Channels drawer.
4. Add row `+ drop / load file…` at the bottom — clicking opens the same
   file picker dialog the dropzone uses. Reuse `openFiles()` from the store.
5. Below a `--color-border-subtle` separator, render `<h3>Global range</h3>`
   with start/end formatted from `globalRange`.
6. Delete the body of the old `<SessionSummary>` once Sources + Channels
   drawers cover it; remove the file and update imports.

### Phase 3 · Channels drawer

1. `apps/web/src/shell/drawers/ChannelsDrawer.tsx`. Read `channels` from the
   store.
2. Group by source (collapsible source headers). Within each group, list
   channel rows: swatch (from `palette.ts`), name, type badge (`f64`, `f32`,
   `enum`, `u32`).
3. Click a channel = "send to active panel". Active panel = `selectedPanelId`
   (added in Phase 1's `ui` slice). If the active panel is a plot, call
   `addPlotChannel(panelId, channelId)`; if video, call
   `setVideoBinding(panelId, channelId)`. If no active panel, call
   `addPlotPanel()` (auto-add) and then bind. Reuse store actions — do not
   introduce new ones.
4. Drag handle on each channel row using HTML5 DnD with the panel body as
   drop target — **defer this** to a follow-up if it adds risk; the
   click-to-bind path is sufficient for V1.
5. Top-of-drawer search input filtering by substring on `channel.name`
   (local `useState`, no store).

### Phase 4 · Layout drawer

1. `apps/web/src/shell/drawers/LayoutDrawer.tsx`. Two sections: **Saved
   layouts**, **Add panel**.
2. **Add panel** section: replaces the existing `Workspace.tsx` toolbar.
   Rows: `+ video`, `+ plot`, `+ 3D scene`, `+ map`, `+ table`, `+ enum`
   plus a separated `Reset layout` link. Wire through the existing
   `WorkspaceHandle` ref (`addVideoPanel`, `addPlotPanel`, `resetLayout`)
   plus four new methods added in Phase 6 (`addScenePanel`, `addMapPanel`,
   `addTablePanel`, `addEnumPanel`).
3. **Saved layouts** section: list rows from the new `namedLayouts` slice.
   Each row = name + meta tag (`live` if it matches current). Active one
   gets the orange-bordered active style. Click = restore (`setLayoutJson` +
   restore stored binding maps). `+ save current as…` opens a small inline
   name input that calls a new store action `saveCurrentLayoutAs(name)`.
4. Persistence: write a small adapter at
   `apps/web/src/state/persist/namedLayouts.ts`. Storage key
   `driveline.layouts.named.v1`. Schema-versioned JSON; corrupt JSON falls
   back to empty.
5. Remove the toolbar block from `Workspace.tsx` (`Workspace.tsx:181-207`).
   Keep the empty-shell fallback (`rootEmpty` branch).
6. **Dev hooks added**: `saveCurrentLayoutAs(name)`, `restoreNamedLayout(id)`,
   `listNamedLayouts()`.

### Phase 5 · Panel drawer (settings for selected panel)

1. `apps/web/src/shell/drawers/PanelDrawer.tsx`. Reads `selectedPanelId` and
   walks the FlexLayout model JSON to determine the panel kind.
2. **Selected panel** plumbing (do this before the drawer body): in Phase 7's
   panel-chrome render, wire each panel's container `onClick`/`onFocus` to
   `setSelectedPanelId`. Selected panel border becomes
   `--color-border-hover` (the user's explicit tweak — NOT orange).
3. Drawer body switches on panel kind:
   - **Video**: `decoder` (h264/h265 read-only label), `step-hold` toggle,
     `HUD overlay` toggle (mirror existing `VideoPanel` HUD ref state —
     promote `hudOn` to the store keyed by panel id, OR expose it via a
     setter on the panel ref). `Channels in panel`: shows current
     `videoBindings[panelId]` with a remove button.
   - **Plot**: list each `plotBindings[panelId]` channel with swatch +
     remove (`removePlotChannel`). `+ add channel…` opens the existing
     `<ChannelPicker>` popover.
   - **3D / Map / Table / Enum**: kind-specific minimal options (point size,
     lat/lon channel selector, column visibility, lane channel binding) —
     flesh out in Phase 6 alongside the panel implementations.
4. Empty state: "Select a panel to configure it" with a hint to click any
   panel header.

### Phase 6 · New panel kinds (Scene / Map / Table / Enum)

These are real implementations, but each is intentionally minimal at v1.
Each one gets a folder in `apps/web/src/panels/` with `<Name>Panel.tsx`,
`.module.css`, and a corresponding store binding map.

1. **Store extensions**:
   `sceneBindings: Record<panelId, channelId | null>`,
   `mapBindings: Record<panelId, { latChannelId: string; lonChannelId: string } | null>`,
   `tableBindings: Record<panelId, channelId[]>`,
   `enumBindings: Record<panelId, channelId[]>`.
   All persist via the existing layout adapter (extend `persist.ts`).
2. **`PANEL_COMPONENT_*` constants**: extend
   `apps/web/src/layout/defaultLayout.ts` with
   `PANEL_COMPONENT_SCENE | _MAP | _TABLE | _ENUM`. Wire into
   `panelFactory.tsx` switch.
3. **`Workspace.tsx` ref API**: add `addScenePanel()`, `addMapPanel()`,
   `addTablePanel()`, `addEnumPanel()` mirroring the existing
   `addPlotPanel()` shape.
4. **ScenePanel** — placeholder canvas + an `<Empty>` callout with copy
   "3D scene rendering pending point-cloud format from rust core".
   Acceptable for v1 because the data format isn't defined yet. Do **not**
   pull in `three.js` until there is a real channel format to render.
5. **MapPanel** — Leaflet (`leaflet@1.9.x` + `react-leaflet@4.x`). Justify
   in PR: a tiny dependency (~40 KB gzipped) and the only realistic option
   besides MapLibre/Mapbox which need a token. Render OSM tiles + a polyline
   from `lat/lon` channels. Honour the existing 350 KB gzip budget — measure
   after install.
6. **TablePanel** — virtualised list (use the existing `react-virtuoso` if
   already present; otherwise a hand-rolled windowed list — frontend skill
   bans new component libraries). Subscribe to `tableBindings[panelId]` and
   stream rows from the worker.
7. **EnumPanel** — uses uPlot in step-plot mode (extend, don't add a new
   charting library — frontend skill rule). Each enum value = a coloured
   horizontal segment. Reuse `palette.ts` for state colours; map state→color
   deterministically by FNV-1a hash of `state name`.
8. **Worker side**: each panel kind needs an Arrow IPC fetch entry point.
   For v1, ScenePanel/MapPanel/TablePanel/EnumPanel can call existing
   `mf4FetchRange` or a new `fetchEnumStateChanges(channelId, range)` —
   define these incrementally and don't add Rust-side work to this phase if
   the format isn't already defined.
9. **Selected-panel test**: each new panel kind renders correctly when
   selected, and the Panel drawer shows kind-appropriate options.

### Phase 7 · Per-panel chrome via FlexLayout customisation

1. In `Workspace.tsx`, pass `onRenderTab` and `onRenderTabSet` to `<Layout>`.
   **Customise the existing FlexLayout tab — do not hide it and reimplement.**
2. `onRenderTab(node, renderValues)`:
   - Replace `renderValues.content` with `<>` containing: grip SVG, panel
     name, kind tag (badge), then the icon-button cluster (settings,
     collapse, fullscreen, close). Use FlexLayout's built-in `Maximize`
     action for fullscreen and `DeleteTab` for close. Settings button calls
     `setSelectedPanelId(node.getId())` and `setActiveRailTab('panel')`.
     Collapse: out of FlexLayout's API — implement as `Actions.deleteTabset`
     + remember in `ui` slice for restore, OR ship without collapse in v1
     and grey the icon out with `aria-disabled`. Pick the latter for the
     first cut; flag in the PR.
   - Set `renderValues.buttons` to `[]` to suppress FlexLayout's default
     close icon (we render our own).
3. `onRenderTabSet(node, renderValues)`: empty for now — single-tab tabsets
   look like the wireframe panel out of the box.
4. CSS: override FlexLayout's CSS variables in `Workspace.module.css` so:
   - `--color-tab-selected` becomes `--color-fg-2` (white-ish), not orange.
   - `--color-tab-selected-background` becomes `--color-bg-3`.
   - The tabset border uses `--color-border-subtle`; selected tabset gets
     `--color-border-hover` (not orange — the user's explicit tweak).
5. **Click-to-select panel**: in `panelFactory.tsx`, wrap each panel's
   container in a `<div onPointerDown={() => setSelectedPanelId(panelId)}>`
   so anywhere you click on the panel body marks it as selected. The
   drawer-row "active panel" reflects this.
6. **Dev hook added**: `getSelectedPanelId()`, `setSelectedPanelId(id)`.
7. The frontend skill calls out a known trap: "thing disappears when status
   changes." When wiring `onRenderTab`, do NOT predicate the icon cluster on
   `selected && hovered`; render it **always** (the wireframe shows
   always-visible chrome). If a future variant wants hover-only chrome,
   model it as a kind-flag, not a boolean chain.

### Phase 8 · Events drawer (bookmarks)

1. `apps/web/src/shell/drawers/EventsDrawer.tsx` +
   `state/persist/bookmarks.ts`.
2. Bookmark shape:
   `{ id: string; ns: bigint; label: string; color: string; createdAt: number }`.
   BigInt serialised as decimal string in storage (mirror layout adapter).
3. Render: `<h3>Bookmarks <Pill>{bookmarks.length}</Pill></h3>` + one row
   per bookmark sorted by `ns`. Row = colour swatch + label + relative-time
   meta. Click row = `setCursor(bookmark.ns)`. `+ bookmark at cursor` button
   calls a new store action `addBookmarkAtCursor(label?)` (default label =
   `bookmark @ <relative time>`).
4. Inline rename: double-click a bookmark to edit label. Delete via a
   hover-revealed × button.
5. **Transport overlay**: render small bookmark markers on top of the
   scrubber track. Implement in `Transport.tsx` as a child layer absolutely
   positioned at `(ns - startNs) / duration * 100%`. Use
   `transform: translateX(-50%)` only — no width/left animation
   (frontend skill perf rule).
6. **Dev hooks**: `addBookmarkAtCursor(label?)`, `listBookmarks()`,
   `removeBookmark(id)`. Returns serialise BigInts as strings.
7. Persistence key: `driveline.bookmarks.v1`.

### Phase 9 · Transport refinement

1. `Transport.module.css`: re-style to match wireframe (height 32 px,
   smaller buttons 22×20 px, scrub track 6 px tall, thumb 12 px, orange
   play colour). All driven from tokens.
2. Add prev/next 1-second buttons (visual and functional). Reuse
   `setCursor`. Implement keyboard shortcut: existing `Space/Home/End` plus
   arrow-left/right step (already specced — just ensure not regressed).
3. Speed pill: keep existing speed dropdown but restyle to a single-line
   pill. Same `[0.25, 0.5, 1, 2, 4]` options.
4. **Hot-path discipline**: do NOT touch the rAF coalescing in `setCursor`,
   do NOT remove the 50 ms VideoPanel decode debounce (frontend skill
   explicit rule). Verify `videoHudStats().decodeQueue` looks identical
   before/after via Playwright.
5. Assert performance budget unchanged: PlotPanel + Transport re-render
   under 4 ms with 5 channels at 1080p (frontend skill budget).

### Phase 10 · Cleanup, polish, accessibility audit

1. Delete `App.module.css` blocks the new shell doesn't use (`.shell`,
   `.dropZone`, `.sources`, `.source`, `.sourceHeader`, `.sourceName`,
   `.sourceKind`, `.meta`, `.global`, `.errors`). The shell's own CSS module
   owns these now.
2. Delete `SessionSummary.tsx` and remove its import from `App.tsx`.
3. Run the frontend-skill **pre-completion checklist** end-to-end:
   type-check, unit tests, e2e, manual browser exercise of golden path,
   320 px breakpoint, tab focus rings, reduced-motion, bundle size delta.
4. **Accessibility**: every rail button has an `aria-label`, every drawer
   row that's interactive has a discernible name, keyboard `Tab` order is
   rail → drawer → workspace → transport, drawers expose `role="region"`
   with `aria-labelledby` pointing to their `<h3>`. Body font ≥ 16 px
   (`var(--fs-16)`); rem-based throughout.
5. Update `docs/06-ui-and-panels.md` to describe the new shell (rail +
   drawers, panel chrome via `onRenderTab`, bookmarks). The existing prose
   on hot path / FlexLayout / Zustand stays valid.
6. Update e2e specs that select on the old `<h1>Driveline</h1>` or the
   workspace toolbar — those nodes are gone. Prefer the new dev hooks
   (`setActiveRailTab`, `getSelectedPanelId`) over DOM selectors
   (frontend skill Playwright rule).

---

## Critical files to modify

- `apps/web/src/App.tsx` — replace shell rendering, add new dev hooks
- `apps/web/src/App.module.css` — strip obsolete blocks
- `apps/web/src/main.tsx` — import `tokens.css`
- `apps/web/src/state/store.ts` — add `ui`, `bookmarks`, `namedLayouts`
  slices and the four new `*Bindings` maps
- `apps/web/src/state/persist.ts` — extend with new keys
- `apps/web/src/layout/Workspace.tsx` — drop toolbar, wire `onRenderTab`,
  expose four new `add*Panel` methods
- `apps/web/src/layout/panelFactory.tsx` — switch on four new component
  constants; wrap each panel for click-to-select
- `apps/web/src/layout/defaultLayout.ts` — new component constants
- `apps/web/src/timeline/Transport.tsx` + `.module.css` — restyle, bookmark
  markers
- `apps/web/src/SessionSummary.tsx` — delete after Phase 2

## Files to create

- `apps/web/src/styles/tokens.css`
- `apps/web/src/shell/{Shell,TopBar,Rail,Drawer}.{tsx,module.css}`
- `apps/web/src/shell/drawers/{Sources,Channels,Layout,Panel,Events}Drawer.{tsx,module.css}`
- `apps/web/src/panels/{Scene,Map,Table,Enum}Panel.{tsx,module.css}`
- `apps/web/src/state/persist/{bookmarks,namedLayouts,ui}.ts`

## Existing utilities to reuse — do not reimplement

- `apps/web/src/panels/palette.ts` — `PLOT_PALETTE`, `MAX_PLOT_SERIES`.
  Source/channel/bookmark/enum-state colours all derive from this via
  FNV-1a hash. **No new palette files.**
- `apps/web/src/state/store.ts` actions: `openFiles`, `clear`, `setCursor`,
  `play`, `pause`, `setSpeed`, `addPlotChannel`, `removePlotChannel`,
  `setVideoBinding`, `setLayoutJson`. Drawers compose these — they don't
  add parallel actions.
- `apps/web/src/workerClient.ts` — sole worker entry. Map/table/enum/scene
  panels go through this.
- `apps/web/src/panels/ChannelPicker.tsx` — reuse from Plot panel for the
  Panel drawer's "+ add channel" affordance.
- `apps/web/src/panels/cursorOverlay.ts` — single overlay canvas; new plot
  kinds (enum) layer through this.
- FlexLayout's `Actions.deleteTab`, `Actions.maximizeToggle` for
  close/fullscreen — don't reimplement.

## Verification

After each phase:

```sh
pnpm --filter web build       # tsc --noEmit + production build (bundle budget check)
pnpm --filter web test --run  # Vitest unit
pnpm --filter e2e test        # Playwright (must stay green throughout)
```

Manual end-to-end (frontend-skill explicit requirement — type-check is not
enough):

1. `pnpm --filter web dev`, open the app.
2. Drag a fixture from `test-fixtures/` (MCAP + MP4+timestamps pair).
3. Sources drawer shows both sources. Channels drawer shows their channels.
4. Rail click toggles drawer; clicking active rail item collapses drawer.
   Reload preserves both.
5. Add a plot panel from the Layout drawer; click a channel in Channels
   drawer with that panel selected — channel binds and plots. Cursor scrub
   stays buttery (no regressions vs. baseline trace).
6. Add a video panel; bind a video channel; HUD toggle in Panel drawer
   reflects in the panel.
7. Drop a bookmark at the current cursor from the Events drawer. Reload.
   Bookmark appears on transport scrubber. Click it → cursor jumps.
8. Save current layout as "debug"; rearrange; restore "debug" — layout +
   bindings come back.
9. Tab through the whole app — every interactive control has a visible
   focus ring.
10. Browser zoom to 200% and check the layout doesn't shatter at narrow
    widths.
11. Toggle `prefers-reduced-motion: reduce` in DevTools; rail/drawer
    transitions should snap, not animate.

Bundle: gzipped initial JS must remain ≤ 350 KB (hard ceiling 500 KB).
Leaflet adds ~40 KB; document this in the Phase 6 commit.

---

## Open questions / risks (worth confirming before Phase 6+)

1. **3D scene data format** — no defined Arrow-side schema yet. ScenePanel
   ships as an empty-state stub until the Rust core defines `point_cloud`
   channel typing. Do not add `three.js` speculatively.
2. **Map lat/lon channels** — relies on convention (`*.lat`, `*.lon`) or
   explicit user binding through Panel drawer. Pick explicit binding for v1
   to avoid magic.
3. **FlexLayout collapse action** — there is no first-class collapse in
   flexlayout-react. Greying the icon and deferring is acceptable; if a
   real implementation lands, it'll modify the layout JSON to
   `enabled: false` on the tabset and store a sibling-restore-info entry in
   the `ui` slice.
4. **Bookmark colours** — wireframe assigns mixed plot palette colours per
   bookmark. Use FNV-1a(`bookmark.id`) → palette index for determinism.
5. **Drawer width** — wireframe is 220 px fixed. Resizable is a v2
   nice-to-have.
6. **Mobile / narrow viewports** — frontend skill mandates 320 px doesn't
   shatter. The rail can stay at 40 px, but the drawer should overlay (not
   push) at < 700 px viewport. Implement in Phase 1 CSS via a media query.
