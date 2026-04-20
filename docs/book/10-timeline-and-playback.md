# Chapter 10 — The Timeline: Cursor, Scrubber, Playback

The whole application is built around one number: `cursorNs`. Video
panels show the frame at that timestamp; plot panels draw a vertical
line there; session summaries display it. This chapter explains how
that one number is moved — by the user dragging a scrubber, by the
play/pause button, by the rAF-driven playback loop — and why every
path to moving it goes through exactly one function in the store.

## The state, recapped

From Chapter 6:

```ts
cursorNs: bigint;   // current position in nanoseconds UTC
playing: boolean;   // is playback running?
speed: number;      // 0.25× through 4×
globalRange: TimeRange | null;  // [startNs, endNs) spanning loaded sources
```

And the actions:

```ts
setCursor(ns: bigint): void;
play(): void;
pause(): void;
setSpeed(n: number): void;
```

That's the entire vocabulary.

## The clamp rule

Panels need to trust that `cursorNs` is always inside `globalRange`.
`setCursor` is the only place that enforces it (from Chapter 6):

```ts
setCursor: (ns) => {
  set((s) => {
    if (!s.globalRange) return { cursorNs: ns };
    const clamped = clampCursor(ns, s.globalRange);
    const atEnd = clamped >= s.globalRange.endNs;
    return {
      cursorNs: clamped,
      ...(atEnd && s.playing ? { playing: false } : {}),
    };
  });
},
```

Two invariants fall out of this one method:

1. **Clamp.** Any caller — scrubber, playback loop, test harness —
   passing an out-of-range `ns` gets silently corrected.
2. **Auto-pause at end.** If playback runs off the end of the session,
   the store pauses itself. The playback loop doesn't have to know
   where "end" is; it just calls `setCursor` and trusts the store.

Anywhere else in the codebase that said "if cursor ≥ endNs, pause" would
be a bug waiting to happen. Centralising it means there's one place to
get right.

## The scrubber

`Transport.tsx` renders the bottom bar: play/pause button, speed
dropdown, time readout, and a `<div>` that acts as a scrubber.
Pointer events drive it:

```tsx
const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
  if (disabled || !globalRange) return;
  const track = trackRef.current;
  if (!track) return;
  track.setPointerCapture(e.pointerId);
  scheduleCommit(nsFromRatio(ratioFromEvent(e), globalRange));
};

const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
  if (disabled || !globalRange) return;
  const track = trackRef.current;
  if (!track || !track.hasPointerCapture(e.pointerId)) return;
  scheduleCommit(nsFromRatio(ratioFromEvent(e), globalRange));
};
```

A few subtleties:

- **Pointer capture.** `track.setPointerCapture(e.pointerId)` makes all
  subsequent move events go to the track even if the cursor wanders
  off it. That's how a user can click on the track and then drag
  outside the transport bar without losing the drag.
- **`scheduleCommit`, not `setCursor`.** The raw pointer firehose can
  be > 500 events per second. Calling `setCursor` on every one would
  kick a full Zustand re-render cycle each time. Instead, the latest
  `ns` value is stashed in a ref, and a `requestAnimationFrame`
  commits it at most once per frame:

  ```tsx
  const flushPending = () => {
    if (pendingNs.current !== null) {
      useSession.getState().setCursor(pendingNs.current);
      pendingNs.current = null;
    }
    rafId.current = null;
  };

  const scheduleCommit = (ns: bigint) => {
    pendingNs.current = ns;
    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(flushPending);
    }
  };
  ```

- **Ratio math.** `nsFromRatio` maps a `[0, 1]` click position to a
  nanosecond value inside the global range, using a `Number(span)`
  round-trip. The comment flags that sessions over ~104 days would
  start to lose precision there — acceptable since Driveline's corpus
  is seconds to minutes.

## The play/pause button

Chapter 6 already showed that actions are side-effect-free mutations:

```tsx
const onClick = () => useSession.getState().play();
```

`play()` sets `playing = true`; `pause()` sets `playing = false`. They
don't start or stop any loop — the playback loop is a separate thing
that watches the store.

## The playback loop

`startPlaybackLoop` is a **plain module** — not a React hook — that
wakes up whenever `playing` or `speed` changes and advances `cursorNs`
every animation frame:

```ts
export function startPlaybackLoop(
  store: SessionStore,
  deps?: Partial<PlaybackDeps>,
): () => void {
  const { now, raf, caf } = { ...defaultDeps(), ...deps };
  let rafId: number | null = null;
  let anchor: Anchor | null = null;
  let lastWritten: bigint | null = null;
  // ...
}
```

The loop is wired up from `App.tsx` with a single call:

```tsx
useEffect(() => startPlaybackLoop(useSession), []);
```

The `deps` parameter is a testability hook. Production uses
`performance.now()` and `requestAnimationFrame`; a vitest test can
pass stub implementations and step the loop deterministically. That's
why the loop lives in a plain `.ts` module — no React means no jsdom,
and the unit tests run in Node in milliseconds.

### Anchoring against the wall clock

The obvious way to advance the cursor would be:

```ts
// Don't do this.
cursorNs += expectedNsPerFrame;
```

That accumulates error: miss a frame (GC pause, tab switch), the
cursor is behind forever.

Driveline instead **anchors** on a wall-clock moment:

```ts
interface Anchor {
  cursorNs: bigint;   // cursor position when we started
  nowMs: number;      // performance.now() at that moment
  speed: number;      // playback speed at that moment
}

function tick(): void {
  const a = anchor;
  if (!a) return;
  const state = store.getState();
  if (!state.playing) return;
  const elapsedMs = now() - a.nowMs;
  const deltaNs = BigInt(Math.round(elapsedMs * 1e6 * a.speed));
  const nextNs = a.cursorNs + deltaNs;
  lastWritten = nextNs;
  state.setCursor(nextNs);
  if (store.getState().playing && anchor !== null) {
    rafId = raf(tick);
  }
}
```

The cursor's position is always computed as `anchor.cursorNs + (now -
anchor.nowMs) × speed`. Drift is bounded by the precision of
`performance.now()`, not by frame-counting accuracy.

### Re-anchoring on external changes

Every `setCursor` call — from the playback loop itself, from the
scrubber, from a test harness — fires the same store subscription.
The loop has to tell "my own writes" from "someone scrubbed":

```ts
const unsubscribe = store.subscribe((state, prev) => {
  if (state.playing && !prev.playing) { capture(state); schedule(); return; }
  if (!state.playing && prev.playing) { cancel(); anchor = null; lastWritten = null; return; }
  if (!state.playing) return;

  if (state.speed !== prev.speed) { capture(state); return; }
  if (state.cursorNs !== prev.cursorNs && state.cursorNs !== lastWritten) {
    capture(state);   // external scrub; re-anchor
  }
});
```

`lastWritten` is the `nextNs` the loop's own `tick` passed to
`setCursor`. If the observed new cursor matches that, it was our
write; no re-anchor needed. If it differs, a scrubber or a test wrote
the store, so the anchor is invalidated and replaced.

This is why the transport bar and the playback loop can coexist: the
loop never fights the scrubber, it just quietly resets its anchor and
continues from the new value.

### Auto-pause, revisited

When the loop writes past `endNs`:

1. `setCursor(nextNs)` is called.
2. The store's reducer clamps, and — because `atEnd && playing` — sets
   `playing = false`.
3. The loop's subscribe listener sees `state.playing && !prev.playing`
   flip the other way, calls `cancel()`, drops the anchor.

Next animation frame doesn't fire. The loop is dead until the user
hits play again. No additional logic in `tick` is needed.

## Sync: how panels stay aligned

The final thing to notice is that every panel is a *subscriber*. It
reads `cursorNs` from the store, and re-renders — or, for the video
panel, redraws — whenever it changes.

- **PlotPanel**: selects `cursorNs`, draws a vertical line at the
  matching x coordinate (more in Chapter 6's overview and the
  `cursorOverlay.ts` helper).
- **VideoPanel**: reads `cursorNs` via `cursorRef.current` inside the
  rAF loop and picks the matching frame from its queue (Chapter 9).
- **Transport**: reads `cursorNs` and renders the thumb at that
  percentage of the track.

There is no "broadcast" channel, no event bus, no pub/sub. The store
is the only shared-state primitive. Every panel's re-render is
triggered directly by `cursorNs` becoming a new value.

## Recap

- One cursor, one `setCursor`. All clamping and end-of-session pausing
  lives there.
- The scrubber coalesces pointer events to one `setCursor` per
  animation frame.
- The playback loop anchors against `performance.now()` so drift is
  bounded by clock precision, not frame count.
- External scrubs re-anchor the loop; loop writes don't.
- Auto-pause is a state-machine consequence, not a special case in
  the loop.

Chapter 11, the last chapter, shows how the pieces are actually built,
tested, and shipped.
