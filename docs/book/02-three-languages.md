# Chapter 2 — Three Languages, One App

Driveline is written in three languages that most readers will not have
met before:

- **Rust** — a compiled systems language, used for the file-format
  readers.
- **TypeScript** — JavaScript with a static type checker bolted on,
  used for all the browser-side code.
- **React** — a JavaScript library (written in TypeScript here) for
  building user interfaces.

You do not need to be expert in any of these to follow the book. This
chapter gives you just enough to read the code in later chapters
without feeling lost.

## Rust in five minutes

Rust is a compiled language in the family of C, C++, and Go. The
sentence everyone uses to describe it is "memory-safe without a garbage
collector," which means:

- If the compiler accepts your program, it almost never crashes with a
  segmentation fault or corrupts memory at runtime.
- Unlike Python or Java, there's no hidden pause to clean up. Memory
  is freed at well-defined points the compiler proves are safe.

A tiny, complete Rust program looks like this:

```rust
fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    println!("{}", add(2, 3));
}
```

Things to notice:

- `fn` declares a function. Types come after the name, separated by a
  colon. `-> i32` means "returns a 32-bit signed integer."
- The last expression in a block (`a + b`) is the return value. No
  `return` needed. That's very common Rust style.
- `println!` is a macro (note the `!`). For this book the distinction
  doesn't matter — treat it as "call this thing."

### Structs and traits

A **struct** is a record type, like a class without methods:

```rust
pub struct TimeRange {
    pub start_ns: i64,
    pub end_ns: i64,
}
```

This is lifted directly from
[`crates/data-core/src/types.rs:7`](../../crates/data-core/src/types.rs#L7).
`pub` means "other modules can see this." `i64` is a 64-bit signed
integer.

A **trait** is an interface: a list of methods that a type promises to
implement. Here is the real thing, shortened:

```rust
pub trait Reader: Send {
    fn open(bytes: &[u8]) -> Result<Self> where Self: Sized;
    fn meta(&self) -> &SourceMeta;
    fn fetch_range(
        &self,
        channel_id: &ChannelId,
        range: TimeRange,
        opts: FetchOpts,
    ) -> Result<ArrowIpc>;
}
```

From [`crates/data-core/src/reader.rs:19`](../../crates/data-core/src/reader.rs#L19).
Three distinct concrete types in this project — `McapReader`,
`Mf4Reader`, and `Mp4SidecarReader` — all implement this trait. Code
that only needs to ask "what channels does this source have?" or "give
me data for channel X between times t0 and t1" doesn't care which of
the three it's holding.

If you come from Java, this is exactly an interface. If you come from
Go, it's exactly an interface. If you come from Haskell, it's a
typeclass. They all solve the same problem.

### Ownership — the famous one

Rust has a rule the compiler enforces: at any moment, every piece of
data has exactly one owner. When the owner goes out of scope, the data
is freed. You can *borrow* a value temporarily with `&` (immutable) or
`&mut` (mutable), but you can't smuggle the borrow past the owner's
lifetime.

You don't need to understand the details to read this codebase. Just
recognise that `&self` means "borrow the receiver immutably" and `&[u8]`
means "a borrowed slice of bytes." If you see a function accept `&[u8]`,
it promises not to keep the bytes around after it returns — so the
caller can free them or reuse the storage.

### Cargo — Rust's `npm`

Rust's package manager and build tool is called `cargo`. A crate is
Rust's word for a package. `Cargo.toml` is the manifest (like
`package.json`); `Cargo.lock` is the lockfile. `cargo test` runs tests,
`cargo build` builds. The workspace manifest at the root of this repo
is
[`Cargo.toml`](../../Cargo.toml) and declares two crates:

```toml
[workspace]
members = ["crates/data-core", "crates/wasm-bindings"]
```

We'll meet both in Chapters 4 and 5.

## TypeScript in five minutes

JavaScript is the programming language built into web browsers.
TypeScript is JavaScript plus a static type system: you write types in
your source, a compiler checks them, and then the types are erased and
plain JavaScript runs in the browser. The browser itself never sees
the types — they're a tool for humans and editors.

A minimal TypeScript example, annotated:

```ts
// Declare a type alias: `Channel` is shorthand for an object shape.
interface Channel {
  id: string;
  name: string;
  sampleCount: number;
}

// A function with typed parameters and a typed return.
function isBig(ch: Channel): boolean {
  return ch.sampleCount > 1_000_000;
}

// `const` is "constant binding" (not reassignable). `let` is mutable.
const example: Channel = { id: "c1", name: "speed", sampleCount: 2_000_000 };

if (isBig(example)) {
  console.log(example.name, "is big");
}
```

The syntax should be readable if you've ever seen JavaScript or any
C-family language.

### Async, Promises, and `await`

JavaScript is single-threaded but its runtime lets you schedule work
that completes later. A **Promise** is "an operation that will
eventually finish with a value." `await` pauses the current function
until the Promise settles:

```ts
async function loadFile(): Promise<string> {
  const response = await fetch("/data.txt");
  const text = await response.text();
  return text;
}
```

`async` marks a function as able to `await`; such a function always
returns a Promise. Most worker calls in Driveline are async, because
they cross a thread boundary.

### Generics and `Uint8Array`

Angle brackets are *generics*, the same idea as Java's `List<String>`
or C++ templates:

```ts
function first<T>(items: T[]): T | undefined {
  return items[0];
}
```

`Uint8Array` is one of JavaScript's built-in **typed arrays** — a
view over a raw buffer of unsigned 8-bit integers. This is how we ship
binary data around the app. There is also `BigInt64Array` (64-bit
integers, one per element) and `Float64Array` (64-bit floats). These
matter because they give you zero-copy access to arrays of numbers, in
contrast to JavaScript's regular `Array`, which is a generic
heterogeneous collection.

### `bigint` — because `number` isn't big enough

A plain JavaScript `number` is a 64-bit float. It can represent every
integer up to 2⁵³ − 1 exactly. After that, precision degrades.

A UTC timestamp in nanoseconds for any date after 1970-04-15 is larger
than 2⁵³ − 1. Driveline uses nanoseconds for *everything*. So
wherever a timestamp crosses between Rust and JavaScript, it's typed
as `bigint`, the language's arbitrary-precision integer:

```ts
const cursorNs: bigint = 1_704_067_200_000_000_000n;  // the `n` suffix makes it a bigint
cursorNs + 1n;  // arithmetic with other bigints
```

You'll see `bigint` throughout the store and the worker APIs.

### `pnpm` — like `npm`, smaller on disk

`pnpm` is a JavaScript package manager that shares modules across
projects on disk instead of copying them. Same commands as `npm` (`pnpm
install`, `pnpm run test`, `pnpm add package`). The repo uses a
**workspace** — multiple packages under one repo, co-ordinated by
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml).

## React in five minutes

React is a library for building user interfaces by composing small
"components." A component is a function that returns a description of
what should appear on the screen. React diffs that description against
what's already there and updates the DOM accordingly. You almost never
write `document.createElement` by hand.

A tiny example:

```tsx
function Greeting(props: { name: string }) {
  return <h1>Hello, {props.name}</h1>;
}

// Elsewhere:
<Greeting name="world" />
```

That angle-bracket syntax is called **JSX**. It is not HTML — it's
JavaScript with a convenient shorthand for "describe this tree."
TypeScript + JSX together is **TSX**; files end in `.tsx`.

### Hooks

Components can manage local state and side effects via *hooks*. The
two you'll see everywhere in Driveline are `useState` and `useEffect`:

```tsx
import { useState, useEffect } from "react";

function Counter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    document.title = `count: ${count}`;
  }, [count]);

  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
```

- `useState(0)` returns `[current_value, setter]`. Calling `setCount`
  queues a re-render.
- `useEffect(fn, deps)` runs `fn` after the render commits, whenever
  any value in `deps` has changed since the last render. If `deps` is
  `[]` (empty), it runs exactly once on mount.

Driveline uses `useEffect` in [`App.tsx:175`](../../apps/web/src/App.tsx#L175)
to spawn the workers on first mount, and in many panels to set up
subscriptions when the component appears.

### Zustand

React's built-in state handling is fine for single components, but
Driveline has a lot of global state (loaded files, cursor position,
playing/paused, panel layout). For that it uses a tiny third-party
library called **Zustand**. A Zustand store is just an object with
state fields and actions:

```ts
import { create } from "zustand";

interface CounterStore {
  count: number;
  inc(): void;
}

export const useCounter = create<CounterStore>((set) => ({
  count: 0,
  inc: () => set((s) => ({ count: s.count + 1 })),
}));
```

Any component can pluck out exactly the slice it needs:

```tsx
function CountDisplay() {
  const count = useCounter((s) => s.count);  // only re-renders when `count` changes
  return <span>{count}</span>;
}
```

Chapter 6 walks through the real
[`store.ts`](../../apps/web/src/state/store.ts), which is the single
source of truth for the entire Driveline UI.

## A sanity check

That's the vocabulary. If you now look at this real line from
[`apps/web/src/App.tsx:166`](../../apps/web/src/App.tsx#L166):

```tsx
const dataCore = useRef<Remote<DataCoreApi> | null>(null);
```

you should be able to decode it as:

- `useRef(...)` — a React hook for a value that persists across
  renders but doesn't trigger them when it changes.
- The generic parameter `<Remote<DataCoreApi> | null>` says the ref
  holds either a `Remote<DataCoreApi>` (a worker proxy — Chapter 7) or
  `null`.
- Initial value is `null` — the workers haven't been created yet when
  the component first mounts.

If that parses in your head, you're ready for the tour.
