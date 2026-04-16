# 06 — UI and Panels

## UI stack

- **React 18** + **TypeScript**, built with **Vite**.
- **FlexLayout** (`flexlayout-react`) for dockable, resizable, serialisable
  panels.
- **Zustand** for global UI state. A single store; slices by concern.
- **uPlot** for signal plotting.
- **CSS Modules** for styling. No Tailwind, no CSS-in-JS — keep the bundle
  lean.

No UI component library. The app is small and opinionated; hand-rolled
controls keep styling under our control and the bundle small.

## App shell

```
┌──────────────────────────────────────────────────────────────┐
│  Top bar: file drop hint, loaded sources, settings menu      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                     FlexLayout work area                     │
│  ┌──────────────────────────┐ ┌────────────────────────────┐ │
│  │        VideoPanel        │ │         PlotPanel          │ │
│  │        (active)          │ │                            │ │
│  │                          │ │                            │ │
│  └──────────────────────────┘ └────────────────────────────┘ │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Transport bar                                               │
│  ◀◀  ▶/❚❚  ▶▶    ──●──────────────────   00:03.412 / 00:10   │
│  speed [1×▾]   cursor [absolute | relative]                  │
└──────────────────────────────────────────────────────────────┘
```

- The **top bar** shows the basename of loaded sources and an "Add file"
  button. Drag-and-drop anywhere in the window also works.
- The **work area** holds panels. Default layout on first open is a
  50/50 horizontal split with `VideoPanel` on the left and `PlotPanel`
  on the right.
- The **transport bar** is a global singleton (not a panel) so it is
  always visible and cannot be accidentally closed.

## Zustand store shape

```ts
// src/state/store.ts (shape only — no implementation in this phase)
interface DrivelineStore {
  // session
  sources: SourceMeta[];
  channels: Channel[];
  globalRange: TimeRange | null;

  // transport
  cursorNs: i64;
  playing: boolean;
  speed: number;             // 0.25 .. 4.0
  cursorMode: 'absolute' | 'relative';

  // panel selection / bindings
  videoBindings: Record<PanelId, ChannelId | null>;
  plotBindings: Record<PanelId, ChannelId[]>;

  // layout (opaque FlexLayout JSON)
  layoutJson: unknown;

  // actions
  openSource(blob: Blob, kind: SourceKind, sidecar?: Blob): Promise<void>;
  closeSource(id: SourceId): void;
  setCursor(ns: i64): void;
  play(): void;
  pause(): void;
  setSpeed(n: number): void;
  bindVideoPanel(panel: PanelId, channel: ChannelId): void;
  bindPlotPanel(panel: PanelId, channels: ChannelId[]): void;
}
```

Why Zustand:

- Tiny (~1 KB), no provider boilerplate, no context-induced re-renders.
- Selectors let each panel subscribe only to what it needs
  (`useStore(s => s.cursorNs)` — a panel re-renders only when the cursor
  changes).
- Side-effectful actions live in the store next to state; no extra
  middleware for our needs.

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
5. `PlotPanel` redraws its cursor overlay immediately — it is cheap and
   the data is already in-canvas.

## Panels

### VideoPanel

- Single `<canvas>` sized to the panel's content box; resize observer
  re-sets canvas dimensions on resize.
- Subscribes to the bound `channelId` and to `cursorNs`.
- On mount: asks `videoDecode` worker to `open(channelId)`.
- Receives `VideoFrame` objects via a `MessagePort`; blits with
  `canvas.getContext('2d').drawImage(frame, 0, 0, w, h)`.
  - For zero-copy on Chrome, `OffscreenCanvas` + `canvas.transferControlToOffscreen()`
    would be ideal; MVP uses the simple path and revisits if blit time is
    an issue.
- Keyboard when focused: `Space` toggles play, `←/→` step one frame,
  `Shift+←/→` step one keyframe, `,`/`.` nudge cursor ±1 ms.
- HUD overlay (toggleable): current PTS, frame index, decode queue
  length, dropped-frame counter.

### PlotPanel

- `<canvas>` managed by uPlot.
- Subscribes to the bound `channelId[]` and to `cursorNs` and to the
  panel's visible `xRange` (starts equal to `globalRange`).
- Data fetch:
  - On bind or on `xRange` change, call `dataCore.fetch_range(channelId,
    t0, t1, { max_points: canvas_px_width * 2 })`.
  - Receive Arrow IPC bytes; parse via `apache-arrow` JS; hand
    `[ts_array, value_array]` to uPlot as a Float64 series.
  - Cache the last fetched batch; re-fetch on pan/zoom beyond the cached
    window with a small overscan.
- Cursor overlay is a vertical line at `cursorNs` projected to pixel X,
  drawn on a second canvas layered over uPlot's (so we never rebuild the
  plot on cursor tick).
- Multi-series overlay: up to N channels per panel (MVP cap: 8). Colour
  assignment is deterministic by channel id.
- Panel controls:
  - Channel picker (tree view of sources → channels) in a popover.
  - Y-axis autoscale toggle; fixed range input.
  - Step-hold vs. linear interpolation toggle (default step-hold).

### Transport bar

Not a FlexLayout panel, a global overlay anchored to the bottom.

- Play / Pause / Stop.
- Scrubber: a full-width timeline showing the global range, with the
  cursor as a vertical line and a draggable thumb.
- Time readout: absolute (`YYYY-MM-DD HH:MM:SS.mmm`) or relative
  (`HH:MM:SS.mmm` from session start), toggled by the user.
- Speed dropdown: 0.25×, 0.5×, 1×, 2×, 4×.
- Keyboard shortcuts (global): `Space` play/pause; `Home`/`End` jump to
  session start/end; `←/→` ±1 frame on focused video panel.

## FlexLayout integration

- Layout JSON lives in the store as `layoutJson`.
- On mount, initial layout comes from `localStorage` (key:
  `driveline.layout.v1`) or the default horizontal split.
- On every layout change, serialise and persist.
- Panel factory maps a `component` string in FlexLayout's tab config to
  the React component: `"video"` → `VideoPanel`, `"plot"` → `PlotPanel`.
- Users can add panels via a `+` button on the work area header.

## Drag-and-drop ingest

- The whole app is a drop target. On drop:
  - Collect `File`s, bucket by extension (`.mcap`, `.mf4`, `.mp4`,
    `.mp4.ts.bin`).
  - `.mcap` and `.mf4` files open immediately.
  - `.mp4` files wait for their matching `.mp4.ts.bin` (or the user is
    prompted). Once paired, open as `mp4+ts` source.
- Errors surface as toast notifications (basename + reason).

## Non-goals for UI (MVP)

- No theme switcher. Default dark mode only.
- No i18n.
- No accessibility audit pass beyond basic keyboard navigation and
  contrast; formal a11y is post-MVP.
- No URL state sync / shareable session links.
- No per-panel settings persistence beyond bindings + layout.
