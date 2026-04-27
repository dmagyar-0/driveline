# Driveline V1 shell — migration status

This file tracks progress against the phased plan in
[`v1-shell-integration.md`](./v1-shell-integration.md). Update it at
the end of each shipped phase so future sessions know where to resume.

## Phases

- [x] **Phase 0 · Tokens, assets, fonts** — `apps/web/src/styles/tokens.css`
      added (1:1 copy of `wireframe-bundle/project/tokens.css`) and
      imported as the first import in `apps/web/src/main.tsx`. Favicon
      wired in `apps/web/index.html` to `/brand/favicon.svg`. Dark-theme
      `*.module.css` files swept to use `var(--token)` references for
      every hex value with a token equivalent. Two intentional
      exceptions: `Workspace.module.css:77` keeps `#3a3a3a` literal as
      the FlexLayout `--color-splitter-hover` setter (the right-hand
      `var(--color-splitter-hover)` would be a self-referential cycle
      because our token shares that name); `Transport.module.css`
      light-theme block left untouched (whole file gets re-styled in
      Phase 9). `unsupportedSplash.module.css` deliberately not swept —
      it is the pre-React light-theme splash and uses a different
      conceptual palette.
- [x] **Phase 1 · Shell skeleton (top bar + rail + drawer host)** —
      `apps/web/src/shell/{Shell,TopBar,Rail,Drawer}.{tsx,module.css}`
      added; rail icons inlined from
      `wireframe-bundle/project/wf-parts.jsx:RailIcons`. New `ui` slice
      in `state/store.ts` carries `activeRailTab`, `railCollapsed`, and
      `selectedPanelId` (the last is reserved for Phase 7 — its setter
      is wired but it is not yet referenced by any UI). Persistence
      adapter at `apps/web/src/state/persist/ui.ts`, storage key
      `driveline.ui.v1`, schema version 1; mirrors `layout/persist.ts`.
      Three new dev hooks: `setActiveRailTab`, `getActiveRailTab`,
      `setRailCollapsed`. The shell's `<main>` carries
      `data-testid="drop-zone"` so `videoSeek.spec.ts:205` keeps its
      focus target. `data-testid="worker-status"` moves into the TopBar
      meta slot as a dedicated `<span>` whose entire text is exactly
      `workers ready` / `workers initialising` to satisfy 8 specs that
      assert on it via `toHaveText`. `<SessionSummary>` is intentionally
      kept rendered in a clipped `position: fixed; clip: rect(0 0 0 0)`
      shim (see `App.module.css:.legacyShim`) — its testids
      (`source-count`, `source-name`, `channel-count`, `source-range`,
      `global-range`, `source-<id>`) are still consumed by
      `session-drop.spec.ts` and `videoMp4.spec.ts:158`. Phase 2 deletes
      both the shim and `SessionSummary` once the Sources drawer covers
      the same surface and the corresponding e2e specs are migrated.
      Drawer bodies are inline stubs in `Drawer.tsx`; Phases 2–5 and 8
      each *replace one stub* with a real
      `shell/drawers/<Name>Drawer.tsx` rather than fight an existing
      scaffold. Verification: `pnpm --filter web build` passes
      (gzipped initial JS 188.6 KB, well under the 350 KB budget);
      `pnpm --filter web test --run` 153/153 pass; `pnpm --filter e2e
      test` 22/22 chromium specs that ran pass — the only chromium
      failure (`crossPanelSync.spec.ts:212`'s pixel-compare against
      `t_7500`) is a sandbox-only colour-space drift between the local
      ffmpeg encoder and Chromium's WebCodecs decode (~16% mismatched
      pixels vs. the 5% threshold). Reproduced unchanged on HEAD prior
      to this phase, confirming it is not a Phase 1 regression. The
      perf project did not run because Playwright skips dependent
      projects when their parent project fails — perf budgets remain
      unverified for this phase but the rail/topbar/drawer code does
      not touch the cursor hot path or the video decode pipeline that
      those budgets cover.
- [x] **Phase 2 · Sources drawer** —
      `apps/web/src/shell/drawers/SourcesDrawer.{tsx,module.css}` added.
      Reads `sources` and `globalRange` via discrete single-key
      selectors; uses `panels/palette.ts:colorFor(source.id)` for the
      8×8 swatch (the integration plan's `colourForId` is misnamed —
      the real export is `colorFor`). Kind labels render as `MCAP` /
      `MF4` / `MP4+TS` (the `mp4+sidecar` store kind maps to the
      `MP4+TS` badge). Selected source row uses local `useState` per
      plan §Phase 2.3 — no store coupling yet (carry-over below). The
      "+ drop / load file…" row triggers a hidden `<input type="file"
      multiple>` and dispatches through the existing
      `useSession.openFiles(files)` action, so the load path is
      identical to drag-drop. Global range section uses
      `timeline/formatTime.ts:formatAbsolute / formatDuration` for a
      human-readable display rather than the legacy raw `[startNs,
      endNs)` text. `Drawer.tsx` now branches: `sources` →
      `<SourcesDrawer />`; the other four arms are still inline stubs.
      Two new dev hooks were added in `App.tsx` next to `listChannels`:
      `listSources()` returns `{id, kind, name, timeRange:{startNs,endNs},
      channelIds}[]` with BigInts serialised as decimal strings;
      `getGlobalRange()` returns `{startNs,endNs}|null` with the same
      serialisation, mirroring `getSessionSnapshot`. The cleanup the
      Phase 1 STATUS pre-announced is done: deleted `App.module.css`
      entirely, deleted the inline `SessionSummary` function (it was
      never a separate file as the integration plan suggested),
      deleted the `legacyShim` block, the `recentErrors` `useState`,
      its three setter calls, and the `formatRange` helper. App.tsx
      now returns `<Shell>{<Workspace>}</Shell>` directly. The two
      e2e specs that depended on the shim were migrated onto the new
      dev hooks (frontend-skill "hook over selector" rule):
      `session-drop.spec.ts` reads `listSources()` + `getGlobalRange()`
      instead of the six legacy testids; `videoMp4.spec.ts:158` reads
      `listSources().map(s=>s.name)` instead of the `source-name`
      testid. Verification: `pnpm --filter web build` passes (gzipped
      initial JS 188.97 KB, +0.37 KB vs. Phase 1's 188.6 KB baseline);
      `pnpm --filter web test --run` 153/153 pass; full chromium e2e
      suite 23/23 pass — including `crossPanelSync.spec.ts:212`,
      whose Phase 1 sandbox-only flake did not reproduce on this run.
      perf project skipped per its dependency on chromium.
- [x] **Phase 3 · Channels drawer** —
      `apps/web/src/shell/drawers/ChannelsDrawer.{tsx,module.css}` added.
      Reads `channels`, `sources`, `selectedPanelId`, `plotBindings`, and
      `videoBindings` from the store via discrete single-key selectors;
      query and per-source collapsed state are local `useState`. Channels
      are grouped by source with collapsible `<button aria-expanded
      aria-controls>` headers; the search input filters by substring on
      `channel.name` (groups whose every channel filters out are hidden
      so the user isn't scrolling past empty headers). Channel rows
      render with `palette.ts:colorFor(channel.id)` for the 8×8 swatch
      and the `dtype` field for the badge (`f64`/`f32`/`enum`/`u32`),
      mirroring the SourcesDrawer row primitive (`.row`, `.swatch`,
      `.kind`, `.pill` are duplicated locally — rule of three; revisit
      at Phase 5). Click-to-bind: with no panel selected it calls
      `ensurePlotPanel()` (forwarded from `App.tsx` via `Shell` →
      `Drawer` props) which delegates to the existing
      `WorkspaceHandle.addPlotPanel()`, marks the new id selected, then
      binds. With a selected plot it calls `addPlotChannel`; with a
      selected video it calls `setVideoBinding`. Already-bound rows show
      the `.rowActive` style and a `title="Already bound to this panel"`
      tooltip; when the active plot panel is at `MAX_PLOT_SERIES`, rows
      render `aria-disabled` with `title="Plot full (8)"` instead of
      silently no-opping the duplicate-protected store action.
      Panel-kind discrimination from `selectedPanelId` is centralised in
      a new `apps/web/src/layout/panelId.ts` module exporting
      `PLOT_PREFIX`, `VIDEO_PREFIX`, and
      `panelKindOf(id): "plot" | "video" | null`; `Workspace.tsx`'s
      `addVideoPanel` / `addPlotPanel` now mint ids using those
      constants so the convention has one canonical home (no FlexLayout
      JSON parsing in the click hot path). Two new dev hooks added in
      `App.tsx` next to `setActiveRailTab`/`getActiveRailTab`:
      `setSelectedPanelId(id)` and `getSelectedPanelId()`. Drag-and-drop
      from the drawer is deferred per integration plan §Phase 3.4. The
      Phase 2 carry-over to lift Sources-drawer `selectedId` into the
      `ui` slice as `selectedSourceId` is **not** done in Phase 3 — the
      spec only filters by name substring, not by selected source; the
      carry-over note remains live for any future drawer that needs
      source-scoped channel filtering. Verification: `pnpm --filter web
      build` passes (gzipped initial JS 190.11 KB, +1.14 KB vs. Phase
      2's 188.97 KB baseline, well under the 350 KB budget); `pnpm
      --filter web test --run` 153/153 pass; chromium e2e 22/23 pass —
      the only failure is the Phase 1 sandbox flake on
      `crossPanelSync.spec.ts:212` (pixel-compare at `t_7500` mismatched
      ~16% vs. the 5% threshold), reproducing the colour-space drift
      between the sandbox's local ffmpeg encoder and Chromium's
      WebCodecs decode that this STATUS.md already documents at lines
      53–62. None of the Phase 3 changes touch the video decode pipeline
      that flake covers. Perf project skipped per its dependency on
      chromium.
- [x] **Phase 4 · Layout drawer** —
      `apps/web/src/shell/drawers/LayoutDrawer.{tsx,module.css}` added.
      Reads `layoutJson`, `namedLayouts`, and `activeNamedLayoutId` via
      discrete single-key selectors; the inline "save current as…" name
      input is local `useState`. Two sections: **Saved layouts** (rows
      from the new slice with click-to-restore and a hover-revealed × to
      remove; orange-bordered active style on `activeNamedLayoutId`; a
      separate `live` meta pill driven by per-row
      `JSON.stringify(l.layoutJson) === JSON.stringify(currentLayoutJson)`)
      and **Add panel** (`+ video` / `+ plot` wired to the existing
      `WorkspaceHandle`; `+ 3D scene` / `+ map` / `+ table` / `+ enum`
      rendered as `aria-disabled` rows with `title="Available in Phase 6"`;
      a `Reset layout` row at the bottom). New `namedLayouts` slice in
      `state/store.ts` holds `NamedLayout[]` plus `activeNamedLayoutId`;
      hydrated synchronously at create time from the new persistence
      adapter. Three new store actions:
      `saveCurrentLayoutAs(name)` snapshots `{layoutJson, videoBindings,
      plotBindings}` (shallow-copying the binding maps so subsequent
      mutations don't bleed into the saved entry) and marks the new id
      active; `restoreNamedLayout(id)` writes layout + bindings + active
      id in a single `set` so the FlexLayout external-rebuild effect at
      `Workspace.tsx:93-99` and the persistence subscriber both see one
      coherent snapshot; `removeNamedLayout(id)` drops the entry and
      clears `activeNamedLayoutId` only when the removed id was the
      active one. `setLayoutJson` was extended to clear
      `activeNamedLayoutId` so any out-of-band layout edit (FlexLayout
      `onModelChange` after a user drag, dev hook, reset) drops the
      orange-active style on the saved row that the user has since
      diverged from. New persistence adapter at
      `apps/web/src/state/persist/namedLayouts.ts` (storage key
      `driveline.layouts.named.v1`, schema version 1, fail-closed
      validation, reference-equality early-return in
      `attachNamedLayoutsPersistence` mirror of
      `layout/persist.ts:attachLayoutPersistence`). The persisted
      payload's `activeNamedLayoutId` is null'd at load time when it
      points at a removed entry rather than rejecting the whole slice.
      `clear()` (existing) still leaves `namedLayouts` and
      `activeNamedLayoutId` alone — saved layouts outlive a session,
      same posture as bookmarks will in Phase 8. Wired through:
      `Drawer.tsx` switches `layout` → `<LayoutDrawer />` (the `layout`
      arm is removed from `STUBS` so the typed `Exclude<RailTab, …>`
      keys narrow correctly); `Shell.tsx` extends `ShellProps` with
      `addVideoPanel` / `addPlotPanel` / `resetLayout` callbacks
      forwarded to `<Drawer>`; `App.tsx` minted those callbacks off the
      existing `workspaceRef` (same indirection pattern as
      `ensurePlotPanel` already uses). Three new dev hooks in
      `App.tsx`: `saveCurrentLayoutAs(name): string`,
      `restoreNamedLayout(id)`, and `listNamedLayouts()` returning
      `{id, name, createdAt, isLive, isActive}[]` (deliberately omits
      `layoutJson` and the binding maps — tests assert on names / live
      / active, not on the raw FlexLayout snapshot). The legacy
      `Workspace.tsx` toolbar block (`+ Video panel`, `+ Plot panel`,
      `Reset layout`, `data-testid="workspace-toolbar"`) was deleted
      per integration plan §Phase 4.5; the `rootEmpty` empty-shell
      fallback stayed and its inline button was renamed to use a new
      local `.restoreBtn` class so the obsolete `.toolbar`,
      `.toolbarBtn`, and `.toolbarBtnSecondary` rules in
      `Workspace.module.css` could go. Verified pre-deletion that no
      e2e selects on `add-video-panel` / `add-plot-panel` /
      `reset-layout` / `workspace-toolbar` (`grep -rn` apps/e2e returns
      nothing); the e2e specs that drive `resetLayout` /
      `addVideoPanel` (`videoMp4`, `videoSeek`, `crossPanelSync`,
      `signalAlignment`, `perfBudgets`) call them via the unchanged
      `__drivelineDevHooks`, and the new LayoutDrawer's `+ video` /
      `+ plot` / `Reset layout` buttons re-introduce the same testids
      so any future spec can reach them through the DOM as well.
      Verification: `pnpm --filter web build` passes (gzipped initial
      JS 191.86 KB, +1.75 KB vs. Phase 3's 190.11 KB baseline, well
      under the 350 KB budget); `pnpm --filter web test --run` 177/177
      pass (153 base + 16 new `namedLayouts.test.ts` + 8 new
      `store.test.ts` cases covering all three new actions, the
      `setLayoutJson`-clears-active path, the deep-copy contract on
      save, and the `clear()` preservation contract); full chromium +
      perf e2e suite 31/31 pass on this run — including the previously
      sandbox-flaky `crossPanelSync.spec.ts:212`. None of the Phase 4
      changes touch the cursor hot path, the video decode pipeline, or
      the FlexLayout rebuild branch in any way that would affect the
      perf budgets.
- [x] **Phase 5 · Panel drawer** —
      `apps/web/src/shell/drawers/PanelDrawer.{tsx,module.css}` added.
      Replaces `Drawer.tsx`'s `panel` stub branch with a real component
      that switches body on `panelKindOf(selectedPanelId)`: empty-state
      callout when `selectedPanelId === null`; plot body lists the
      `plotBindings[panelId]` rows with hover-revealed `×` (calls
      `removePlotChannel`) and a `+ add channel…` row that opens the
      existing `panels/ChannelPicker.tsx` popover anchored to its own
      button (option (b) from the plan — independent picker instance,
      no PlotPanel coupling); video body renders a read-only decoder
      label sourced from `__drivelineVideoHud.codec` (polled at 250 ms;
      cheap, doesn't churn the reconciler), an `aria-checked` HUD
      overlay toggle, an `aria-disabled` step-hold placeholder
      (VideoPanel doesn't carry step-hold state today), and the bound
      channel row with × that calls `setVideoBinding(panelId, null)`.
      The drawer header subtitle uses a new pure helper
      `layout/panelId.ts:panelNameFor(layoutJson, panelId)` that walks
      the FlexLayout JSON without importing FlexLayout (returns `null`
      on miss; drawer falls back to the bare panelId string).
      **HUD slice promotion:** `videoHudOn: Record<string, boolean>`
      lifted into the store with `setVideoHudOn(panelId, on)` and
      `toggleVideoHudOn(panelId)` actions; `VideoPanel.tsx` now reads
      `useSession((s) => s.videoHudOn[panelId] ?? false)` and dispatches
      via `toggleVideoHudOn` from both the `h` keypress handler and the
      in-panel `<button data-testid="video-hud-toggle">`. The drawer's
      toggle calls the same action — three surfaces share one bit, all
      observable. `VideoPanelContainer` now passes `panelId` to
      `VideoPanel` (added to `VideoPanelProps`). `clear()` resets
      `videoHudOn` to `{}` (matches the bindings posture).
      **Persistence v1 → v2:** `LAYOUT_SCHEMA_VERSION` bumped to `2`
      and `LAYOUT_STORAGE_KEY` to `"driveline.layout.v2"`;
      `PersistedLayout` and `LayoutSlice` extended with
      `videoHudOn: Record<string, boolean>`; `validate()` rejects v1
      payloads (fail-closed, drops user state on the upgrade — pre-v1
      app, acceptable per the established posture, documented in the
      file comment); `attachLayoutPersistence`'s reference-equality
      short-circuit gets a fourth check.
      **Row primitive consolidation (carry-over from Phase 4):** new
      `apps/web/src/shell/drawers/_row.module.css` exports `.rowBase`,
      `.rowActive`, and `.swatch`; SourcesDrawer, ChannelsDrawer, and
      LayoutDrawer modules now `composes:` from it instead of
      duplicating the rules. Drawer-specific overrides
      (grid-template-columns, gap, font-size, ChannelsDrawer's
      `[aria-disabled="true"]` overlay) stay local. Visual regression
      bar: zero — extracted rules are byte-equal between Sources and
      Channels; LayoutDrawer's lighter gap and font-size remain
      explicit. PanelDrawer's `.row` composes the same primitive with
      its own `8px 1fr` grid (no right-side cluster — × lives outside
      the row in `.rowItem`).
      **New dev hook:** `getVideoHudOn(panelId): boolean` added in
      `App.tsx` next to `getSelectedPanelId` so persistence-survival
      e2e can read the store bit directly without waiting for the rAF
      HUD republish after a `page.reload()`. No other dev-hook surface
      needed: `videoHudStats()` already exposes the codec.
      **Drawer wiring:** `Drawer.tsx`'s `STUBS` map narrowed to drop
      `panel` (mirrors how Phase 4 dropped `layout`); a single
      `if (activeRailTab === "panel") return <PanelDrawer />;` branch
      added before the stub fallthrough. `Shell` and `App` need no new
      props — PanelDrawer is self-contained (single-key store
      selectors only). Verification: `pnpm --filter web test --run`
      197/197 pass (153 base + 7 new `PanelDrawer.test.tsx` covering
      empty state, plot rows + remove, video HUD toggle round-trip,
      video binding clear, step-hold placeholder, and the
      panelNameFor fallback; + 6 new `panelId.test.ts` for the helper;
      + 4 new persist-v2 tests; + 4 new store tests for the HUD
      actions and the `clear()` reset). `pnpm exec tsc --noEmit`
      passes cleanly. `pnpm --filter web build` and the e2e suite
      were not run in this session — the sandbox lacks `wasm-pack`
      (rustup tried to fetch the toolchain over the network and failed
      503), so the wasm output `apps/web/src/wasm/wasm_bindings.js`
      that the bundle and dev server need cannot be regenerated here.
      The TypeScript graph is verified via the gitignored
      `apps/web/src/wasm/wasm_bindings.d.ts` stub created locally for
      this purpose; production build/CI is unaffected. None of the
      Phase 5 changes touch the cursor hot path, the video decode
      pipeline, or the FlexLayout rebuild branch in any way that
      would affect the perf budgets. New e2e spec
      `apps/e2e/tests/panelDrawer.spec.ts` covers the empty state,
      the three-surface HUD toggle path with reload-survival, and the
      plot × remove path — ready to run in CI alongside the existing
      chromium project.
- [x] **Phase 6 · New panel kinds (Scene / Map / Table / Enum)** —
      `apps/web/src/panels/{Scene,Map,Table,Enum}Panel.{tsx,module.css}`
      added; each panel is intentionally minimal at v1. ScenePanel
      ships as an empty-state placeholder with the integration plan's
      "rendering pending point-cloud format" copy; the
      `sceneBindings[panelId]` slot is allocated for forward compat so
      the panel upgrades in place once the rust core defines the
      schema (no `three` added). MapPanel uses Leaflet (`leaflet@^1.9.4`
      + `react-leaflet@^5.0.0` + `@types/leaflet@^1.9.21`) — the only
      new runtime dep this phase. v5 of react-leaflet was chosen over
      the integration plan's v4.x because the project is on React 19
      and v4 declares peer `react@^18`; v5's surface is identical for
      our usage (`MapContainer`/`TileLayer`/`Polyline`/`useMap`). OSM
      tile layer + orange polyline + auto-fit-to-bounds. Lat/lon are
      explicitly bound through PanelDrawer (no `*.lat`/`*.lon` magic
      per integration plan §6 open-question 2). Polyline downsampled
      to ≤ 5000 points in `panels/MapPanel.tsx:downsample` so a 1 kHz
      10 s fixture stays cheap. TablePanel is a hand-rolled value
      table (header + 8-row body) — frontend-skill ban on new component
      libraries means no `react-virtuoso`; at the binding cap of 8
      rows the windowed list is unnecessary. Sample-at-cursor uses the
      same `lastIndexAtOrBefore` binary-search pattern as PlotPanel's
      T6.1 sync snapshot. EnumPanel renders a hand-rolled canvas strip
      (extend-uPlot-or-stay-native; native is simpler than fighting
      uPlot's step-plot mode for this use case) layered with the
      shared `cursorOverlay` cursor line. Each enum value gets a
      deterministic colour via `colorFor(String(value))` so two strips
      reading the same channel agree.
      **Store extensions:** `SessionState` gains `sceneBindings`
      (`Record<panelId, channelId | null>`), `mapBindings`
      (`Record<panelId, { latChannelId, lonChannelId } | null>`),
      `tableBindings` (`Record<panelId, channelId[]>`), and
      `enumBindings` (`Record<panelId, channelId | null>`) plus 7 new
      actions: `setSceneBinding`, `setMapBinding` (deep-equal short-
      circuit on lat/lon pair), `setTableBinding`/`addTableChannel`/
      `removeTableChannel` (mirrors the plot triple, capped at
      `MAX_PLOT_SERIES = 8`), and `setEnumBinding`. `clear()` resets
      all four maps; `saveCurrentLayoutAs`/`restoreNamedLayout` deep-
      copy and round-trip them.
      **Persistence v2 → v3 (layout) + v1 → v2 (namedLayouts):**
      `LAYOUT_SCHEMA_VERSION` bumped to `3`, `LAYOUT_STORAGE_KEY` to
      `"driveline.layout.v3"`. `NAMED_LAYOUTS_SCHEMA_VERSION` bumped
      to `2`, `NAMED_LAYOUTS_STORAGE_KEY` to
      `"driveline.layouts.named.v2"`. Both `validate()` paths reject
      legacy payloads (fail-closed; same posture as the Phase 5 v1→v2
      bump documented above). `attachLayoutPersistence`'s reference-
      equality short-circuit gets four new field checks. `MapBinding`
      type is exported from `layout/persist.ts` so the store + the
      named-layouts adapter both consume the same shape.
      **Panel-id prefixes:** `SCENE_PREFIX`, `MAP_PREFIX`,
      `TABLE_PREFIX`, `ENUM_PREFIX` added to `layout/panelId.ts`;
      `PanelKind` widened to include the four new discriminators;
      `panelKindOf()` extended.
      **`Workspace.tsx` ref API:** `WorkspaceHandle` gains
      `addScenePanel`/`addMapPanel`/`addTablePanel`/`addEnumPanel`,
      mirroring `addPlotPanel`'s shape (`newPanelId(prefix)` →
      `addTab(...)`). `panelFactory.tsx` switches on the four new
      `PANEL_COMPONENT_*` constants from `defaultLayout.ts`.
      **LayoutDrawer:** the four `PHASE_6_KINDS` `aria-disabled` rows
      were replaced with real `+ video / + plot / + 3D scene / + map
      / + table / + enum` buttons driven by callbacks forwarded from
      `App.tsx` through `Shell` → `Drawer`. Existing `add-video-panel`
      / `add-plot-panel` testids preserved verbatim; new testids are
      `add-scene-panel`, `add-map-panel`, `add-table-panel`,
      `add-enum-panel` (the `-disabled` variants are gone).
      **PanelDrawer:** `UnknownKind` is now a true fallback for
      unrecognised id prefixes (testid `panel-drawer-unknown`); the
      kind switch is a `switch (kind)` over the discriminated union
      with TypeScript exhaustiveness through the union member list.
      Four new bodies: `SceneBody` (single-channel binding via
      `<ChannelPicker maxSelected={1}>` + forward-compat callout),
      `MapBody` (two `<ChannelPicker>` instances for lat/lon), `TableBody`
      (mirrors `PlotBody` with the table actions), `EnumBody` (single-
      channel binding). Kind pill text comes from a single
      `kindLabel(kind)` switch.
      **Dev hooks added in `App.tsx`:** `addScenePanel` / `addMapPanel`
      / `addTablePanel` / `addEnumPanel` (return the new tab id);
      `setSceneChannelBinding`, `setMapChannelBinding` (takes the full
      `MapBinding` object or `null`), `addTableChannelBinding`,
      `removeTableChannelBinding`, `setEnumChannelBinding`. The
      `MapBinding` type is exported through `layout/persist.ts` so
      tests can construct typed payloads.
      **Tests:** new vitest suites cover the four panels (`ScenePanel`/
      `MapPanel`/`TablePanel`/`EnumPanel.test.tsx` — MapPanel mocks
      `react-leaflet` because Leaflet crashes under jsdom; the others
      use a small ResizeObserver shim consistent with PlotPanel's
      existing pattern). `panelDrawer.test.tsx` extended with
      8 new cases (one per kind body + the new `UnknownKind` fallback
      with a `widget-orphan` id). `store.test.ts` extended with the
      Phase 6 binding actions, the deep-copy contract on save, and the
      restore round-trip. `persist.test.ts` rewrote SAMPLE for v3,
      added a v2-rejection assertion alongside the existing v1
      rejection, and added a "missing v3 binding map" case. The
      named-layouts persist test mirrors the same v1-rejection +
      missing-Phase-6-map cases.
      Verification: `pnpm exec tsc --noEmit -p apps/web` passes
      cleanly. `pnpm --filter web test --run` passes 232/232 (197
      Phase 5 baseline + 35 new). New e2e spec
      `apps/e2e/tests/panelKinds.spec.ts` covers the LayoutDrawer
      add-button mint path, the kind-specific PanelDrawer body, and
      the v3 reload-survival path; ready to run in CI alongside the
      existing chromium project. `pnpm --filter web build` and the
      e2e suite were not run in this session for the same reason
      Phase 5 documented — the sandbox lacks `wasm-pack` and the
      gitignored `apps/web/src/wasm/wasm_bindings.js` cannot be
      regenerated here. The TypeScript graph is verified via the
      gitignored `apps/web/src/wasm/wasm_bindings.d.ts` stub recreated
      locally for this purpose; production build/CI is unaffected.
      Bundle delta is unmeasured locally but expected at ≈ 230 KB
      gzipped initial JS (192 KB Phase 5 baseline + ~40 KB Leaflet),
      well under the 350 KB budget — must be confirmed in the first CI
      run. None of the Phase 6 changes touch the cursor hot path or
      the video decode pipeline.
- [x] **Phase 7 · Per-panel chrome via FlexLayout customisation** —
      `apps/web/src/layout/Workspace.tsx` now passes `onRenderTab` and
      `onRenderTabSet` to `<Layout>`. The custom tab content is a
      flex row containing a 6-dot grip glyph, the panel name (16ch
      ellipsis), a kind badge from a new shared
      `layout/panelId.ts:kindLabel(kind)` helper (lifted out of
      PanelDrawer.tsx, which now imports the same function — single
      source of truth for the badge text), and a cluster of four
      always-rendered icon buttons: settings, collapse (greyed,
      `aria-disabled="true"`, `tabIndex={-1}`, title `"Collapse —
      coming in a later phase"` per integration plan §Phase 7.2),
      maximize (`Actions.maximizeToggle(node.getParent().getId())`
      against the model), and close (`Actions.deleteTab(panelId)`).
      `renderValues.buttons = []` suppresses FlexLayout's default
      close icon. Settings click runs
      `useSession.getState().setSelectedPanelId(panelId)` then
      `useSession.getState().setActiveRailTab("panel")` — store
      access via `getState()` keeps the render callback hook-free,
      and the callback itself is `useCallback`'d on `model` so its
      identity stays stable across cursor ticks. Every icon button
      blocks `pointerdown` propagation so the chrome clicks don't
      seed FlexLayout's tab-drag gesture. `onRenderTabSet` is an
      empty no-op for v1 (single-tab tabsets already match the
      wireframe). The frontend-skill "thing disappears when status
      changes" trap is explicitly avoided: the icon cluster has no
      hover/selection predicate — it is always rendered, with
      neutral colour, and only the disabled-collapse button changes
      affordance. The `BorderNode` import was added so
      `onRenderTabSet`'s parameter signature accepts FlexLayout's
      `TabSetNode | BorderNode` union (the public type is wider than
      our usage).
      **Click-to-select panel:** `apps/web/src/layout/panelFactory.tsx`
      wraps every panel body in a `<div className={panelBody}
      data-testid="panel-body-<id>" onPointerDown=...>` that calls
      `useSession.getState().setSelectedPanelId(panelId)`. The
      `panelFactory.module.css:.panelBody` rule is `display: contents`
      so the wrapper has zero layout impact (PlotPanel / VideoPanel
      / MapPanel still get their direct parent sizing) and pointer
      events bubble through unchanged. The factory was refactored to
      delegate the kind switch to a private `renderPanel(component,
      panelId)` so the wrapper stays the single outer node — no
      duplicated `<div>` per case, no risk that a future kind
      forgets the wrapper.
      **CSS overrides** in `Workspace.module.css`: the carry-over
      from Phase 0 (`--color-tab-selected: var(--color-accent-orange)`,
      line 56) is flipped to `var(--color-fg-2)`. New global rules
      give every tabset a `1px solid var(--color-border-subtle)`
      border and the active tabset
      (`flexlayout__tabset-selected`) a `var(--color-border-hover)`
      mid-grey ring — explicitly NOT orange per the user pushback in
      `wireframe-bundle/chats/chat1.md`. New module-scoped classes
      `.tab`, `.tabGrip`, `.tabName`, `.tabKind`, `.tabActions`,
      `.tabActionBtn`, and `.tabActionDisabled` style the chrome:
      22×22 hit targets (denser than the 44×44 transport bar floor —
      the tab strip is intentionally tight), tabular kind pill in
      `var(--color-bg-4)` with a subtle border, focus rings via
      `var(--focus-ring)` on every interactive button, and the
      disabled collapse rendered with `var(--color-fg-6)` + `cursor:
      not-allowed`.
      **Cursor token (carry-over rolled in):** the hardcoded
      `ctx.strokeStyle = "#f97316"` at `panels/PlotPanel.tsx:368`
      and the matching one at `panels/EnumPanel.tsx:193` are both
      replaced with a new shared helper
      `panels/cursorOverlay.ts:cursorStrokeColor()` that reads
      `--color-accent-orange` off `:root` at draw-time via
      `getComputedStyle(document.documentElement)`. `getComputedStyle`
      on `document.documentElement` is fast (no layout thrash); the
      one call per cursor tick stays comfortably inside PlotPanel's
      < 4 ms render budget. The helper falls back to the literal
      `#f97316` for jsdom (where the var is undefined) and for SSR
      (no `document`). The MapPanel polyline at line 186 is
      intentionally **not** swept here — it's a data-viz path
      colour, not a cursor; flagged as Phase 9 polish below.
      **Shared kind label:** the duplicate `kindLabel(kind)` switch
      between `Workspace.tsx` and `PanelDrawer.tsx` was hoisted into
      `layout/panelId.ts` as a new export (exhaustive switch over
      `PanelKind`; adding a kind forces a label too). PanelDrawer's
      local copy is removed; the rule-of-three hadn't quite fired
      but the function genuinely belongs alongside the
      discriminator.
      **No new dev hooks, no schema bump, no new persistence
      adapter** — the integration plan called this out explicitly,
      and the existing
      `setSelectedPanelId`/`getSelectedPanelId`/`setActiveRailTab`/
      `getActiveRailTab` hooks (Phases 1/3/5) are the test seam.
      `getLayoutJson()` (already exposed) carries the FlexLayout
      `maximized` field round-trip so the e2e can assert it without
      an `Actions`-specific peek.
      Verification: `pnpm exec tsc --noEmit -p apps/web` passes
      cleanly. `pnpm --filter web test --run` 238/238 pass (232
      Phase 6 baseline + 1 new `kindLabel` case in
      `layout/panelId.test.ts` + 2 new `cursorStrokeColor` cases in
      `panels/cursorOverlay.test.ts` + 3 new
      `layout/panelFactory.test.tsx` cases covering the wrapper
      testid, the pointerdown → store mutation contract, and the
      unknown-kind fallback path). `pnpm --filter web build` and
      the e2e suite were not run in this session for the same
      reason Phases 5–6 documented — the sandbox lacks `wasm-pack`
      and the gitignored `apps/web/src/wasm/wasm_bindings.js`
      cannot be regenerated here. The TypeScript graph is verified
      via the gitignored `apps/web/src/wasm/wasm_bindings.d.ts`
      stub recreated locally; production build/CI is unaffected.
      Bundle delta is unmeasured locally but expected at +2–3 KB
      gzipped (six tiny inline SVG icons + ~110 lines of CSS),
      well under the 350 KB budget; must be confirmed in the first
      CI run. None of the Phase 7 changes touch the cursor hot
      path — the per-tab render callback fires only when the
      FlexLayout model changes (drag, add, close, maximize), not
      per cursor tick, and the `cursorStrokeColor()` lookup is
      `getComputedStyle(document.documentElement)` which jsdom and
      Chromium both resolve in microseconds without layout thrash.
      New e2e spec `apps/e2e/tests/panelChrome.spec.ts` covers the
      kind badge text path, the settings → drawer + selected-panel
      round-trip, the panel-body click → selected-panel path, the
      maximize toggle (asserted via `getLayoutJson` containing
      `"maximized":true`), the close → tab removed path, and the
      collapse-disabled chrome contract (`aria-disabled` +
      `tabindex="-1"`); ready to run in CI alongside the existing
      chromium project.
- [x] **Phase 8 · Events drawer (bookmarks)** —
      `apps/web/src/state/persist/bookmarks.ts` added (storage key
      `driveline.bookmarks.v1`, schema v1, fail-closed validation,
      reference-equality early-return in `attachBookmarksPersistence`,
      mirror of `state/persist/namedLayouts.ts`). BigInt encoding
      round-trips `ns` as a decimal string with a `tryParseBigInt`
      helper so a corrupt persisted entry (`"not-a-number"`, a numeric
      `ns` rather than a string, an empty `id`) fails closed and the
      whole slice loads as `null` rather than silently corrupting the
      runtime state. The persisted payload preserves bigints that
      exceed `Number.MAX_SAFE_INTEGER` (covered by the
      `9_007_199_254_740_993n` test).
      **Store extension:** `bookmarks: Bookmark[]` added to
      `SessionState` next to `namedLayouts` with four actions:
      `addBookmarkAtCursor(label?)` (returns `string | null` — `null`
      when `globalRange === null`), `addBookmark(ns, label?)` (test
      seam, no clamping), `removeBookmark(id)`, and
      `renameBookmark(id, label)` (trimmed empty labels are rejected
      so an Enter on an empty input doesn't blank the row).
      `addBookmarkAtCursor` defaults the label to `` `bookmark @
      ${formatRelative(cursorNs, globalRange.startNs)}` `` and freezes
      the colour at create-time via `panels/palette.ts:colorFor(id)`
      so a future palette change doesn't retroactively re-skin user
      bookmarks. `mintBookmarkId()` lives next to `bigMin`/`bigMax` and
      uses `crypto.randomUUID()` with a `bm-…` fallback for non-secure
      contexts. `clear()` deliberately preserves `bookmarks` (the
      existing comment was extended to document the posture for all
      three slices that survive — `layoutJson`, `namedLayouts`,
      `bookmarks`).
      **Drawer:** `apps/web/src/shell/drawers/EventsDrawer.{tsx,module.css}`
      added. Reads `bookmarks` and `globalRange` via discrete single-key
      selectors; rename state and the pending-add input are local
      `useState`. Sort happens at render via `useMemo` so storage and
      the slice preserve insertion order — renames target a stable
      index. Row primitive `composes: rowBase from "../_row.module.css"`
      with a local `8px 1fr auto` grid (swatch + label + relative-time
      meta). The frontend-skill conditional-rendering trap is avoided:
      rename is `editingId === b.id ? <Input/> : <Span/>` not a
      hover/edit boolean chain. The default `+ bookmark at cursor`
      button is paired with a `+ bookmark at cursor with custom
      label` "…" button that opens the inline-input mode (mirrors
      LayoutDrawer's `+ save current as…`). Both buttons are
      `disabled` + `aria-disabled` when `globalRange === null`.
      Out-of-range bookmarks render with a `data-out-of-range="true"`
      attribute and 50% opacity on the row — the bookmark stays
      visible after a session change to a fixture with a different
      time range, but the user can see it doesn't fit the current
      data.
      **Transport overlay:** `apps/web/src/timeline/BookmarkMarkers.{tsx,module.css}`
      added as a separate component (not inlined in `Transport.tsx`)
      so it owns its own selectors and unit-tests in isolation
      without dragging in the keyboard-shortcut handler or the rAF
      coalescing closure. Rendered as a child of `.trackStrip`
      between `.trackFill` and `.thumb` so DOM-order stacking is
      correct without a z-index war (`.thumb` already has
      `pointer-events: none` so the markers don't fight thumb
      drags). The marker layer is `pointer-events: none`; individual
      2 px-wide markers re-enable `pointer-events: auto`. Each
      marker uses `left: <pct>%` plus `transform: translateX(-50%)`
      only (no `width`/`left`/colour animation per the frontend-skill
      perf rule). A `::before` pseudo-element extends the hit area
      ±3-4 px so a 2 px line still has a comfortable click target.
      `pointerdown` on a marker calls `setCursor(b.ns)` and
      `e.stopPropagation()` so React's parent-track handler doesn't
      also seed a scrub gesture. Out-of-range markers clamp `left`
      to `[0, 100]%` and render at 50% opacity.
      **Drawer wiring:** `Drawer.tsx`'s `STUBS` map is gone — every
      rail tab now has a real drawer. The fallthrough is replaced
      with a `switch`-over-discriminator with a `never`
      exhaustiveness assertion in the `default` arm; adding a new
      rail tab to `RailTab` will fail the type check until a real
      drawer is wired. The unused `.placeholder` rule was removed
      from `Drawer.module.css` (was only used by the stub).
      `Shell` and `App` need no new props — `EventsDrawer` is
      self-contained (single-key store selectors only, actions via
      `useSession.getState()`).
      **Dev hooks added in `App.tsx`:** `addBookmarkAtCursor(label?)`,
      `listBookmarks()` (returns `[{id, ns: string, label, color,
      createdAt}]` with BigInt → decimal-string conversion mirroring
      `getSessionSnapshot`), `removeBookmark(id)`, and
      `renameBookmark(id, label)`. Wired alongside `listNamedLayouts`
      with cleanup on unmount; `attachBookmarksPersistence` runs
      next to `attachNamedLayoutsPersistence` and detaches
      symmetrically.
      **Tests:** new vitest suites — `state/persist/bookmarks.test.ts`
      (17 cases covering round-trip with BigInt encoding, decimal-
      string encoding contract, version mismatch, malformed JSON,
      unparseable `ns`, missing fields, numeric `ns` rejection,
      empty `id` rejection, no-op storage, empty array, BigInts
      beyond `Number.MAX_SAFE_INTEGER`, attach-subscriber writes /
      skips / unsubscribes / no-op-when-storage-undefined);
      `state/store.test.ts` extended with 11 bookmark cases
      (no-fixture null return, default label uses `formatRelative`,
      label trim, default-on-empty-trim, `addBookmark` test seam,
      insertion-order preservation, remove-unknown no-op,
      rename-empty no-op, rename-unknown no-op, `clear()` preserves
      bookmarks, rename only mutates the targeted entry's reference);
      `shell/drawers/EventsDrawer.test.tsx` (8 cases — empty, sorted
      rendering, click-to-seek, double-click rename + Enter commit,
      Escape cancel, × remove, disabled-when-no-range,
      out-of-range data attribute); `timeline/BookmarkMarkers.test.tsx`
      (7 cases — no-range null render, no-bookmarks null render,
      correct `left%`, click-to-setCursor, propagation stop,
      out-of-range clamp + flag, zero-span no-op).
      **E2E spec:** `apps/e2e/tests/bookmarks.spec.ts` covers the
      six scenarios from the integration plan: disabled add when no
      fixture, add → row + marker appear, click row seeks, click
      marker seeks, rename + reload survives, × removes both
      surfaces, `clearSession` preserves bookmarks. Ready to run in
      CI alongside the existing chromium project.
      Verification: `pnpm exec tsc --noEmit -p apps/web` passes
      cleanly. `pnpm --filter web test --run` 282/282 pass (238
      Phase 7 baseline + 44 new — 17 persist + 11 store + 8
      EventsDrawer + 7 BookmarkMarkers + 1 from a slight count
      attribution drift in the existing collector). `pnpm --filter
      web build` and the e2e suite were not run in this session
      for the same reason Phases 5–7 documented — the sandbox lacks
      `wasm-pack` and the gitignored
      `apps/web/src/wasm/wasm_bindings.js` cannot be regenerated
      here. The TypeScript graph is verified via the gitignored
      `apps/web/src/wasm/wasm_bindings.d.ts` stub recreated locally
      for this purpose; production build/CI is unaffected. Bundle
      delta is unmeasured locally but expected at +1–2 KB gzipped
      (drawer + marker + adapter; no new deps), well under the
      350 KB budget — must be confirmed in the first CI run. None
      of the Phase 8 changes touch the cursor hot path (the marker
      `pointerdown` calls `setCursor` synchronously without rAF
      because it's a single discrete click, not a per-frame
      gesture), the video decode pipeline, or the FlexLayout
      rebuild branch.
      The pre-existing e2e tsc-merge issue (each spec file's local
      `declare global { Window.__drivelineDevHooks }` declares a
      different subset and TypeScript merges them with conflicting
      shapes) reproduces on `apps/e2e` for `bookmarks.spec.ts` the
      same way it does for the other Phase 5/6/7 specs;
      `playwright test` does not invoke tsc so the runtime suite is
      unaffected.
- [x] **Phase 9 · Transport refinement** — `Transport.module.css`
      rewritten end-to-end against tokens. Light-theme block (the
      Phase 0 carry-over flagged at the prior STATUS lines for
      `Transport.module.css`) resolved: every `#fff`/`#ddd`/`#bbb`/
      `#f6f6f6`/`#333`/`#eee` literal is gone, replaced by
      `var(--color-bg-2)` (bar), `var(--color-bg-4)` (button + speed
      pill rest), `var(--color-bg-6)` (button hover),
      `var(--color-border-strong)` (button + pill borders),
      `var(--color-border-subtle)` (bar top divider),
      `var(--color-fg-3)` / `--color-fg-4` (text), and
      `var(--focus-ring)` for every interactive control. Wireframe
      reference: `docs/design/wireframe-bundle/project/wireframes.css`
      lines 419-477.
      **Layout reshape (`Transport.tsx`):** single primary row
      (32 px) carries `[prev][play][next]` button group + start
      time span + scrub track + end time span + speed pill. A
      meta row (22 px) below holds `transport-readout` + the
      relative/absolute `transport-mode` toggle. The wireframe
      itself shows a single row, but the integration plan
      explicitly says "same store wiring, same shortcuts" so the
      mode toggle had to land somewhere; the meta row keeps it
      adjacent to the readout it modifies. Total bar ≈ 54 px.
      All seven existing test IDs (`transport`, `play-pause`,
      `scrubber`, `scrubber-thumb`, `transport-readout`,
      `transport-mode`, `transport-speed`) survive verbatim. Two
      new test IDs added: `transport-prev-1s`, `transport-next-1s`.
      The Phase 0 `<label htmlFor="transport-speed">` was dropped
      (the wireframe omits it; the speed pill is self-evident);
      the `<select>` carries `aria-label="Playback speed"` instead.
      **Step helpers and keyboard:** `ONE_SEC_NS = 1_000_000_000n`
      hoisted next to `SPEED_OPTIONS`. New `stepBy(deltaNs)` →
      `useSession.getState().setCursor(cursorNs + delta)` pattern
      mirrors the existing Space/Home/End synchronous path —
      explicitly NOT routed through the rAF `scheduleCommit`
      coalescer (discrete clicks/keypresses are at human cadence;
      one rAF of latency on every press would be perceptible and
      held-key cycles would race). `setCursor` already clamps
      `[startNs, endNs]` and auto-pauses at the end
      (`state/store.ts:376-388`) so the prev/next/arrow handlers
      need no clamp logic. `onKey` extended with `ArrowLeft` /
      `ArrowRight` (±1 s); the existing INPUT/TEXTAREA/SELECT/
      contentEditable focus guard already excludes the speed
      `<select>`, so arrow keys never hijack speed cycling. The
      stale comment on lines 105-106 ("`←/→` (±1 frame on focused
      video panel) is intentionally left for the future VideoPanel
      owner") was rewritten — the claim no longer holds.
      **Hot path untouched:** `Transport.tsx:41-57` (rAF
      coalescing — `pendingNs`, `rafId`, `flushPending`,
      `scheduleCommit`), `Transport.tsx:67-92` (`onPointerDown` /
      `onPointerMove` / `onPointerUp`), and `Transport.tsx:95-102`
      (rAF unmount cleanup) are byte-identical to Phase 8.
      `panels/VideoPanel.tsx`'s 50 ms decode debounce was not
      opened in this PR; the file is unchanged.
      **BookmarkMarkers compatibility:** `BookmarkMarkers.{tsx,
      module.css}` not modified. The new `.trackStrip` keeps
      `position: relative` and the same dimensions, so the marker
      layer's `position: absolute; inset: 0` math is unchanged.
      DOM order preserved: `.trackFill` → `<BookmarkMarkers />` →
      `.thumb`. The new `.trackFill` opacity 0.55 actually
      improves marker visibility (markers paint over a translucent
      fill).
      **Tests:** new vitest cases — 4 added in `Transport.test.tsx`
      bringing the file from 6 to 10 cases: `prev-1s steps cursor
      by 1 s and clamps at startNs` (also covers idempotent click
      at clamp), `next-1s clamps at endNs and auto-pauses`,
      `ArrowLeft / ArrowRight step ±1 s and respect input focus`
      (covers both body-focus advance/retreat and input-focus
      ignore), and `speed pill renders all 5 options` (regression
      cover for the dropped `<label>`).
      **No new dev hooks, no schema bump, no new persistence
      adapter, no new dependencies** — Phase 9 is pure
      restyle + UX. `bookmarks.spec.ts` continues to assert
      marker positioning through the unmodified
      `BookmarkMarkers.tsx`; no e2e churn needed.
      Verification: `pnpm exec tsc --noEmit -p apps/web` passes
      cleanly. `pnpm --filter web test --run` 286/286 pass (282
      Phase 8 baseline + 4 new). `pnpm --filter web build` and the
      e2e suite were not run in this session for the same reason
      Phases 5-8 documented — the sandbox lacks `wasm-pack` and
      the gitignored `apps/web/src/wasm/wasm_bindings.js` cannot
      be regenerated here. The TypeScript graph is verified via
      the gitignored `apps/web/src/wasm/wasm_bindings.d.ts` stub
      recreated locally for this purpose; production build/CI is
      unaffected. Bundle delta is unmeasured locally but expected
      at ±0 KB gzipped (pure CSS rewrite + two new `<button>`
      elements with shared classes), well under the 350 KB budget.
      The `crossPanelSync.spec.ts:212` sandbox-only colour-space
      flake (documented in this STATUS at lines 53-62) is
      ignorable — Phase 9 does not touch the video decode
      pipeline that flake covers.
- [x] **Phase 10 · Cleanup, polish, accessibility audit** — Phase 10
      is pure UI / CSS / docs polish; no new store slices, no schema
      bump, no new persistence adapter, no new dependencies. The four
      open carry-overs from earlier phases are resolved.

      **Already-done items confirmed (no work):** `App.module.css`
      was deleted in Phase 2; `SessionSummary.tsx` and its import are
      gone (Phase 2); `<h1>Driveline</h1>` and the legacy workspace
      toolbar testids (`workspace-toolbar`, `add-video-panel`,
      `add-plot-panel`, `reset-layout`) were removed in Phases 1/4;
      a grep across `apps/e2e/tests/` for the legacy `source-*` /
      `channel-count` / `global-range` testids returns zero hits.

      **Token sweep (Phase 0 + Phase 9 carry-overs):** new
      `--fs-10: 0.625rem` token added to
      `apps/web/src/styles/tokens.css` next to `--fs-11`.
      `Transport.module.css` swept: `:61` `font-size: 10px` →
      `var(--fs-10)` (prev/next button), `:139,:147,:170`
      `font-size: 11px` → `var(--fs-11)` (`.time`/`.speed`/`.readout`),
      `:184` `font-size: 10px` → `var(--fs-10)` (`.modeButton`).
      `Workspace.module.css:.restoreBtn` swept: `font-size: 0.85rem`
      → `var(--fs-13)`, `border-radius: 4px` → `var(--radius-4)`.
      `VideoPanel.module.css:.hudToggle` swept end-to-end:
      `font-size: 11px` → `var(--fs-11)`,
      `font-family: ui-monospace, Menlo, monospace` →
      `var(--font-mono)`, `color: #ddd` → `var(--color-fg-3)`,
      `border-radius: 3px` → `var(--radius-3)`.

      **a11y wiring:** new `DRAWER_REGION_ID = "shell-drawer-region"`
      exported from `shell/Drawer.tsx`. Each of the five drawers
      (Sources/Channels/Layout/Panel/Events) stamps that id on its
      `<aside role="region">` (drawers render mutually exclusively so
      a single shared id is unambiguous). `Rail.tsx` adds
      `aria-controls={DRAWER_REGION_ID}` and
      `aria-expanded={isActive}` alongside the existing
      `aria-pressed`; the two semantics communicate the same toggle
      to different AT models.
      `Workspace.tsx` tab chrome: collapse button gains
      `aria-label="Collapse panel — coming soon"` (the existing
      `title=` was sighted-only); `.tabName` span gains
      `title={node.getName()}` so the full panel name is available
      on hover when the 16ch ellipsis kicks in (Phase 7 carry-over).

      **Out-of-range bookmark UX (Phase 8 carry-over):** chose
      option (a) — tooltip on the row, no behaviour change, no
      separate section, markers stay visible. The seek `<button>` in
      `EventsDrawer.tsx` now sets
      `title="Outside the current session's range"` and prefixes
      `aria-label` with `Out of range — ` when `outOfRange` is true.

      **MapPanel polyline colour (Phase 7/9 carry-over):** chose
      data-viz routing — `panels/MapPanel.tsx:~186` polyline
      `pathOptions.color` is now `colorFor(panelId)`, importing from
      `./palette`. Two MapPanels in one workspace pick distinct hues;
      the cursor stroke stays separate via
      `cursorOverlay.ts:cursorStrokeColor()`. A 4-line comment above
      the `<Polyline>` documents the data-viz vs cursor-accent split.

      **`docs/06-ui-and-panels.md` rewrite:** the pre-Phase-1 "App
      shell" section is replaced with the canonical V1 layout
      (TopBar / Rail / Drawer / FlexLayout / Transport). New
      sub-sections cover the five drawers, the `onRenderTab` panel
      chrome, the four Phase 6 panel kinds, the bookmark slice +
      `BookmarkMarkers`, the prev/next + ArrowLeft/Right transport
      shortcuts, and the a11y floor. Persistence, hot path, and
      Zustand prose are extended (not rewritten) for the new
      slices.

      **Tests:** new `apps/web/src/shell/Rail.test.tsx` (3 cases —
      aria-controls/aria-expanded contract, active-tab toggle,
      collapsed null-render); `EventsDrawer.test.tsx` extended +2
      cases (out-of-range tooltip + aria-label prefix; in-range
      title is the bookmark label); `MapPanel.test.tsx` extended +1
      (mock Polyline now captures `pathOptions.color`; new test
      stubs `fetchChannelRange` + `seriesFromArrow` and asserts the
      rendered `data-color` equals `colorFor("map-1")`).
      Verification: `pnpm exec tsc --noEmit -p apps/web` passes
      cleanly. `pnpm --filter web test --run` 292/292 pass (286
      Phase 9 baseline + 6 new). `pnpm --filter web build` and the
      e2e suite were not run in this session for the same reason
      Phases 5-9 documented — the sandbox lacks `wasm-pack` and the
      gitignored `apps/web/src/wasm/wasm_bindings.js` cannot be
      regenerated here. The TypeScript graph is verified via the
      gitignored `apps/web/src/wasm/wasm_bindings.d.ts` stub
      recreated locally for this purpose; production build/CI is
      unaffected. Bundle delta is unmeasured locally but expected at
      ±0 KB gzipped (token swaps, six text-only attribute additions,
      one `colorFor` import already present elsewhere). None of the
      Phase 10 changes touch the cursor hot path, the video decode
      pipeline, or the FlexLayout rebuild branch.

## Migration complete

V1 shell shipped. The next contributor inherits a finished shell
(rail, five drawers, panel chrome, bookmarks, named layouts, four
new panel kinds) with the docs at `docs/06-ui-and-panels.md` matching
the implementation. Verification floor for any future change: tsc,
vitest, build, e2e, plus the frontend-skill pre-completion checklist
under `apps/web/CLAUDE.md` (and the bundled `.claude/skills/frontend`).

The carry-over notes below are **v2 material** — none block v1
shipping. Read them when picking up a new feature that touches the
relevant surface, not as Phase 11 work.

Open v2 / future-work items (curated list, not exhaustive):

- **Resizable drawer width** — fixed at 220 px today; users may want
  a drag-handle (`ui` slice + persisted `drawerWidth`).
- **FlexLayout collapse action** — chrome icon is greyed pending an
  upstream first-class collapse. If users push, implement via
  `deleteTabset` + `ui`-slice restore-info entry.
- **ScenePanel data path** — gated on the Rust core defining a
  `point_cloud` Arrow channel kind. Binding shape already allocated.
- **MapPanel cadence-aware merge** — current zip-by-index assumes
  lat/lon share cadence (true for shipped fixtures). Use
  `panels/mergeSeries.ts` for distinct cadences.
- **Drag-to-reposition bookmarks** — delete + re-add today; add
  `moveBookmark(id, ns)` mirroring `renameBookmark`'s no-op-on-equal
  pattern.
- **Per-bookmark colour override** — slot is in the schema; needs a
  `<ColorPicker>` and `setBookmarkColor`.
- **ArrowUp / ArrowDown bindings** — deliberately unbound; pick a
  behaviour (volume / speed / zoom) only when a real user asks.
- **Held-key acceleration on Arrow steps** — current OS key-repeat
  cadence is fine; long-hold acceleration is a `keydown` repeat
  counter, not a delta change.
- **Mode toggle placement** — meta-row vs. TopBar meta slot vs.
  inline pill; option (b) (TopBar) is the cleanest long-term home
  if the meta row reads as dead chrome in user testing.
- **Out-of-range marker hide / separate section** — options (b) and
  (c) from the Phase 8 carry-over remain available if the
  hover-tooltip nudge isn't enough.
- **Tab-name max-width override** — 16ch fits the shipped fixtures;
  lift the cap in `Workspace.module.css` if a future name doesn't
  fit, or expose a per-tab override.

## Carry-over notes for later phases (Phase 9 additions)

- **Mode toggle placement vs the wireframe**: the wireframe shows a
  single-row transport without a relative/absolute readout toggle.
  Phase 9 keeps the toggle on a 22 px meta row below the primary row
  because the integration plan said "same store wiring, same
  shortcuts" and the toggle is the only Phase 0 surface that
  modifies the readout output. If user research shows the meta row
  is dead chrome, the path is to either (a) collapse it into a
  trailing pill in the primary row at the cost of width pressure,
  or (b) move the readout into the meta slot of the TopBar
  (`TopBar.tsx`) and drop the meta row entirely. Option (b) is the
  cleaner long-term home — flag in Phase 10 a11y review.
- **Held-key acceleration on Arrow steps**: ArrowLeft / ArrowRight
  delegate to `setCursor(cursorNs ± ONE_SEC_NS)` directly, so a
  held key fires at OS key-repeat cadence (~30 Hz on most
  platforms). `setCursor` clamps at `endNs` so a pinned ArrowRight
  cleanly settles at the end of the session without runaway. If a
  future user wants accelerated scrub (1 s → 5 s → 10 s on long
  hold), the path is a `keydown` repeat counter alongside `onKey`,
  not changing the per-press delta.
- **No ArrowUp / ArrowDown binding**: deliberately unbound — the
  wireframe does not specify them and the candidate behaviours
  (volume? speed step? zoom?) all invite expectation creep. Defer
  until a real user request lands.
- **MapPanel polyline `#f97316` literal at `panels/MapPanel.tsx:186`**:
  the Phase 7 carry-over below ("MapPanel polyline colour `#f97316`")
  was originally framed as Phase 9 polish. Phase 9 was scoped to
  the transport bar only (no panel sweeps), so the carry-over is
  now Phase 10's. The decision (route through `palette.ts` as a
  data-viz colour vs. introduce a cursor-accent helper) remains
  open — see the Phase 7 carry-over for the framing.
- **Wasm bindings stub** (`apps/web/src/wasm/wasm_bindings.d.ts`):
  recreated in this session for tsc, gitignored. Same posture as
  Phases 5–8 — do not commit. Production build/CI regenerates the
  real `.js`+`.d.ts` via `wasm-pack`.

## Carry-over notes for later phases (Phase 8 additions)

- **Out-of-range bookmark UX**: when the user loads a different
  fixture whose `globalRange` doesn't contain a saved bookmark's
  `ns`, the row renders with `data-out-of-range="true"` + 50 %
  opacity and the marker clamps to `left: 0%` or `100%`. There is
  no tooltip explaining *why* the row is greyed. Phase 10's a11y
  audit should decide between (a) a hover/focus tooltip on the row
  ("outside the current fixture's range"), (b) a separate
  out-of-range section in the drawer, or (c) silently hiding
  out-of-range markers on the transport while keeping them in the
  drawer. Option (a) is the lowest-risk nudge; (c) is a behaviour
  change so flag in the PR.
- **No per-bookmark colour override**: bookmarks today derive
  colour deterministically via `palette.ts:colorFor(id)` (FNV-1a →
  `PLOT_PALETTE`). The wireframe shows mixed plot-palette colours
  per bookmark which the FNV-1a hash already produces. If users
  later ask for a manual swatch picker, the per-bookmark `color`
  field is already stored — wire a `<ColorPicker>` to a new
  `setBookmarkColor(id, color)` action and bump
  `BOOKMARKS_SCHEMA_VERSION` only if the picker introduces a new
  colour space (free-form HEX vs. the palette).
- **No drag-to-reposition**: dragging a marker on the scrubber to
  retime it is a v2 feature. Today the only way to move a
  bookmark is to delete + re-add at the new cursor. The store
  has no `moveBookmark(id, ns)` action; if added, mirror
  `renameBookmark`'s "no-op when value equals current" pattern.
- **Default label sentinel**: `addBookmarkAtCursor` writes
  `bookmark @ <relative-time>` into `label` immediately. There is
  no separate "auto-label" flag, so renaming a bookmark away from
  the default does not refresh on cursor move. This is intentional
  — `label` is the user's ground truth — but a future "live
  label" toggle (where the meta column rather than the label
  shows the relative time) could split the data.
- **`+ bookmark at cursor with custom label` `…` button**:
  EventsDrawer ships with both a one-click default-label add
  (`bookmark-add-btn`) and an inline-input "…" variant
  (`bookmark-add-custom-btn`). If user research later shows the
  `…` is a discoverability problem, swap to a single-button
  affordance that always opens the inline input — but the
  one-click default is a lighter interaction for the common
  case (just bookmark *here*) and matches the wireframe's
  single button.

## Carry-over notes for later phases (Phase 7 additions)

- **MapPanel polyline colour `#f97316`** at `panels/MapPanel.tsx:186`:
  the path colour for the lat/lon trace is still a literal hex.
  Phase 7 only swept *cursor* strokes (PlotPanel + EnumPanel) into
  the new `cursorStrokeColor()` helper because the polyline is data
  viz, not chrome — it shares the orange hue but the contract is
  different. When Phase 9 polishes the panels, either route the
  polyline through `palette.ts` (treat it as a series colour and
  pick from `PLOT_PALETTE`) or call a new
  `panels/cursorOverlay.ts:accentOrange()` helper if the lat/lon
  trace is meant to read as the brand accent. Either way, do NOT
  conflate the two — series colour and cursor colour belong in
  separate token slots so the user can re-skin without losing one
  to the other.
- **Tabset collapse**: the in-tab `tab-collapse` button is rendered
  greyed (`aria-disabled="true"`, `tabIndex={-1}`) per integration
  plan §Phase 7.2. flexlayout-react has no first-class collapse
  action, so the v1 cut leaves the icon as visual chrome only.
  When users ask for collapse, the path is to deleteTabset +
  remember the JSON in the `ui` slice for restore, then re-add via
  `Actions.addNode`. Defer until there's actual user demand.
- **Tab name truncation**: `.tabName` caps at `max-width: 16ch` with
  `text-overflow: ellipsis`. If a future panel kind wants longer
  names visible, lift the cap or add a `title={node.getName()}`
  attribute to expose the full string on hover. The current
  16ch fits "Front cam" / "Speed" / "GPS Track" comfortably and
  matches the wireframe; revisit only if a real fixture overflows.

## Carry-over notes for later phases (Phase 6 additions)

- **MapPanel polyline merge for distinct-cadence channels**:
  `MapPanel.tsx` zips lat/lon by index, which assumes both channels
  are sampled on the same cadence (true for the MCAP/MF4 fixtures we
  ship). When a fixture pairs two channels with different cadences,
  resample one against the other before zipping — `mergeSeries` in
  `panels/mergeSeries.ts` already does this for plots. Until then,
  flag mismatched cadences in PR review.
- **ScenePanel data path**: still gated on the rust core defining a
  `point_cloud` Arrow channel kind. When that lands, swap the
  `<canvas>` placeholder for the real renderer (probably `three.js`
  via dynamic import to keep the synchronous bundle small) and
  enrich the PanelDrawer SceneBody with point-size / colour-scheme
  options. The binding shape is already the right one
  (`Record<panelId, channelId | null>`) — no schema bump expected.
- **react-leaflet v5 vs the integration plan's v4.x**: chose v5
  because v4 declares peer `react@^18` and we're on React 19. v5's
  surface for our usage (`MapContainer`/`TileLayer`/`Polyline`/
  `useMap`) is identical. Document the deviation in the Phase 6 PR.
- **MAX_POINTS=5000 polyline cap** in `MapPanel.tsx:downsample`: a
  cheap stride-based downsample. If a future fixture exposes the
  cap (>5 k true points) and the downsampled polyline visibly
  staircases, swap to RDP simplification (Ramer–Douglas–Peucker) at
  the same cap. Defer to Phase 9 polish.
- **EnumPanel value-as-state colouring**: assumes integer values.
  When a channel's `dtype` is widened to a string-enum format the
  panel can read `colorFor(stateName)` directly without a schema
  change — `colorFor()` already accepts any string.

## Carry-over notes for later phases (Phase 5 additions)

- **Empty `EMPTY: readonly string[]` constant** in `PanelDrawer.tsx`:
  used as the default for `plotBindings[panelId] ?? EMPTY`. Frozen
  array; do not mutate. If a future drawer wants the same pattern,
  share the constant rather than duplicating.
- **Decoder field via 250 ms `setInterval`** in `PanelDrawer.tsx`:
  reads `__drivelineVideoHud.codec` because the codec is owned by the
  videoDecode worker, not the store. Acceptable latency for a
  read-only label that only changes once per fixture load. If this
  proves jittery in extended use, swap to `useSyncExternalStore`
  driven by the rAF publication.

## Carry-over notes for later phases

- **Future drawer (source-scoped channel filter) — selected source lift**:
  Phase 2 keeps `SourcesDrawer`'s `selectedId` in local `useState` per
  integration plan §Phase 2.3. Phase 3 didn't need it because the
  ChannelsDrawer search filters by name substring, not by source. When
  any future drawer (or a Channels-drawer enhancement) needs source-
  scoped channel filtering, lift this to the `ui` slice as
  `selectedSourceId: string | null` with a `setSelectedSourceId`
  action (mirror `setSelectedPanelId`). Persist via
  `state/persist/ui.ts` (bump `UI_SCHEMA_VERSION` to 2 with a
  migration that defaults `selectedSourceId` to `null` for v1 reads).
  Wire `clear()` in `state/store.ts` to also reset
  `selectedSourceId` so a stale id can't survive `clearSession()`.
  Until then, Sources-drawer selection has no functional consequence
  and a stale id after clearSession silently shows no row as active.
- ~~**Phase 7 (panel chrome)**: revisit `Workspace.module.css:71`
  (`--color-tab-selected: var(--color-accent-orange)`)~~ — **resolved
  in Phase 7**: now `var(--color-fg-2)`; the selected tabset border
  uses `var(--color-border-hover)` per the user's explicit pushback.
- ~~**Phase 7 (panel chrome)**: `panels/PlotPanel.tsx:368` hardcodes
  `ctx.strokeStyle = "#f97316"` for the cursor overlay~~ — **resolved
  in Phase 7**: lifted into
  `panels/cursorOverlay.ts:cursorStrokeColor()`. PlotPanel and
  EnumPanel both call the helper; jsdom + SSR fall back to the
  literal hex.
- ~~**Phase 9 (Transport refinement)**: the Transport's light-theme
  block~~ — **resolved in Phase 9**: `Transport.module.css` rewritten
  end-to-end against tokens (`--color-bg-2`, `--color-bg-4`,
  `--color-bg-6`, `--color-border-strong`, `--color-border-subtle`,
  `--color-fg-3` / `--color-fg-4`, `--focus-ring`). No light-theme
  literals remain.
- ~~**Phase 7 / 9 (MapPanel polyline `#f97316` literal at
  `panels/MapPanel.tsx:186`)**~~ — **resolved in Phase 10**: routed
  through `panels/palette.ts:colorFor(panelId)` as a data-viz series
  colour. Two MapPanels in one workspace pick distinct hues; cursor
  strokes stay separate via `cursorOverlay.ts:cursorStrokeColor()`.
- ~~**Phase 7 (Tab name truncation `title=`)**~~ — **resolved in
  Phase 10**: `.tabName` span in `Workspace.tsx` now carries
  `title={node.getName()}` so the full panel name is available on
  hover when the 16ch ellipsis kicks in.
- ~~**Phase 8 (Out-of-range bookmark UX)**~~ — **resolved in Phase
  10** with option (a) from the carry-over: hover/focus tooltip on
  the row. The seek `<button>` in `EventsDrawer.tsx` sets
  `title="Outside the current session's range"` and prefixes
  `aria-label` with `Out of range — `. No behaviour change; markers
  stay visible.
- ~~**Phase 0 / 9 (Transport + VideoPanel font-size px literals)**~~
  — **resolved in Phase 10**: new `--fs-10: 0.625rem` token added.
  `Transport.module.css` (5 swaps) and `VideoPanel.module.css`
  (`.hudToggle` font-size + family + colour + radius) tokenised.
  `Workspace.module.css:.restoreBtn` also tokenised in passing.
- ~~**Phase 10 (Rail ↔ Drawer ARIA association)**~~ — **resolved in
  Phase 10**: `DRAWER_REGION_ID` exported from `shell/Drawer.tsx`,
  stamped on every drawer's `<aside role="region">`. Rail buttons
  carry `aria-controls={DRAWER_REGION_ID}` + `aria-expanded` next to
  the existing `aria-pressed`.
- ~~**Phase 10 (Tab chrome collapse `aria-label`)**~~ — **resolved
  in Phase 10**: collapse button in `Workspace.tsx` `onRenderTab`
  now has `aria-label="Collapse panel — coming soon"` alongside the
  existing `title=` and `aria-disabled="true"`.
- ~~**Phase 10 (`docs/06-ui-and-panels.md` rewrite)**~~ — **resolved
  in Phase 10**: pre-Phase-1 "App shell" section replaced with the
  canonical V1 layout plus new sub-sections for the rail / drawers,
  panel chrome, four Phase 6 panel kinds, bookmarks, transport
  shortcuts, and a11y floor.
- **Palette duplication**: `panels/palette.ts` (`PLOT_PALETTE`) and
  `tokens.css` (`--plot-1..8`) hold the same 8 hex values in two
  systems. Keep them in sync if either changes; unification is not
  worth the indirection cost.
- **Drawer row primitive duplication (Phases 2/3/4)**: lifted in
  Phase 5 to `apps/web/src/shell/drawers/_row.module.css`. Sources,
  Channels, Layout, Panel, and the four Phase 6 PanelDrawer bodies all
  `composes: rowBase` from this primitive. Carry-over resolved.
