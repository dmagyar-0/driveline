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
- [ ] **Phase 2 · Sources drawer**
- [ ] **Phase 3 · Channels drawer**
- [ ] **Phase 4 · Layout drawer**
- [ ] **Phase 5 · Panel drawer**
- [ ] **Phase 6 · New panel kinds (Scene / Map / Table / Enum)**
- [ ] **Phase 7 · Per-panel chrome via FlexLayout customisation**
- [ ] **Phase 8 · Events drawer (bookmarks)**
- [ ] **Phase 9 · Transport refinement**
- [ ] **Phase 10 · Cleanup, polish, accessibility audit**

## Where to continue

Next phase: **Phase 2 · Sources drawer.** Read
`docs/design/v1-shell-integration.md` § Phase 2 for the file list, the
swatch/kind-badge layout, and the "+ drop / load file…" affordance.
Concretely:

1. Create `apps/web/src/shell/drawers/SourcesDrawer.tsx` +
   `SourcesDrawer.module.css`. Read `sources` and `globalRange` from
   the store via discrete selectors (frontend-skill single-key rule).
   Use `panels/palette.ts:colourForId` for the swatch.
2. Replace the inline `sources` stub in
   `apps/web/src/shell/Drawer.tsx` with `<SourcesDrawer />`. Leave the
   other four stubs untouched — they're Phase 3/4/5/8.
3. Migrate `apps/e2e/tests/session-drop.spec.ts` and
   `apps/e2e/tests/videoMp4.spec.ts:158` from the legacy
   `source-count` / `source-name` / `channel-count` / `source-range` /
   `global-range` testids onto whatever testids the new drawer
   exposes (or, preferably, onto `__drivelineDevHooks.listChannels()`
   and a new `listSources()` hook to match the frontend skill's
   "hook over selector" rule).
4. Once those two specs are green against the new drawer, delete:
   - `apps/web/src/App.module.css` (entirely)
   - The `SessionSummary` function and its render shim from
     `App.tsx`
   - The `recentErrors` `useState` and the import of
     `App.module.css`
   - The `SourceMeta` / `TimeRange` / `formatRange` imports/helpers
     in `App.tsx` that only the shim used.

The `ui` slice exists; `selectedPanelId` is in place but unwired
(Phase 7 owns it). The dropzone overlay testid contract is preserved
on the Shell `<main>`. Reuse `palette.ts` and `formatTime.ts` —
do not introduce parallel utilities (frontend-skill rule).

## Carry-over notes for later phases

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
