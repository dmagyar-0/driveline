# Chapter 5 — WASM: Carrying Rust Into the Browser

## The plumbing problem

Chapter 4 built a Rust library that runs on a desktop. A browser tab,
though, can only directly execute **JavaScript**. It can also execute
**WebAssembly** (WASM) — a byte-code format that the browser's
JavaScript engine runs at near-native speed — but WASM by itself has
no knowledge of strings, objects, or Promises. Raw WASM just shuffles
32- and 64-bit numbers.

So there are two problems to solve:

1. **Compilation.** Turn our Rust crate into a `.wasm` file.
2. **Marshalling.** Translate Rust types (strings, byte slices,
   structs) to JavaScript types and back, every time we call across
   the boundary.

Both are solved by a tool called **`wasm-bindgen`** plus a thin Rust
crate, `crates/wasm-bindings`, that acts as the cross-over point.

## The `wasm-bindings` crate

This crate's entire job is to re-export a handful of `data-core`
functions through `wasm-bindgen` attributes so that they become
callable from JavaScript. It lives at
[`crates/wasm-bindings/src/lib.rs`](../../crates/wasm-bindings/src/lib.rs)
and it's only about 500 lines.

Look at the simplest function in it:

```rust
#[wasm_bindgen]
pub fn ping() -> String {
    "pong".to_string()
}
```

The `#[wasm_bindgen]` attribute is the magic. During compilation,
`wasm-bindgen` emits both:

- Rust code that converts the `String` return value into a form the
  browser's JS engine can read (a pointer plus a length into WASM
  memory).
- A JavaScript wrapper function so that callers can do `await
  ping()` and receive an ordinary JS string.

Together, those two generated pieces hide the marshalling. Our
application code just calls `ping()` and gets back `"pong"`.

## Handles, not references

Rust's ownership model is incompatible with "please keep a pointer to
this thing for a while, JS, and call back later." So Rust can't
give JavaScript a direct pointer to an `McapReader`.

The workaround is the **slab-and-handle pattern**: store the
`McapReader` in a Rust-side table keyed by an integer, return the
integer to JS, and look it up again on every subsequent call. Here's
the setup at the top of `lib.rs`:

```rust
use std::cell::RefCell;
use slab::Slab;
use data_core::{McapReader, Mf4Reader, Mp4SidecarReader, EncodedChunkIter};

thread_local! {
    static READERS:       RefCell<Slab<Mf4Reader>>        = const { RefCell::new(Slab::new()) };
    static MP4_READERS:   RefCell<Slab<Mp4SidecarReader>> = const { RefCell::new(Slab::new()) };
    static MCAP_READERS:  RefCell<Slab<McapReader>>       = const { RefCell::new(Slab::new()) };
    static VIDEO_STREAMS: RefCell<Slab<EncodedChunkIter>> = const { RefCell::new(Slab::new()) };
}
```

Unpacking that:

- **`thread_local!`** declares per-thread globals. WASM workers are
  single-threaded by default; each of these is effectively a single
  module-level value.
- **`Slab<T>`** is a small dependency — a vector that re-uses freed
  slots. Inserting returns an integer key; you can look up or remove
  by that key.
- **`RefCell<T>`** allows interior mutability: you can borrow the
  contents mutably at runtime (not compile time). Necessary because
  the slabs get updated as JS opens and closes files.

Opening an MF4 file now looks like this:

```rust
#[wasm_bindgen]
pub fn open_mf4(data: &[u8]) -> Result<u32, JsError> {
    let reader = Mf4Reader::open(data)
        .map_err(|e| JsError::new(&format!("open mf4 failed: {e}")))?;
    let key = READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}
```

What happens on each call:

1. JS hands us `data: &[u8]` — the bytes of the dropped file.
   `wasm-bindgen` did the work of copying those into the WASM heap and
   handing Rust a slice view of them.
2. `Mf4Reader::open(data)` runs the normal Rust reader code. If it
   fails, `.map_err(...)?` converts the error to a `JsError` and
   returns early.
3. `READERS.with(|cell| cell.borrow_mut().insert(reader))` stores the
   reader in the slab, returning an integer key.
4. We return `u32` because JavaScript numbers can represent u32
   losslessly, and `wasm-bindgen` knows how to marshal u32 to JS.

Every follow-up call (`mf4_summary`, `mf4_fetch_range`, `close_mf4`)
takes the handle and looks the reader back up:

```rust
#[wasm_bindgen]
pub fn close_mf4(handle: u32) {
    READERS.with(|cell| {
        let mut slab = cell.borrow_mut();
        if slab.contains(handle as usize) {
            slab.remove(handle as usize);
        }
    });
}
```

When JS closes the file, the corresponding slab entry is dropped.
Dropping an `Mf4Reader` runs its destructor and frees its memory —
the same deterministic cleanup you'd get for a local variable going
out of scope.

## Transporting big numbers

Nanosecond timestamps are `i64`. A JavaScript `number` can't hold
those without precision loss. The crate ships summary objects back to
JS using `serde` (a serialisation framework) and a custom
configuration that emits 64-bit integers as `BigInt` instead of
`Number`:

```rust
fn bigint_serializer() -> serde_wasm_bindgen::Serializer {
    serde_wasm_bindgen::Serializer::new()
        .serialize_large_number_types_as_bigints(true)
}
```

The TS worker normalises through `BigInt()` once on the way in (see
`apps/web/src/workers/dataCore.worker.ts`), so JS consumers always see
`bigint` timestamps regardless of whether `serde` sent them as
`Number` or `BigInt`.

## Transporting Arrow bytes

For the output of `fetch_range`, the Rust code produces `Vec<u8>`
(Arrow IPC bytes), and we want to hand them to JS as a `Uint8Array`
without a round trip through strings:

```rust
#[wasm_bindgen]
pub fn fetch_range_stub() -> Result<Uint8Array, JsError> {
    let bytes = data_core::fixtures::arrow_scalar_ipc()
        .map_err(|e| JsError::new(&format!("fixture generation failed: {e}")))?;
    let out = Uint8Array::new_with_length(bytes.len() as u32);
    out.copy_from(&bytes);
    Ok(out)
}
```

`Uint8Array` here is a type from the `js-sys` crate — a Rust-side
stand-in for the browser's built-in type. `out.copy_from(&bytes)`
does a bulk memory copy from the WASM heap into a `Uint8Array` the JS
engine sees directly. From JS, the returned object is an ordinary
`Uint8Array` that a library like `apache-arrow` can parse.

## Building the WASM module

`wasm-bindgen` does the Rust side; the companion command-line tool
**`wasm-pack`** runs the compile and emits a matching JavaScript
wrapper. The top-level `package.json` wires this up:

```json
"scripts": {
  "wasm:build": "wasm-pack build crates/wasm-bindings --target web --out-dir ../../apps/web/src/wasm --out-name wasm_bindings"
}
```

Run `pnpm wasm:build` and three files appear under
`apps/web/src/wasm/`:

- `wasm_bindings_bg.wasm` — the compiled Rust module.
- `wasm_bindings.js` — a glue file that exports `init()` plus a JS
  function for every `#[wasm_bindgen]`-tagged Rust function.
- `wasm_bindings.d.ts` — TypeScript declarations for the same set.

Because the `.d.ts` is generated with types, the whole bridge is
type-safe from the moment JS imports it.

## How JavaScript actually calls into WASM

Inside the dataCore worker (Chapter 7 goes into workers in detail):

```ts
// apps/web/src/workers/dataCore.worker.ts
import init, {
  ping as wasmPing,
  open_mf4,
  mf4_summary,
  // ...
} from "../wasm/wasm_bindings.js";

const ready = init();  // returns a Promise that resolves once WASM loads

export const dataCoreApi = {
  async ping(): Promise<string> {
    await ready;
    return wasmPing();
  },
  async openMf4(bytes: Uint8Array): Promise<number> {
    await ready;
    return open_mf4(bytes);
  },
  // ...
};
```

A few things to call out:

- `import init, { ... }` — the generated `wasm_bindings.js` has one
  default export (`init`) that fetches and compiles the `.wasm` file,
  plus named exports for every Rust function.
- `await ready;` in every method — the WASM module takes a few
  milliseconds to instantiate; each API method waits for that once
  before doing its work. The wait is memoised because `init()` is
  called exactly once at module evaluation.
- The TypeScript view of `open_mf4` matches the Rust signature via
  the generated `.d.ts`: it takes `Uint8Array`, returns `number`
  (the handle).

## What's in the bindings surface

The crate exposes a flat collection of functions, not an object-
oriented API. The categories are:

| Category | Functions |
|---|---|
| Smoke test | `ping`, `fetch_range_stub` |
| MF4 files | `open_mf4`, `close_mf4`, `mf4_summary`, `mf4_fetch_range` |
| MCAP files | `open_mcap`, `close_mcap`, `mcap_summary`, `mcap_fetch_range`, `mcap_video_open`, `mcap_video_next_batch`, `mcap_video_close` |
| MP4 + sidecar | `open_mp4_sidecar`, `close_mp4_sidecar`, `mp4_sidecar_summary`, `mp4_video_open`, `mp4_video_next_batch`, `mp4_video_close` |

Three patterns show up across all three file formats:

- **`open_*(bytes) -> handle`**. Takes the file bytes, parses
  headers, returns an integer handle.
- **`*_summary(handle) -> summary`**. Returns the channel list and
  global range as a plain object (numbers, strings, arrays of those).
- **`*_fetch_range(handle, channel_id, t0, t1, ...) -> Uint8Array`**.
  Returns Arrow IPC bytes for one channel's values in `[t0, t1)`.

The video streaming APIs add **`*_video_open / *_video_next_batch /
*_video_close`**, which wrap the `EncodedChunkIter` in a second
handle: `video_open` inserts the iterator into `VIDEO_STREAMS` and
returns a stream handle that subsequent calls use.

## Why this layering matters

The `data-core` crate compiles and tests natively. You edit a Rust
file, run `cargo test -p data-core`, and get results in a second or
two. Only the shim in `wasm-bindings` has to be rebuilt for the
browser, and only when the bindings surface changes.

If a future version of Driveline wants to ship a native desktop
version (Tauri, Electron, or a pure-Rust CLI), `data-core` comes along
unchanged. `wasm-bindings` gets replaced with a different adapter for
the native platform. The `Reader` trait contract — and most of the
code — is reused.

Next: how the browser uses these bindings through React.
