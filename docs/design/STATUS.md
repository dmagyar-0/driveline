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
- [ ] **Phase 3 · Channels drawer**
- [ ] **Phase 4 · Layout drawer**
- [ ] **Phase 5 · Panel drawer**
- [ ] **Phase 6 · New panel kinds (Scene / Map / Table / Enum)**
- [ ] **Phase 7 · Per-panel chrome via FlexLayout customisation**
- [ ] **Phase 8 · Events drawer (bookmarks)**
- [ ] **Phase 9 · Transport refinement**
- [ ] **Phase 10 · Cleanup, polish, accessibility audit**

## Where to continue

Next phase: **Phase 3 · Channels drawer.** Read
`docs/design/v1-shell-integration.md` § Phase 3 for the row layout,
group-by-source behaviour, click-to-bind-to-active-panel rules, and
search input. Concretely:

1. Create `apps/web/src/shell/drawers/ChannelsDrawer.{tsx,module.css}`.
   Read `channels` from the store via a single-key selector. Group
   rendering by `sourceId`; collapsible source headers. Within each
   group, render channel rows with swatch (`palette.ts:colorFor(channel.id)`),
   name, and dtype badge (`f64`/`f32`/`enum`/`u32`).
2. Replace the inline `channels` stub in `apps/web/src/shell/Drawer.tsx`
   (`STUBS.channels`) with `<ChannelsDrawer />`.
3. Click handler: bind to `selectedPanelId`. If the panel is a plot,
   call `addPlotChannel`; if video, call `setVideoBinding`. If no
   panel is selected, call `addPlotPanel()` then bind. Reuse store
   actions — do not introduce new ones. Note: `selectedPanelId` is in
   the `ui` slice but is not wired anywhere yet (Phase 7 owns the
   panel-chrome click-to-select). For Phase 3 the "no selected panel
   → auto-add a plot" branch is the only path that exists end-to-end;
   the explicit-bind branch is reachable from Playwright via
   `setSelectedPanelId` (add this dev hook in Phase 3).
4. Top-of-drawer search input filtering by substring on `channel.name`
   (local `useState`, not the store).
5. Lift Sources-drawer selection into the `ui` slice when the channel
   filter is implemented (see carry-over below).

The new dev hooks `listSources()` and `getGlobalRange()` exist; reuse
them when adding e2e for Phase 3. `palette.ts:colorFor`,
`formatTime.ts`, and the existing `addPlotChannel` / `setVideoBinding`
store actions cover everything Phase 3 needs — do not introduce
parallel utilities.

## Carry-over notes for later phases

- **Phase 3 (Channels drawer) — selected source lift**: Phase 2 keeps
  `SourcesDrawer`'s `selectedId` in local `useState` per integration
  plan §Phase 2.3. When Channels needs to filter rows by selected
  source, lift this to the `ui` slice as
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
