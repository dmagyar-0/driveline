# Chapter 7 — Web Workers and Comlink

The last two chapters skirted around a crucial fact: the WASM module and
the video decoder don't run on the same JavaScript thread as the React
UI. They run in **Web Workers**. This chapter explains why, what a
worker actually is, and how Driveline talks to them without turning its
source code into a pile of `postMessage` handlers.

## Why workers?

A browser tab has a single main thread. If your JavaScript takes 200 ms
to run, the page freezes for 200 ms — no mouse clicks, no animations,
no scrolling. Parsing a 200 MB MCAP file or decoding a 4K H.264 frame
easily blows through that budget.

A **Web Worker** is a separate OS thread that runs JavaScript (and
WebAssembly) in isolation from the main thread. It has its own memory,
its own event loop, and no access to the DOM. The only way to talk to
it is by posting messages back and forth.

Driveline has two workers:

- **`dataCore`** — hosts the WASM module (Chapter 5). Every file-format
  read happens here. The main thread never loads wasm directly.
- **`videoDecode`** — owns a `VideoDecoder` (Chapter 9) and turns
  encoded H.264 chunks into `VideoFrame` objects for the canvas.

Keeping both off the main thread means scrubbing stays buttery even
while a huge MF4 is being parsed in the background.

## Spawning a worker

Vite (the build tool, Chapter 11) understands this one-liner:

```ts
// apps/web/src/workerClient.ts
const worker = new Worker(
  new URL("./workers/dataCore.worker.ts", import.meta.url),
  { type: "module", name: "dataCore" },
);
```

Three things are happening:

- `new URL("./workers/dataCore.worker.ts", import.meta.url)` is the
  standard browser way to point at a sibling module. Vite notices the
  pattern, bundles the worker as its own chunk, and rewrites the URL
  at build time.
- `{ type: "module" }` opts into **module workers**, which means the
  worker can use ES `import` statements just like any other file.
- `name: "dataCore"` is a debugging aid — it shows up in Chrome
  DevTools' Threads panel.

## The problem with `postMessage`

The native worker API is blunt: `worker.postMessage(thing)` fires a
message, `worker.onmessage = (ev) => ...` receives one. Every
request/response round-trip has to invent its own `id`, its own
reply-correlation scheme, its own error channel. A project with thirty
worker-side functions ends up shaped like a hand-rolled RPC protocol.

## Comlink

**Comlink** is a very small library (one file, a couple of kilobytes)
that makes a worker *look* like a local object. The worker side
declares an API; the main side wraps the worker in a proxy and calls
methods on it as if they were regular async functions.

The worker side, at the bottom of `dataCore.worker.ts`:

```ts
import * as Comlink from "comlink";

export const dataCoreApi = {
  async ping(): Promise<string> { /* ... */ },
  async openMf4(bytes: Uint8Array): Promise<number> { /* ... */ },
  // ... thirty more methods ...
};

export type DataCoreApi = typeof dataCoreApi;

Comlink.expose(dataCoreApi);
```

`Comlink.expose` registers a `message` listener that interprets
incoming calls, runs the matching method, and posts the result back.

The main-thread side:

```ts
// apps/web/src/workerClient.ts
export function makeDataCoreClient(): Comlink.Remote<DataCoreApi> {
  const worker = new Worker(
    new URL("./workers/dataCore.worker.ts", import.meta.url),
    { type: "module", name: "dataCore" },
  );
  return Comlink.wrap<DataCoreApi>(worker);
}
```

`Comlink.wrap` returns a **proxy object** whose methods mirror the
worker's API. Every method call is automatically serialised, posted,
awaited, and deserialised. From the caller's point of view:

```ts
const dc = makeDataCoreClient();
const handle = await dc.openMcap(bytes);   // looks local; actually crossing a thread
const summary = await dc.mcapSummary(handle);
```

The `Remote<T>` type wrapper makes every method on `T` async (return a
Promise) so the type system matches reality. That's why every store
action in Chapter 6 used `await get().worker!.openMcap(...)` — it's
async because *it has to hop threads*, not because the underlying Rust
code is async.

## The async-before-ready dance

Look at the very top of `dataCore.worker.ts`:

```ts
// Register the Comlink listener BEFORE awaiting wasm init. A top-level await
// here would suspend module evaluation; any messages posted by the main
// thread during that window fire on an empty listener list and are lost.
// Each API method awaits the init promise instead.
const ready = init();

export const dataCoreApi = {
  async ping(): Promise<string> {
    await ready;
    return wasmPing();
  },
  // ...
};

Comlink.expose(dataCoreApi);
```

`init()` loads and instantiates the WASM module (Chapter 5) — a
promise that settles a few milliseconds after the worker boots. But
the comment points out a subtle trap: if the module-top did
`await init()`, the whole module's evaluation would pause, and the
`Comlink.expose` call at the bottom wouldn't run until after that
await. Any message the main thread sent during that gap would land on
an unregistered listener and vanish.

So: `Comlink.expose` runs synchronously at module load, and every
method privately awaits the same shared `ready` promise before touching
wasm. Since `ready` resolves exactly once, the wait is a no-op after
the first call.

## Normalising the wire

Not every value makes it across `postMessage` intact. `serde-wasm-
bindgen` (Chapter 5) may encode a 64-bit integer as either a JS
`number` or a `bigint` depending on whether the value fits in
`Number.MAX_SAFE_INTEGER`. The worker normalises at the edge so the
main thread never has to care:

```ts
function toBig(n: unknown): bigint {
  return typeof n === "bigint" ? n : BigInt(n as number | string);
}

function normaliseMf4(raw: RawMf4Summary): Mf4Summary {
  return {
    start_ns: toBig(raw.start_ns),
    end_ns: toBig(raw.end_ns),
    channels: raw.channels.map((c) => ({
      ...c,
      sample_count: Number(c.sample_count),
      start_ns: toBig(c.start_ns),
      end_ns: toBig(c.end_ns),
    })),
  };
}
```

Every `Summary` method runs its result through one of these before
returning. That's why every store-level type (Chapter 6) can declare
`startNs: bigint` with confidence.

## Two workers, one slab

A less obvious problem: the videoDecode worker needs to *pull encoded
chunks* from a source that was opened on the dataCore worker. But
remember from Chapter 5 that each worker has its own WASM module with
its own slab of open files. If videoDecode instantiated its own
`dataCore.worker.ts`, the slab would be empty and every handle would
miss.

The fix is a **MessagePort bridge**. The main thread creates a
`MessageChannel` — a pair of ports — exposes a tiny relay API on port
1, and hands port 2 to the videoDecode worker. Comlink happily wraps
either end.

Here's the relevant bit of `VideoPanel.tsx`:

```tsx
const dc = useSession.getState().getWorker();       // main-thread Remote<DataCoreApi>
const bridge = new MessageChannel();
const relay = {
  openMcapVideoStream: (h, c, p) => dc!.openMcapVideoStream(h, c, p),
  mcapVideoNextBatch:  (s, m)    => dc!.mcapVideoNextBatch(s, m),
  closeMcapVideoStream:(s)       => dc!.closeMcapVideoStream(s),
  // ... same for mp4 ...
};
Comlink.expose(relay, bridge.port1);

await videoDecode.setDataCorePort(
  Comlink.transfer(bridge.port2, [bridge.port2]),
);
```

- `Comlink.expose(relay, bridge.port1)` — the main thread hosts a tiny
  RPC server on `port1` whose methods forward to the real dataCore.
- `Comlink.transfer(bridge.port2, [bridge.port2])` — posts the other
  port *by transfer*, not by copy. `MessagePort` is a transferable
  type: only one thread can own it at a time. After this call, the
  main thread has lost it; the videoDecode worker now owns it.
- Inside `videoDecode.worker.ts`:
  ```ts
  setDataCorePort(port: MessagePort): void {
    dataCore = Comlink.wrap<DataCorePortApi>(port);
  }
  ```
  It wraps the incoming port and treats it like any other Comlink
  remote. Under the hood, every call tunnels back through the main
  thread's relay to the real dataCore worker.

The videoDecode worker ends up with a sub-view of the dataCore API
that shares the slab, without ever directly knowing the other worker
exists.

## Sending frames back out

The video direction uses the same mechanism in reverse. `VideoPanel`
creates a `MessageChannel`, hands port 2 to the worker as a *frame
sink*, and keeps port 1 to receive frames:

```ts
// Worker side
session.sink.postMessage(
  { ptsNs, frame, frameIndex, decodeQueue },
  [frame],   // transfer list: hand ownership of the VideoFrame
);
```

`VideoFrame` is transferable just like `MessagePort`. Posting it with
the transfer list hands the GPU-backed frame to the main thread
without a copy — the main thread blits it to a `<canvas>` and calls
`.close()` to release it.

Frame delivery doesn't go through Comlink at all; it's a plain port
with a plain `onmessage`. Comlink is request/response RPC, which
doesn't fit a continuous stream of pushed frames. Two mechanisms, each
where it fits.

## When a regular Promise isn't enough

`Comlink.wrap<DataCoreApi>` is strong enough for most of the app, but
some interactions need to be more careful:

- **Transfer vs copy.** Comlink serialises arguments with the
  structured-clone algorithm by default, which *copies* ArrayBuffers.
  For a dropped MCAP the size is fine (we want a copy so the reader
  owns its buffer). For a 4K `VideoFrame` it would be ruinous, hence
  the explicit `Comlink.transfer(...)` usage.
- **Long-lived subscriptions.** Comlink can send functions, but
  Driveline deliberately avoids it: the video path uses an explicit
  `MessagePort` instead, and the dataCore API is strictly
  request/response.
- **`Worker.terminate()`**. None of the workers are ever torn down
  while the app is running. If they were, Comlink proxies wrapping
  them would go quiet without error. Something to keep in mind if
  future code ever wants hot-reloading of a worker.

## Recap

- Workers isolate expensive work (WASM, video decode) from the
  React thread.
- Comlink turns the worker API into a remote-object proxy so the
  calling code looks like local async method calls.
- BigInt normalisation happens inside the worker, at the edge.
- A `MessagePort` bridge lets the videoDecode worker call into the
  dataCore worker's slab without owning its own wasm copy.
- `VideoFrame` transfer keeps the video path zero-copy.

Chapter 8 looks at the other half of the crossing: the wire formats —
Apache Arrow IPC for signals, `EncodedChunk` for video.
