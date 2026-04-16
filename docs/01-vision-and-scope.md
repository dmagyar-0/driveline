# 01 — Vision and Scope

## Problem

Engineers working on vehicles, robots, and other instrumented systems record
logs that contain **multiple modalities captured against a shared clock**:
4K (or higher) camera streams, high-rate signal channels (CAN, control loops,
IMUs), and occasional event/enum channels. Today there is no single tool that
is all of:

- browser-native (zero install, shareable),
- fast enough for 4K video,
- able to read the formats engineers already record in (MCAP and ASAM MF4),
- tightly time-synchronised across modalities.

Foxglove Studio covers most of this but is centred on ROS/MCAP and has no MF4
path. Rerun is excellent for robotics visualisation but is a desktop SDK, not
a log replay tool for pre-existing automotive formats.

**Driveline** targets the gap: a web-first multimodal log viewer that treats
MCAP and MF4 as first-class inputs and can play back 4K video alongside signal
plots with frame-accurate scrubbing.

## Target user (MVP)

An engineer with:

- a laptop running a Chromium-based browser,
- one or more log files on disk: MCAP with embedded H.264, MF4 with signals,
  optionally an `.mp4` + per-frame timestamps sidecar,
- a need to correlate what the camera saw with what the signals were doing at
  a specific instant.

## What is in scope for the MVP

1. Open a **local** MCAP file via drag-and-drop.
2. Open a **local** MF4 file alongside, parsed by the user's existing `mf4-rs`
   Rust crate compiled to WebAssembly.
3. Normalise all timestamps to a single nanosecond-UTC clock.
4. Display a global **timeline** with play / pause / seek / speed controls.
5. One **VideoPanel** playing 4K H.264 from MCAP-embedded frames.
6. One **PlotPanel** showing selected signal channels (from either source) with
   a shared time cursor tied to the timeline.
7. Frame-accurate sync: scrubbing the timeline updates both the video frame and
   the plot cursor in lock-step.

## Explicit non-goals for the MVP

- **No live streaming.** Replay of recorded files only. Architecture leaves
  room for a future live source behind the same `Reader` abstraction.
- **No ROS message decoding beyond what MCAP carries natively.** The MVP reads
  MCAP messages as opaque byte blobs with schema metadata; decoding schemas
  into human-readable structs is post-MVP.
- **No server.** Fully client-side. Files never leave the browser tab.
- **No annotation/labelling/authoring tools.** Read-only viewer.
- **No Firefox or Safari support commitment.** Chromium-first due to
  WebCodecs maturity.
- **No Tauri/desktop build in MVP**, though the architecture preserves the
  option (see `07-build-and-tooling.md`).
- **No cloud features, sharing links, multi-user, auth.**

## Success criteria

The MVP is "done" when, on a reference machine (modern x86 or Apple Silicon
laptop running Chrome), the user can:

1. Drop a 10-second reference MCAP containing a 4K/30fps H.264 stream plus
   four 1 kHz signal channels. The channel list populates within 1 s.
2. Drop the matching MF4 file. Its channels appear under a separate source,
   aligned to the same timeline with no manual offset.
3. Press play. Video plays at 30 fps with < 1% dropped frames, plot cursor
   advances smoothly, plot traces render without jank.
4. Scrub to an arbitrary time `t`. The video frame settles within 250 ms and
   the displayed signal samples correspond to `t` within one sample.

See `09-verification-plan.md` for the exact test procedure and sample corpus.

## Design tenets

- **Formats are adapters, not the core.** Everything downstream of the
  `Reader` trait is format-agnostic.
- **The worker owns the data; the UI owns the pixels.** Main thread does
  layout and DOM; workers do parsing, indexing, decoding.
- **One clock.** Every timestamp, everywhere, in nanoseconds since epoch.
- **Zero-copy when it matters.** Arrow IPC for signal chunks; transferable
  `ArrayBuffer` / `VideoFrame` across workers.
- **No premature abstractions.** Two formats today. Add the third adapter
  when the third format arrives, not before.
