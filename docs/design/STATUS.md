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
- [ ] **Phase 7 · Per-panel chrome via FlexLayout customisation**
- [ ] **Phase 8 · Events drawer (bookmarks)**
- [ ] **Phase 9 · Transport refinement**
- [ ] **Phase 10 · Cleanup, polish, accessibility audit**

## Where to continue

Next phase: **Phase 7 · Per-panel chrome via FlexLayout
customisation.** Read `docs/design/v1-shell-integration.md` § Phase 7
(lines 268-300) for the `onRenderTab` / `onRenderTabSet` work plus
click-to-select-panel wiring. Concretely:

1. **`onRenderTab(node, renderValues)` in `Workspace.tsx`** — replace
   `renderValues.content` with a flex row containing: grip SVG,
   panel name, kind tag (badge from `panelKindOf(node.getId())`),
   then a four-icon cluster (settings, collapse, fullscreen, close).
   Use FlexLayout's `Actions.maximizeToggle` for fullscreen and
   `Actions.deleteTab` for close. Settings calls
   `setSelectedPanelId(node.getId())` then
   `setActiveRailTab('panel')`. Set `renderValues.buttons = []` to
   suppress FlexLayout's default close icon.
2. **Click-to-select panel** — wrap each panel body in
   `panelFactory.tsx` with `<div onPointerDown={() =>
   setSelectedPanelId(panelId)}>` so any click on the panel body
   marks it selected.
3. **CSS overrides in `Workspace.module.css`** — flip
   `--color-tab-selected` from `var(--color-accent-orange)` (the
   carry-over note at `Workspace.module.css:71`) to
   `var(--color-fg-2)`; selected tabset border becomes
   `var(--color-border-hover)`, NOT orange (explicit user pushback in
   `wireframe-bundle/chats/chat1.md`).
4. **`PlotPanel.tsx:368` cursor token** — the carry-over note for
   `ctx.strokeStyle = "#f97316"` rolls into Phase 7. Read the
   computed CSS variable at draw-time
   (`getComputedStyle(...).getPropertyValue('--color-accent-orange')`).
5. **Collapse icon** — there is no first-class collapse in
   flexlayout-react. Phase 7's plan picks "grey the icon and ship
   without collapse" for the first cut; flag in the PR.
6. **`onRenderTabSet`** — empty for now (single-tab tabsets look like
   the wireframe out of the box).

The Phase 6 dev hooks (`add*Panel`, `set*ChannelBinding`) and the
Phase 5 `getSelectedPanelId` / `setSelectedPanelId` hooks are the
test seam; no new persistence adapter or schema bump expected.

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
- **Phase 7 (panel chrome)**: revisit `Workspace.module.css:71`
  (`--color-tab-selected: var(--color-accent-orange)`) — Phase 7's plan
  flips this to `var(--color-fg-2)` for the new selected-panel chrome.
  Phase 0 stayed value-preserving, so it still points to orange.
- **Phase 7 (panel chrome)**: `panels/PlotPanel.tsx:368` hardcodes
  `ctx.strokeStyle = "#f97316"` for the cursor overlay. Moving this to
  the orange token requires reading the computed CSS variable at
  draw-time (`getComputedStyle(...).getPropertyValue('--color-accent-orange')`);
  defer to Phase 7 alongside the chrome rewrite.
- **Phase 9 (Transport refinement)**: the Transport's light-theme block
  (lines 9–10, 24, 26, 36, 104, 109–129 in
  `Transport.module.css`) gets fully replaced with the dark wireframe
  styling. Don't bother token-ifying these mid-flight.
- **Palette duplication**: `panels/palette.ts` (`PLOT_PALETTE`) and
  `tokens.css` (`--plot-1..8`) hold the same 8 hex values in two
  systems. Keep them in sync if either changes; unification is not
  worth the indirection cost.
- **Drawer row primitive duplication (Phases 2/3/4)**: lifted in
  Phase 5 to `apps/web/src/shell/drawers/_row.module.css`. Sources,
  Channels, Layout, Panel, and the four Phase 6 PanelDrawer bodies all
  `composes: rowBase` from this primitive. Carry-over resolved.
