# Chapter 4 — The Rust Core: Types and the `Reader` Trait

## What this crate is for

`crates/data-core` is a plain Rust library. It has no browser-specific
code, no JavaScript bindings, no WebAssembly. You can `cargo test` it
on any laptop that has a recent Rust compiler.

Its job is exactly one thing: **given a pile of bytes from a log file,
produce an object that can answer questions about the log**. Questions
like "what channels are in this file?", "what time span does it
cover?", "give me all samples of channel X between timestamps t0 and
t1." The object it produces is called a `Reader`, and there are three
concrete kinds.

## The canonical types

Before looking at the `Reader` trait itself, meet the types it uses.
All of them live in
[`crates/data-core/src/types.rs`](../../crates/data-core/src/types.rs).

```rust
pub type SourceId = String;
pub type ChannelId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeRange {
    pub start_ns: i64,
    pub end_ns: i64,
}
```

Some Rust things to notice:

- `pub type X = Y;` is a type alias — `SourceId` is literally a
  `String`, but giving it a name makes the intent obvious at call
  sites.
- `#[derive(Debug, Clone, Copy, ...)]` is an annotation telling the
  compiler to generate implementations of these traits automatically.
  `Clone` = "can be duplicated"; `Copy` = "duplicating is cheap and
  implicit" (like an integer). `Debug` = "has a developer-readable
  `Debug` format" (so you can `println!("{:?}", range)`). `PartialEq`
  and `Eq` let you use `==` on two values.
- `i64` is a 64-bit signed integer. The whole project pins this as
  the timestamp type: **nanoseconds since the Unix epoch**. One
  nanosecond, one integer, everywhere.

`Channel` describes a single stream within a source:

```rust
pub struct Channel {
    pub id: ChannelId,
    pub source_id: SourceId,
    pub name: String,
    pub kind: ChannelKind,
    pub dtype: Option<DType>,
    pub unit: Option<String>,
    pub sample_count: u64,
    pub time_range: TimeRange,
}
```

`Option<T>` is Rust's answer to "nullable T." It's either `Some(value)`
or `None`. The compiler won't let you accidentally use the value
without checking. A unitless channel (e.g. a count) has `unit: None`,
and that shows up in every path that touches it.

`ChannelKind` and `DType` are enums — tagged unions:

```rust
pub enum ChannelKind { Scalar, Vector, Video, Enum, Bytes }
pub enum DType       { F32, F64, I32, I64, U32, U64 }
```

Rust enums are closed and exhaustive: the compiler forces you to
handle every variant in a `match`, which is how we know we haven't
forgotten about, say, `Bytes` channels anywhere downstream.

## The `Reader` trait, in full

Here is the entire trait, from
[`crates/data-core/src/reader.rs`](../../crates/data-core/src/reader.rs):

```rust
pub type ArrowIpc = Vec<u8>;
pub type EncodedChunkIter = Box<dyn Iterator<Item = EncodedChunk> + Send>;

pub trait Reader: Send {
    fn open(bytes: &[u8]) -> crate::Result<Self>
    where
        Self: Sized;

    fn meta(&self) -> &SourceMeta;

    fn fetch_range(
        &self,
        channel_id: &ChannelId,
        range: TimeRange,
        opts: FetchOpts,
    ) -> crate::Result<ArrowIpc>;

    fn video_stream(
        &self,
        channel_id: &ChannelId,
        from_pts_ns: i64,
    ) -> crate::Result<EncodedChunkIter> {
        let _ = (channel_id, from_pts_ns);
        Err(crate::Error::UnsupportedKind)
    }
}
```

Reading it line by line:

- **`pub trait Reader: Send`** — `Reader` is a public trait; any type
  that implements it must *also* implement `Send`, which is the
  standard-library trait for "this type can be moved across thread
  boundaries safely." Readers end up on a web worker, which from
  Rust's perspective is a separate thread.
- **`fn open(bytes: &[u8]) -> Result<Self>`** — `open` takes a
  borrowed byte slice and returns either `Self` (a live reader) or an
  error. `&[u8]` is a **slice** — a pointer and a length, with no
  ownership. The reader has to copy what it needs out of that buffer
  if it wants to keep anything.
- **`where Self: Sized`** — bureaucratic detail. It means "`open` is
  only callable on types whose size is known at compile time." This
  is true for the three concrete readers.
- **`fn meta(&self) -> &SourceMeta`** — "borrow the metadata this
  reader already built at `open` time." `&self` makes this a
  read-only method; `&SourceMeta` means the caller gets a borrowed
  view, no copy.
- **`fn fetch_range(...) -> Result<ArrowIpc>`** — the main workhorse.
  `ArrowIpc` is an alias for `Vec<u8>` (an owned byte buffer) — those
  bytes are the Apache Arrow IPC wire format, which Chapter 8 covers.
- **`fn video_stream(...) -> ...`** — only `McapReader` and
  `Mp4SidecarReader` override this; the default implementation just
  returns an error. `EncodedChunkIter` is a *boxed, dynamic iterator*
  of encoded H.264 chunks. `Box<dyn Iterator<...>>` is Rust's way of
  saying "some iterator — I don't care what kind, store it on the
  heap behind a pointer." The pattern lets the WASM layer keep a
  handle to whichever concrete iterator a reader produced.

Three sentences of big-picture commentary:

1. `open` is eager. It parses the entire file header, walks indices,
   and returns a reader with `SourceMeta` already populated. All
   "list the channels"-style queries are cheap after that.
2. `fetch_range` is the lazy side. It streams a specific channel's
   samples for a specific time window and serialises them to Arrow
   IPC bytes the JS side can consume. This is what panels call when
   the user scrubs.
3. `video_stream` is separate because video doesn't fit the Arrow
   model — it's a stream of opaque compressed frames, not columns of
   numbers. Chapter 9 goes into this.

## Meet the noop reader

The simplest possible implementation of the trait is the `NoopReader`,
used only in tests:

```rust
// crates/data-core/src/noop.rs

pub struct NoopReader {
    meta: SourceMeta,
}

impl Reader for NoopReader {
    fn open(_bytes: &[u8]) -> crate::Result<Self> {
        Ok(Self { meta: SourceMeta::empty() })
    }

    fn meta(&self) -> &SourceMeta { &self.meta }

    fn fetch_range(
        &self,
        _channel_id: &ChannelId,
        _range: TimeRange,
        _opts: FetchOpts,
    ) -> crate::Result<ArrowIpc> {
        Ok(Vec::new())
    }
}
```

Things to notice:

- `impl Reader for NoopReader { ... }` is how you implement a trait
  for a type in Rust.
- `_bytes`, `_channel_id`, etc. — the leading underscore tells the
  compiler "I know I'm ignoring this parameter, don't warn me."
- `Ok(...)` and `Err(...)` construct the two variants of
  `Result<T, E>`. You'll see `Ok` and `Err` everywhere in Rust code.

The trait's contract is satisfied by this 15-line stub. That's the
power of the abstraction: everything downstream (the WASM layer, the
store, the panels) doesn't care whether it's talking to a noop, an
`Mf4Reader`, an `McapReader`, or the three of them at once.

## The three real readers at a glance

The full implementations are long — MCAP alone is about 1300 lines —
but the shape is the same for each:

- **`Mf4Reader`** (`mf4.rs`, ~700 lines) wraps the `mf4-rs` crate.
  MF4 groups channels by recording-session, each with its own relative
  time axis. `open` walks the groups, computes `start_time +
  cg_offset` per group, and records the channel list with absolute
  nanosecond ranges. `fetch_range` does a sample-index binary search
  and copies out the `[t0, t1)` slice to an Arrow batch.
- **`McapReader`** (`mcap.rs`, ~1300 lines) wraps the `mcap` crate.
  MCAP is message-oriented, so the reader reads every message at open
  time, classifies it by schema (video, scalar, vector, enum, opaque
  bytes), and materialises parallel arrays that can be sliced.
- **`Mp4SidecarReader`** (`mp4_sidecar.rs`, ~700 lines) is the
  video-only reader. It parses the mp4 container for the per-frame
  sample table, cross-references a plain-text sidecar of
  `<frame_index>\t<timestamp_ns>` lines (one per frame in decode
  order), and exposes a sample index for lazy chunk loading by the JS
  layer.

Each of them implements `Reader`, which means the layer above can
ignore the differences.

## Errors

The crate declares its error type at
[`crates/data-core/src/lib.rs:26`](../../crates/data-core/src/lib.rs#L26):

```rust
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported channel kind for this reader")]
    UnsupportedKind,

    #[error("channel not found: {0}")]
    ChannelNotFound(ChannelId),

    #[error("arrow error: {0}")]
    Arrow(#[from] arrow_schema::ArrowError),

    // ... many more specific variants ...
}

pub type Result<T> = std::result::Result<T, Error>;
```

Two things to notice:

- `#[derive(thiserror::Error)]` + `#[error("...")]` attributes come
  from a third-party crate called `thiserror`. They generate the
  boilerplate for turning this enum into a proper `std::error::Error`
  implementation with human-readable `Display` output.
- `#[from]` on a field tells `thiserror` to generate a
  `From<arrow_schema::ArrowError> for Error`, which then lets you
  write `?` after a call that returns an `ArrowError` and have it
  converted automatically.

`?` is Rust's "try operator": if the expression before it is `Err(e)`,
the function returns `Err(e.into())` early; if it's `Ok(x)`, the `?`
evaluates to `x`. It's what makes Rust error-handling readable despite
the lack of exceptions.

## Summary

- `types.rs` defines the vocabulary: `Channel`, `TimeRange`,
  `SourceMeta`, enums for kind/dtype.
- `reader.rs` defines the single `Reader` trait: `open`, `meta`,
  `fetch_range`, `video_stream`.
- `noop.rs` is the 15-line toy implementation used as a sanity check.
- `mcap.rs`, `mf4.rs`, `mp4_sidecar.rs` are the real ones.
- Errors are a `thiserror` enum; `Result<T>` is a crate-local alias.

This is the entire portable Rust API. Next chapter: how we teach a
browser to run it.
