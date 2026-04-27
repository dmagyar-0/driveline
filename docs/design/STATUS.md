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
- [ ] **Phase 5 · Panel drawer**
- [ ] **Phase 6 · New panel kinds (Scene / Map / Table / Enum)**
- [ ] **Phase 7 · Per-panel chrome via FlexLayout customisation**
- [ ] **Phase 8 · Events drawer (bookmarks)**
- [ ] **Phase 9 · Transport refinement**
- [ ] **Phase 10 · Cleanup, polish, accessibility audit**

## Where to continue

Next phase: **Phase 5 · Panel drawer.** Read
`docs/design/v1-shell-integration.md` § Phase 5 (lines 201-222) for
the per-panel settings drawer that switches body on the selected
panel's kind. Concretely:

1. Create `apps/web/src/shell/drawers/PanelDrawer.{tsx,module.css}`.
   Replace `Drawer.tsx`'s `STUBS.panel` arm with `<PanelDrawer />`.
   Read `selectedPanelId` via a single-key selector and discriminate
   on it with the existing `layout/panelId.ts:panelKindOf` (added in
   Phase 3) — no FlexLayout JSON parsing needed for plot/video.
2. **Empty state** — when `selectedPanelId === null`, render a
   compact callout: "Select a panel to configure it" with a hint to
   click any panel header. The actual click-to-select wiring lands in
   Phase 7 (`onPointerDown` on the panel container in
   `panelFactory.tsx`); for Phase 5 the e2e spec drives selection via
   `setSelectedPanelId(id)` (already a dev hook).
3. **Plot kind body** — list each `plotBindings[panelId]` channel with
   the swatch + `removePlotChannel` × button (mirror the row primitive
   from `ChannelsDrawer.module.css:.row` per rule-of-three). `+ add
   channel…` reuses the existing `panels/ChannelPicker.tsx` popover so
   we don't reimplement the picker.
4. **Video kind body** — show `decoder` (read-only label sourced from
   `videoHudStats().codec` if a fixture is loaded, otherwise "—"),
   the bound channel under "Channels in panel" with a × that calls
   `setVideoBinding(panelId, null)`, and a `step-hold` /
   `HUD overlay` toggle pair. The HUD toggle currently lives as a
   per-panel ref in `VideoPanel.tsx` (`hudOn` state); Phase 5
   promotes it to the store keyed by panel id (new
   `videoHudOn: Record<panelId, boolean>` slice, default `false`,
   persisted via the existing layout adapter — bump
   `LAYOUT_SCHEMA_VERSION` to 2 and migrate v1 reads with a default).
   `step-hold` is a similar one-bit-per-panel knob if it exists in
   `VideoPanel`; otherwise defer it to the same slice.
5. **3D / Map / Table / Enum kind bodies** — render kind-specific
   minimal options per integration plan §Phase 5.3 bullet 3, but
   stub them as "Configured in Phase 6" callouts since the panel
   implementations land then. The discrimination just needs new
   prefixes/checks in `layout/panelId.ts:panelKindOf` once Phase 6
   mints them.
6. Add dev hook(s) only if a body needs an internal-state observation
   that DOM can't cover: `videoHudStats().hudOn` already exposes the
   HUD bit, so the Panel drawer's HUD toggle is observable; no new
   hook needed for Phase 5.
7. The integration plan calls out Phase 7 as the right place to
   actually wire `onClick`/`onFocus` on each panel container to set
   `selectedPanelId`. Phase 5 ships with selection driven only by
   the dev hook + (eventually) a settings icon click; the manual UX
   path lights up in Phase 7.

The Phase 4 dev hooks (`saveCurrentLayoutAs`, `restoreNamedLayout`,
`listNamedLayouts`) and the existing
`setSelectedPanelId`/`getSelectedPanelId` cover everything Phase 5
needs to test programmatically. No new persistence adapter unless the
HUD slice lands in Phase 5 — if it does, fold it into the existing
`layout/persist.ts` schema bump rather than introducing a new adapter
file.

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
- **Drawer row primitive duplication (Phases 2/3/4)**: `SourcesDrawer`,
  `ChannelsDrawer`, and `LayoutDrawer` each duplicate the `.row` /
  `.rowActive` / `.swatch` / `.kind` rule set locally per the explicit
  rule-of-three deferral first noted in Phase 2 STATUS. With three
  copies now live (Phase 4 takes the count to three for `.row` /
  `.rowActive` / `.kind` / 8×8 swatch — though LayoutDrawer's rows
  carry no swatch), Phase 5's PanelDrawer would push to four. Lift the
  shared primitive to `apps/web/src/shell/drawers/_row.module.css`
  (or a `<DrawerRow>` component if the markup also stabilises) at the
  start of Phase 5 before duplicating again. Keep the orange-active
  border-left + rounded right corners exactly as-is; the visual is
  consistent across all three current drawers.
