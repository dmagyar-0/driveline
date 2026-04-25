---
name: frontend
description: Driveline-specific frontend playbook for React/TypeScript UI work in apps/web. Use this skill whenever you touch a .tsx/.ts/.css file under apps/web/, add or modify a panel, change Zustand state shape or selectors, wire a web worker, adjust the FlexLayout shell, edit the Transport/scrubber, expose a new Playwright dev hook, or evaluate a screenshot of the app. Captures hard rules on stack choices, performance budgets for the cursor/video hot path, conditional-rendering anti-patterns, accessibility minimums, and the project's Playwright-via-window-hooks testing pattern.
---

# Frontend (driveline)

A browser-first multimodal log viewer for synchronised 4K video and high-rate
signal data. The UI exists to keep two things honest: **the cursor and the
data behind it.** Everything else — chrome, decoration, motion — defers to
that.

## Stack snapshot — what's in the box, what's banned

In the box:

- **React 19** + **TypeScript** + **Vite 6** in `apps/web/`
- **CSS Modules** (`*.module.css`) — no global styles outside reset/tokens
- **Zustand** (`apps/web/src/state/store.ts`) — single store, sliced by concern
- **FlexLayout** (`flexlayout-react`) for dockable panels
- **uPlot** for signal plotting (`PlotPanel`)
- **Comlink** wrapping web workers (`workers/`, `workerClient.ts`)
- **Apache Arrow** IPC across the Rust ⇄ JS worker boundary
- **Vitest** + `@testing-library/react` + `jsdom` for unit/component
- **Playwright** in `apps/e2e/` driving the page through `window.__drivelineDevHooks`

Banned without an explicit, written reason in the PR:

- ❌ Tailwind, styled-components, Emotion, vanilla-extract, any CSS-in-JS
- ❌ A UI component library (MUI, shadcn, Radix, Mantine, Chakra, Ant) —
  controls are hand-rolled to keep the bundle tight and styling under our
  control (see `docs/06-ui-and-panels.md`)
- ❌ Adding a global state library next to Zustand (Redux, Jotai, Recoil)
- ❌ A new charting library next to uPlot — extend uPlot or stay native
- ❌ `any`, `// @ts-ignore`, non-null assertion `!` on store values, or
  `as unknown as` casts to silence the type checker
- ❌ Inline styles for anything beyond layout-driven dynamic values (a
  width/height computed from container size is fine; a color is not)
- ❌ Tailwind-style utility classes invented in CSS Modules (`.mt-4`,
  `.flex-row`) — name by purpose, not by property

If the user asks for something that requires a banned tool, push back once
and ask before adding the dependency.

## Five questions before code (direction lock)

For any non-trivial UI change, answer these in chat — out loud, briefly —
before editing files. Don't ask the user; commit to a direction and let them
push back.

1. **Who needs this and when in the workflow?** (loading a session,
   scrubbing, comparing two channels, debugging a dropped frame)
2. **What is the one thing that must stay correct under load?** (cursor
   stays in sync with video; plot doesn't lose the live data point;
   layout survives a reload)
3. **Where does this live?** Panel? Transport? Top bar? A new dialog?
   Default to extending an existing surface before introducing a new one.
4. **What state does it touch?** Existing store slice, new slice, panel-
   local `useState`, or a ref that bypasses React entirely (hot path)?
5. **How will Playwright assert it?** Through an existing dev hook, a new
   one, or a visible DOM signal? If the answer is "it can't," the design
   is wrong — fix it now, not later.

## Hard rules

### State

- **Single Zustand store**, sliced by concern (`session`, `transport`,
  `bindings`, `layout`). New top-level state goes into the appropriate slice
  or starts a new one — never a parallel store.
- **Selectors over object spreads.** `useSession((s) => s.cursorNs)` — not
  `const { cursorNs } = useSession()`. The latter re-renders on any change.
- **Actions live next to state.** No external `dispatch` files; mutate via
  `set` inside the store.
- **BigInt everywhere for time.** `cursorNs`, `startNs`, `endNs` are
  `bigint`. Convert to `Number` only at the rendering boundary and only when
  you have proven the magnitude is safe (`Number(ns / 1_000_000n)` for ms).
  Never `parseInt` a BigInt.
- **Dev hooks read state via the store, not via React.** See the
  `getSessionSnapshot` pattern in `App.tsx` — serialise BigInts as strings
  so `page.evaluate` can return them.

### The cursor hot path

The scrubber is the highest-frequency UI in the app. Treat it with care:

- `setCursor(ns)` schedules a single rAF tick if one is not pending. Do
  **not** call `set({ cursorNs })` directly from a `pointermove` handler.
- `VideoPanel` adds a 50ms trailing debounce before issuing a decode seek.
  Don't remove this without measuring; without it, scrubbing thrashes the
  decoder.
- Subscribers should read **only** what they need. A panel that displays
  formatted time should subscribe to `cursorNs`, not the whole transport
  slice.
- Pointer math (X → ns) lives in the scrubber component, not the store.
  The store doesn't know about pixels.

### Components

- **One component per file**, file named for the component
  (`PlotPanel.tsx`, `PlotPanel.module.css`, `PlotPanel.test.tsx`).
- **No prop drilling for store data.** A panel reaches into the store
  itself with a selector. Pass props for things the parent owns (panel id,
  binding) — not for things the store owns (cursor, playing).
- **Refs for the imperative bits** (uPlot instance, `<video>` element,
  WebCodecs decoder). Never store a DOM node or a uPlot instance in
  Zustand or React state — they're not serialisable and they trigger
  spurious re-renders.
- **Effects clean up.** rAF, `addEventListener`, `ResizeObserver`,
  `setInterval`, comlink subscriptions — every one needs a cleanup return.
  Reviewer checks this on every PR.
- **No `useEffect` for derived state.** Derive in render, memo if
  expensive. `useEffect` is for synchronising with something outside React
  (the DOM, a worker, a timer, the store).

### Workers

- All worker calls go through `workerClient.ts`. Don't `new Worker()`
  outside that module.
- Transferable buffers (`ArrayBuffer`, `MessagePort`) — pass via
  `Comlink.transfer` so we don't structured-clone megabytes of Arrow.
- The dev hook surface (`window.__drivelineDevHooks`) is the API contract
  for tests. Adding a hook is a deliberate act — name it after the
  observation it enables (`videoLastBlitPtsNs`, `videoHudStats`), not the
  internal call.

### CSS

- One `*.module.css` next to the component. Class names are camelCase and
  describe the role (`.scrubberThumb`, not `.thumb` or `.mr-2`).
- Tokens live in `App.module.css` / `:root` if global, in the local module
  if scoped. No magic numbers in three places — promote to a token.
- **Animate `transform` and `opacity` only.** Never `transition: all`,
  never animate `width`/`top`/`left`/`color`/`background` on a hot path.
- Honour `prefers-reduced-motion` for any animation longer than the
  150ms you'd use for a button press.
- One CSS strategy: CSS Modules. Don't introduce inline `<style>` tags,
  `styled-jsx`, or a global utility sheet.

### Conditional rendering — the trap that breaks panels

The single most common UI bug pattern in this app is "thing disappears
when status changes." Never write fragile boolean chains for conditional
rendering of stateful surfaces:

```tsx
// BAD — image vanishes the moment status leaves 'ready'
{imageUrl && status === 'ready' && <Thumbnail src={imageUrl} />}

// BAD — implicit assumption: 'every other status hides this'
{state.playing && state.cursorNs > 0n && <LiveBadge />}
```

Be explicit about which states show the surface. Either an inclusion
list or a separate predicate that names the intent:

```tsx
// GOOD — inclusion list, change is one line and grep-able
const STATUSES_WITH_THUMBNAIL: readonly SourceStatus[] = [
  'ready', 'reloading', 'stale',
];
{imageUrl && STATUSES_WITH_THUMBNAIL.includes(status) && <Thumbnail src={imageUrl} />}

// GOOD — named predicate makes the intent reviewable
const showLiveBadge = isPlaying && hasValidCursor && !isSeeking;
{showLiveBadge && <LiveBadge />}
```

When state has more than three orthogonal flags, model it as a discriminated
union and `switch` on the discriminator with a TypeScript exhaustiveness
check (`const _exhaustive: never = state;`). Status explosions (>7 string
codes for one entity) are a smell — split into orthogonal axes (e.g.
`{ load: 'idle' | 'loading' | 'error', sync: 'fresh' | 'stale' }`).

### Accessibility minimums

These are the floor, not the ceiling. Failing one of these blocks merge:

- **Keyboard:** every interactive control reachable by Tab. Visible
  `:focus-visible` ring (`outline: 2px solid currentColor; outline-offset: 2px`
  is the default — override only with something equally visible).
- **Targets:** clickable region ≥ 44×44px on the transport bar (these are
  used on touch laptops). Tighter spacing is fine inside dropdowns where
  the whole row is the target.
- **Contrast:** body text ≥ 4.5:1, large text and icon-only buttons ≥ 3:1
  against their background. Don't put light grey on white because it looks
  "minimal."
- **Semantics:** one `<h1>` per route; landmark regions (`<header>`,
  `<main>`, `<footer>`); icon-only buttons get `aria-label`.
- **Motion:** every animation > 150ms has a `prefers-reduced-motion: reduce`
  fallback that completes immediately. The video panel itself is exempt
  (it's content, not chrome).
- **Color is never the sole signal.** Plot series get a marker shape or a
  legend pip in addition to colour. Error states get an icon and text.
- **Body font ≥ 16px.** No `px` font sizes; use `rem` so the user's zoom
  preference works.

### Performance budgets (the ones we measure)

- Cursor scrub: `cursorNs` updates ≤ 1 per rAF (~16ms). PlotPanel and
  Transport re-render in < 4ms each at 1080p with ~5 channels.
- Video seek-to-blit: target P50 < 120ms, P95 < 250ms with the test
  fixture. Watch `videoHudStats().decodeQueue` in Playwright traces.
- Initial JS payload: ≤ 350KB gzipped (hard ceiling 500KB). The wasm
  bundle is separate and not counted here. Measure with `pnpm build` —
  check for an unexpected library entering the manifest.
- Layout reload: workspace JSON applies in < 50ms (no flash of empty panels).
- LCP (when measuring on the loaded-fixture state): < 2.5s; CLS: < 0.1
  (the FlexLayout shell is fully laid out on first paint — don't add
  components that resize after data arrives).

If a change affects any of these, run the relevant test or capture a
trace and put the numbers in the commit message.

## Visualisation rules (uPlot, scales, signals)

- **Choose the chart by the question, not the look.** The default for
  driveline is line plot vs. time. Bar/area variants are warranted only
  when the data is actually categorical or cumulative — say so in a
  comment.
- **Time axis is always shared.** All plots in a session use the same ns
  scale derived from `globalRange`. Don't introduce a per-panel time axis
  — that's how cursors desync.
- **Y axes are per-channel.** Auto-scale once on load, then freeze unless
  the user explicitly re-fits. Constant rescaling makes signals
  unreadable.
- **Downsample at the worker boundary**, not in React. The Rust core
  produces pre-bucketed Arrow. The panel maps Arrow → uPlot series; it
  does not iterate raw samples in JS.
- **Series colour comes from `palette.ts`.** Don't pick colours per
  binding; the palette is deterministic and colour-blind safe.
- **Cursor overlay is one `<canvas>` on top of all plots**, driven by
  `cursorOverlay.ts`. Don't reimplement the overlay per panel.

## Playwright workflow (the driveline-specific way)

Driveline tests via `window.__drivelineDevHooks` instead of fragile DOM
selectors. The pattern is **arrange via the store, observe via the DOM
or via a snapshot hook.**

Read `references/playwright.md` for the full recipe library before adding
a new e2e. The condensed rules:

1. **Run the test once before reading the source.** `pnpm --filter e2e test`
   exits non-zero with a useful trace; let it tell you what's missing.
2. **Wait for `networkidle` after navigation.** The wasm module loads
   asynchronously. Without this you race the worker boot.
3. **Use a hook over a selector when one exists.** `getSessionSnapshot()`
   is more honest than asserting a formatted timestamp string. Add a hook
   if the assertion you want needs internal state.
4. **BigInts cross `page.evaluate` as strings.** Always serialise on the
   page side: `cursorNs: snap.cursorNs.toString()`. Convert back in Node
   with `BigInt(...)`.
5. **Fixtures live in `test-fixtures/`.** Don't generate fixtures inside
   the test — load them via `openFiles(...)` so the path matches
   production.
6. **Screenshots only when comparing layout.** Functional assertions go
   through hooks. A pixel diff is a last resort, scoped tightly with
   `clip:`.

## Pre-completion checklist

Before declaring a UI change done, walk this list. Don't skip — most of
these are 10-second checks that catch real bugs.

- [ ] Type check passes: `pnpm --filter web build` (it runs `tsc --noEmit`)
- [ ] Unit tests pass: `pnpm --filter web test --run`
- [ ] Affected e2e passes: `pnpm --filter e2e test` (or the relevant spec)
- [ ] No new `any`, `// @ts-ignore`, or `as unknown as` introduced
- [ ] No new dependency added without justification
- [ ] Manually opened the dev server, dragged in a fixture, exercised the
      golden path of the change. If you cannot run the browser, say so
      explicitly in the PR — do not claim "tested" from a passing build.
- [ ] At 320px wide the layout doesn't shatter (FlexLayout collapses
      gracefully or the change is gated for a min-width)
- [ ] Tab through the new controls — every one has a visible focus ring
- [ ] Re-rendered the route with `prefers-reduced-motion: reduce` if you
      added motion
- [ ] Bundle didn't grow more than ~10KB gzipped without a reason in the
      commit message
- [ ] The change is observable from a Playwright hook or a DOM signal
      (you'd be able to write the e2e for it)

## Calibrating "good design" for a tool

Most generic frontend advice is written for marketing pages and AI
artifacts: "pick an extreme aesthetic," "asymmetric layouts," "noise
overlays," "custom cursors." None of that applies here. Driveline is an
instrument. Apply the *anti*-slop rules but skip the maximalist ones:

- Stay restrained. The signal data is the visual content; chrome should
  recede. Generous whitespace and tight typography over decoration.
- Distinct typography is fine; reflex defaults (Inter, Roboto, Arial) are
  not. Use a body font that handles tabular numerals well — the transport
  bar shows a lot of numbers.
- No purple-to-blue gradients, no glassmorphism, no soft drop shadows on
  every card, no centered three-card hero rows. Those tells are how this
  app would look like an AI-generated demo instead of a tool.
- Colour: a neutral surface palette plus a small set of saturated accent
  colours reserved for the plot series. The chrome stays out of the
  series colour space so accents don't fight signal colour.
- Density beats prettiness in a control surface. The transport bar
  should fit the next playback control without a redesign.

## When in doubt

- Read `docs/06-ui-and-panels.md` for the canonical UI design.
- Read `docs/02-architecture.md` for where the boundaries live.
- Read `apps/web/src/App.tsx` for the dev-hook surface to mirror.
- For Playwright recipes specific to this codebase, see
  `references/playwright.md` next to this file.
