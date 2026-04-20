# Chapter 6 — The React UI and the Zustand Store

We have a Rust library that can read log files and a WASM bridge that
exposes it to JavaScript. Now we stand up the UI that the user
actually touches. This chapter walks the React entry point, the root
component, and — most importantly — the Zustand store that all the
panels subscribe to.

## Entry point

Every React app starts by attaching a component to some DOM node.
Driveline's entry point is all of twenty lines:

```tsx
// apps/web/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import {
  isWebCodecsSupported,
  renderUnsupportedSplash,
} from "./unsupportedSplash";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

if (!isWebCodecsSupported()) {
  renderUnsupportedSplash(root);
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
```

Reading it:

- The HTML shell (`apps/web/index.html`) has a single `<div
  id="root">`. The entry grabs it.
- Before anything else, it checks whether the browser supports
  **WebCodecs** — the API Chapter 9 uses for hardware video decode.
  Without it, the app would silently half-work, so we bail early with
  a dedicated unsupported-browser screen.
- `createRoot(root).render(<App />)` is the standard React 18
  incantation. It mounts `App` into the `#root` element.
- `<StrictMode>` is a React dev-mode helper that catches common
  mistakes by invoking effects twice during development. In
  production builds it's a no-op.

## The root component

`App` is the component that everything else descends from. It is a
function — components in modern React are plain functions that return
JSX. A squashed version, structural skeleton only:

```tsx
// apps/web/src/App.tsx (abbreviated)
export function App() {
  const dataCore = useRef<Remote<DataCoreApi> | null>(null);
  const videoDecode = useRef<Remote<VideoDecodeApi> | null>(null);
  const workspaceRef = useRef<WorkspaceHandle | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    dataCore.current   = makeDataCoreClient();
    videoDecode.current = makeVideoDecodeClient();
    useSession.getState().setWorker(dataCore.current);
    installPerfHooks();
    const detachPersistence = attachLayoutPersistence(useSession);
    // ... install dev hooks for Playwright ...
    setReady(true);
    return () => { detachPersistence(); };
  }, []);

  useEffect(() => startPlaybackLoop(useSession), []);

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const result = await useSession.getState().openFiles(files);
    setRecentErrors(result.errors);
  };

  return (
    <main className={styles.shell}>
      <h1>Driveline</h1>
      <p>{ready ? "workers ready" : "workers initialising"}</p>
      <div className={styles.dropZone} onDrop={onDrop} onDragOver={...} onDragLeave={...}>
        Drop .mcap, .mf4, or .mp4 (+ .mp4.ts.bin) files here
      </div>
      <SessionSummary />
      <Workspace ref={workspaceRef} />
      <Transport />
    </main>
  );
}
```

Things to notice:

- The first `useEffect` — the one with `[]` dependencies — runs
  exactly once when the component mounts. Inside it we:
  - Create the two worker clients (Chapter 7).
  - Hand the data-core worker to the Zustand store with
    `setWorker(...)`. Everything else reaches the worker through the
    store.
  - Wire up layout persistence (saves panel arrangement to
    `localStorage` so it survives reload).
- The second `useEffect` starts the playback loop — the rAF-driven
  cursor advance we'll look at in Chapter 10.
- `useRef` holds values that need to persist across renders but whose
  changes don't trigger a re-render. Worker proxies are a classic use:
  they're created once and reused.
- The returned JSX tree is the page's layout: header, drop zone,
  session summary, FlexLayout workspace, transport bar.

The real `App.tsx` is longer because it also installs a large
`window.__drivelineDevHooks` object used by Playwright tests. You can
read those hooks in the full file — they're a useful "what can you
drive from outside?" list, but they're not load-bearing for
understanding the app.

## The Zustand store

Nearly every bit of state in Driveline lives in one Zustand store,
defined in
[`apps/web/src/state/store.ts`](../../apps/web/src/state/store.ts).
Open that file — it's long but very linearly structured.

The state interface groups into three slices:

```ts
export interface SessionState {
  // --- session slice ---
  sources: SourceMeta[];
  channels: Channel[];
  globalRange: TimeRange | null;

  // --- transport slice ---
  cursorNs: bigint;
  playing: boolean;
  speed: number;

  // --- layout + bindings slice ---
  layoutJson: unknown | null;
  videoBindings: Record<string, string | null>;
  plotBindings: Record<string, string[]>;

  // --- actions ---
  openFiles(files: File[]): Promise<OpenResult>;
  clear(): Promise<void>;
  setCursor(ns: bigint): void;
  play(): void;
  pause(): void;
  setSpeed(n: number): void;
  fetchChannelRange(
    channelId: string,
    startNs: bigint, endNs: bigint,
    includePrev: boolean,
  ): Promise<Uint8Array>;
  // ... a few more actions for layout and bindings ...
}
```

### Session slice

- **`sources`** — the list of files currently loaded. Each
  `SourceMeta` carries a WASM slab handle (Chapter 5) and the channels
  that source contains.
- **`channels`** — a flattened, denormalised list of every channel
  across all sources, for easy iteration in the channel picker.
- **`globalRange`** — the `[startNs, endNs)` time range covering all
  loaded sources. `null` when no session is loaded.

### Transport slice

- **`cursorNs`** — the current playback cursor in nanoseconds UTC.
  Every panel (plot, video, transport) reads this to know what to
  display.
- **`playing`** — is playback running?
- **`speed`** — 0.25× through 4× (fixed dropdown options).

### Layout + bindings slice

- **`layoutJson`** — the serialised FlexLayout model (JSON).
  FlexLayout is the library that gives us splittable, dockable panels.
- **`videoBindings[panelId] = channelId | null`** — which video
  channel a given video panel is playing.
- **`plotBindings[panelId] = channelId[]`** — which channels a given
  plot panel is drawing. Up to eight per panel.

## Actions

Each action is a method on the store that mutates state or orchestrates
side effects.

### `openFiles(files)`

The most substantial one. Here's a shortened walkthrough:

```ts
openFiles: async (files) => {
  const { mcap, mf4, mp4Pairs, errors } = bucketFiles(files);
  const opened: string[] = [];

  // Each format opens through the worker, producing a summary that
  // we convert into a SourceMeta with the WASM slab handle.
  for (const f of mcap) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const handle = await get().worker!.openMcap(bytes);
    const summary = await get().worker!.mcapSummary(handle);
    const src = mcapSummaryToSource(f.name, handle, summary);
    set((s) => mergeSource(s, src));
    opened.push(src.id);
  }
  for (const f of mf4) { /* similar for mf4 */ }
  for (const pair of mp4Pairs) { /* similar for mp4 + sidecar */ }

  return { opened, errors };
},
```

The flow is:

1. `bucketFiles` categorises the drop by extension. See
   [`apps/web/src/state/bucket.ts`](../../apps/web/src/state/bucket.ts)
   — it pairs `foo.mp4` with `foo.mp4.ts.bin`, reports unknown
   extensions as errors.
2. For each file, read the bytes (`File.arrayBuffer()` is a standard
   browser API — it reads the drop without ever uploading anything).
3. Call the worker to open the file; receive a slab handle.
4. Call the worker again to get the summary (channels, time range).
5. Merge the new source into the store. `mergeSource` recomputes
   `globalRange` and appends the new channels.

### `setCursor(ns)`

```ts
setCursor: (ns) => {
  set((s) => {
    if (!s.globalRange) return { cursorNs: ns };
    const clamped = clampCursor(ns, s.globalRange);
    // If the cursor hit endNs while playing, auto-pause.
    const atEnd = clamped >= s.globalRange.endNs;
    return {
      cursorNs: clamped,
      ...(atEnd && s.playing ? { playing: false } : {}),
    };
  });
},
```

`set` is Zustand's mutator. It merges the returned object into the
current state. Subscribers that selected `cursorNs` or `playing` get
notified; others don't.

`clampCursor` keeps the value inside `[startNs, endNs]`. The "pause at
end" rule is enforced here so no UI code can violate it.

### `fetchChannelRange(...)`

Panels call this to get signal data for the visible window. It looks
up which source owns the channel and dispatches to the right worker
method:

```ts
fetchChannelRange: async (channelId, startNs, endNs, includePrev) => {
  const src = findOwningSource(get().sources, channelId);
  const worker = get().worker!;
  if (src.kind === "mcap") {
    return worker.mcapFetchRange(src.handle, channelId, startNs, endNs, includePrev);
  }
  return worker.mf4FetchRange(src.handle, channelId, startNs, endNs, includePrev);
},
```

Panels never know or care which format the data came from — they just
get Arrow IPC bytes back and render.

## How a component subscribes

Subscriptions use the store's hook:

```tsx
// Pick only the pieces of state this component needs.
const cursorNs = useSession((s) => s.cursorNs);
const playing  = useSession((s) => s.playing);
```

Each `useSession` call is a separate selector. The component re-renders
**only** when the selected value is different from last time (Zustand
uses `===` by default). That means a plot panel that watches
`cursorNs` does not re-render when `layoutJson` changes, and vice
versa. This is how Driveline avoids re-rendering the world on every
timeline tick.

For actions, you don't subscribe — you just read them off the getter:

```tsx
const onClick = () => useSession.getState().play();
```

Calling an action doesn't re-render the component that called it. It
mutates state, which re-renders any component that selected the
mutated field.

## The session summary, as a minimal example

The simplest real consumer in `App.tsx` is `<SessionSummary>`, which
subscribes to two slices and renders a list:

```tsx
function SessionSummary() {
  const sources     = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);

  return (
    <section>
      <p>Global range: {formatRange(globalRange)}</p>
      <p>Sources: {sources.length}</p>
      <ul>
        {sources.map((s) => (
          <li key={s.id}>
            {s.name} <span>{s.kind}</span>
            <p>{s.channels.length} channels · {formatRange(s.timeRange)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Things to notice:

- `sources.map((s) => <li key={s.id}>...</li>)` — JSX has no special
  loop construct. You use plain JavaScript: `.map` returns an array
  of elements, React renders them all.
- `key={s.id}` — React needs a stable key for every sibling in a list
  so it can diff updates correctly. Any stable unique value works.

## File layout recap

- `apps/web/src/main.tsx` — mount the app.
- `apps/web/src/App.tsx` — root component. Spawns workers, wires the
  store, renders top-level layout.
- `apps/web/src/state/store.ts` — the Zustand store.
- `apps/web/src/state/bucket.ts` — file drop → category.
- `apps/web/src/layout/Workspace.tsx` — FlexLayout integration.
- `apps/web/src/panels/` — VideoPanel, PlotPanel, and their pieces.
- `apps/web/src/timeline/` — Transport and playback loop.

Every visible UI thing ends up as a React component. Every piece of
global state lives in the store. Every file-format parsing step lives
in the data-core worker. Those three boxes are the entire application.

Chapter 7 opens up the worker boundary.
