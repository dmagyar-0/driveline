# Chapter 1 — What Driveline Is and Why It Exists

## The one-paragraph pitch

Driveline is a web page you open in your browser to look at data that
came off a car, a robot, or any machine that records what it was doing.
You drag a file onto the page; a video panel plays the camera feed; a
plot panel draws the signals (speed, acceleration, temperatures, …);
and a scrubber at the bottom lets you jump to any moment in the
recording. Video frame and plot cursor always line up on the same
instant. No server, no install, no upload — the file stays on your
machine.

## The boring, honest version

Engineers who work on vehicles already have two industry-standard file
formats for this kind of data:

- **MCAP** — a Foxglove / ROS log container. Multiple channels of
  messages (including compressed H.264 video) in one file, all keyed to
  a wall-clock timestamp.
- **MF4** (ASAM MDF v4) — the automotive measurement standard.
  High-rate signals (CAN bus traffic, control loops, IMU data)
  organised into channel groups.

There are tools that read each of these in isolation, but there wasn't
a single, browser-first tool that:

1. Reads both formats as first-class citizens.
2. Plays a 4K H.264 video alongside signal plots.
3. Keeps everything frame-accurately in sync with a single clock.
4. Needs zero install.

Driveline fills that gap.

## What this means in practice

Suppose an engineer is debugging an autonomous-driving feature. The
vehicle's recorder produced:

- `drive.mcap` — front-camera video at 3840×2160, 30 fps, plus GPS,
  steering angle, wheel speeds, and a handful of ROS topics.
- `drive.mf4` — the CAN bus at 1 kHz for the same drive.

With Driveline the engineer drags both files into the browser tab, sees
a unified timeline covering the drive's duration, picks a channel to
plot (say, `/vehicle/speed`) and watches the video and the speed trace
scroll together. If something odd happens at 03:42 into the drive, a
scrub back to that instant shows both the pixels the camera saw and the
value of every plotted signal at exactly that nanosecond.

That "exactly that nanosecond" is the entire technical premise of the
project. The rest of this book explains how it's pulled off.

## The three pieces of the puzzle

Before we look at any code, a mental model:

```
    Your computer                            Your browser
  ┌─────────────────┐                     ┌─────────────────────┐
  │  drive.mcap ────┼──── drag & drop ───▶│  React UI           │
  │  drive.mf4  ────┼──── ──── ──── ─────▶│  (main thread)      │
  └─────────────────┘                     │        │            │
                                          │   sends file to     │
                                          │   two web workers:  │
                                          │        │            │
                                          │        ▼            │
                                          │  ┌───────────────┐  │
                                          │  │ data-core     │  │
                                          │  │ (Rust/WASM)   │  │
                                          │  │ parses file,  │  │
                                          │  │ builds index  │  │
                                          │  └───────────────┘  │
                                          │        │            │
                                          │        ▼            │
                                          │  ┌───────────────┐  │
                                          │  │ video-decode  │  │
                                          │  │ (TypeScript)  │  │
                                          │  │ WebCodecs     │  │
                                          │  └───────────────┘  │
                                          │        │            │
                                          │        ▼            │
                                          │  ┌───────────────┐  │
                                          │  │ Panels draw   │  │
                                          │  │ on <canvas>   │  │
                                          │  └───────────────┘  │
                                          └─────────────────────┘
```

Three boxes running in the same browser tab, each with one job. They
talk to each other over a typed async API. The file never leaves your
computer — not even briefly, not even cached.

## What you'll learn in this book

By the end you should understand, file-by-file, how a drag-and-dropped
log becomes a playing video with a synchronised signal plot:

- Chapter 2 explains the three languages this codebase uses (Rust,
  TypeScript, React) and why each one is there.
- Chapter 3 walks the directory tree so you can orient yourself in the
  repository.
- Chapters 4–5 cover the Rust "core" — the part that knows how to read
  file formats — and how it gets compiled into something the browser
  can run.
- Chapters 6–7 cover the browser side: the React UI and the two web
  workers.
- Chapter 8 is a focused look at the two wire formats used between
  workers: Apache Arrow IPC for signal data, and encoded H.264
  "chunks" for video.
- Chapters 9–10 are the two hardest pieces: the video pipeline and the
  timeline that keeps everything in sync.
- Chapter 11 covers how to actually build and run the project on your
  machine.

Let's start by meeting the three languages.
