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
- [ ] **Phase 1 · Shell skeleton (top bar + rail + drawer host)**
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

Next phase: **Phase 1 · Shell skeleton.** Read
`docs/design/v1-shell-integration.md` § Phase 1 for the file list, store
slice shape, and dev hooks to add. The `ui` slice and persist adapter
(`apps/web/src/state/persist/ui.ts`) are introduced in this phase —
keep selectors single-key (`useSession((s) => s.activeRailTab)`) per
the frontend skill rules; BigInts as decimal strings in storage if any
bigint state ends up in the slice.

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
