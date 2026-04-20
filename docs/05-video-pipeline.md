# 05 — Video Pipeline

The MVP target is **4K H.264 at 30 fps, hardware-decoded in the browser**,
with frame-accurate alignment to the global ns-UTC clock.

## Building blocks

- **WebCodecs `VideoDecoder`** — the browser API that gives us hardware
  decoding and `VideoFrame` objects tagged with PTS.
- **`OffscreenCanvas` / `ImageBitmap`** — for blitting decoded frames to
  the `VideoPanel` without blocking the main thread.
- **`data-core` worker** — produces `EncodedChunk` streams (see
  `03-data-model.md`) from whichever `Reader` is backing the video channel.
- **`video-decode` worker** — owns one `VideoDecoder` per active video
  channel, implements seek, emits `VideoFrame`s.

## Pipeline overview

```
              EncodedChunk           VideoFrame
data-core ───────────────────▶ video-decode ───────────────▶ VideoPanel
   ▲                                                           │
   │  video_open(channel_id, from_pts_ns)                      │
   │◀──────────────────────────────────────────────────────────┘
              seek(t) / play / pause
```

`data-core` and `video-decode` communicate over a `MessageChannel` set up
by the main thread at session open, so they can swap `ArrayBuffer`s
directly without round-tripping through React.

## Per-channel lifecycle

1. User selects a video channel (or the default one is auto-selected on
   session open).
2. Main thread calls `videoDecode.open(channel_id)`.
3. `video-decode` worker opens the channel in `data-core` via
   `video_open(channel_id, from_pts_ns=session_start)`, receives the
   codec description (SPS/PPS extradata), and calls:
   ```js
   decoder.configure({
     codec: "avc1.64002a",         // derived from SPS profile/level
     codedWidth, codedHeight,
     description,                  // AVCC extradata bytes
     hardwareAcceleration: "prefer-hardware",
     optimizeForLatency: false,    // replay, not live
   });
   ```
4. Decoder emits `VideoFrame`s with `timestamp = pts_ns` (WebCodecs takes
   PTS in µs; we set `pts_ns / 1000`, and we preserve the ns value in a
   side map for exact comparisons).
5. Frames are forwarded to `VideoPanel`; the panel's blit loop picks the
   frame whose PTS matches the cursor and calls `.close()` on drained ones
   to release GPU memory.

## Seeking

`seek(target_ns)` from the transport:

1. Video-decode worker calls `decoder.flush()` then `decoder.reset()`.
2. Calls `data-core.video_open(channel_id, target_ns)`. Data-core binary-
   searches the keyframe index for the largest `keyframe_pts ≤ target_ns`
   and positions the iterator there.
3. Feeds chunks into the decoder; frames with `pts < target_ns` are
   discarded on output (free + close). The first frame with
   `pts ≥ target_ns` is delivered to VideoPanel.
4. If the user is scrubbing continuously, seek calls are coalesced on a
   50 ms trailing debounce in the main thread to avoid thrashing.

**Worst-case seek latency** is bounded by the GOP distance: with a
1-keyframe-per-second encode at 30 fps, at most 30 frames of decode before
the target frame appears. At 4K on a modern Chromium hardware decoder this
is ~100–200 ms.

Recorders that produce sparse keyframes (e.g. one per 5 seconds) will be
noticeably slower to seek; we document this as a recording guideline but
do not re-encode in the viewer.

## Playback

Playback uses the same primitives as seek, with a leading decode queue:

- Video-decode worker maintains a **bounded frame queue** (default: 8
  frames) ahead of the cursor.
- A rAF loop in VideoPanel pops the oldest frame whose
  `pts_ns <= cursor_ns`, blits it, closes it.
- When queue length drops below a low-water mark, worker feeds more
  chunks into the decoder.
- Speed control: the `cursor_ns` advance rate is multiplied by
  `transport.speed`. The decoder always decodes at native rate; at 2×
  speed the panel drops every other frame (the ones that never become
  `<= cursor_ns` before the next one arrives). At 0.5× speed the queue
  simply backs up and the decoder naturally back-pressures via
  `decoder.decodeQueueSize`.

## MCAP-embedded video path

Covered by `McapReader::video_stream` (see `04-reader-abstraction.md`).

Key details specific to MCAP:

- MCAP messages usually contain a single H.264 access unit (one frame's
  worth of NAL units). Occasionally a message may wrap an AVCC-framed
  blob; the adapter reads the first 4 bytes to distinguish length-prefixed
  AVCC from Annex-B start codes (`00 00 00 01`). It converts Annex-B to
  AVCC before emitting if the decoder was configured with AVCC
  `description` (and vice versa).
- Codec `description` (SPS/PPS) is extracted either from the MCAP channel
  metadata (preferred, when the producer was well-behaved) or by scanning
  the first N keyframes for SPS/PPS NALUs and concatenating them into an
  `avcC` record.
- `pts_ns` comes from MCAP `log_time`. If `publish_time` differs and the
  producer is known to emit camera-capture time as `log_time`, we prefer
  `log_time` for sync with signals.

MVP is H.264 only. H.265 / AV1 are deferred; `Reader::video_stream` does
not care which, but Chromium's `VideoDecoder` configuration and the codec
inference logic will need extension.

## mp4 + sidecar timestamp path

The mp4 path exists because in-vehicle recorders often write a plain mp4
alongside signals, with timestamps captured at capture-time rather than
encoded into the mp4's (wall-clock-agnostic) track timeline.

### Sidecar format (MVP)

- A file with the same basename as the mp4 and extension `.timestamps`
  (if `foo.mp4`, then `foo.mp4.timestamps`).
- Contents: plain UTF-8 text. No header, no magic, no padding.
- One line per video sample (access unit) in the track's **decode order**
  (matching the order of entries in the mp4 `stsz` table).
- Each line is `<frame_index>\t<timestamp_ns>\n`, where `frame_index` is
  the 0-based row number and `timestamp_ns` is absolute nanoseconds UTC
  at the capture instant for that frame.
- The reader accepts `\n` or `\r\n` line endings and an optional trailing
  newline. The frame column must equal the row's 0-based index — any
  skipped, reordered, or duplicated row fails the file open with a
  `sidecar line N: ...` error. A mismatch between the line count and the
  mp4's sample count also fails the open with a descriptive error.

### Open flow

1. User drops both `drive.mp4` and `drive.mp4.timestamps`. The UI pairs
   them by basename. If only one is dropped, the UI prompts for the other.
2. `Mp4SidecarReader::open` parses the mp4's `moov` to get the sample
   table and codec extradata.
3. The sidecar array becomes the source of truth for `pts_ns` / `dts_ns`.
   The mp4's own `stts` / `ctts` offsets are ignored for synchronisation
   purposes — they are only used to compute `duration_ns` when the
   sidecar does not provide an end time for the last frame (we use
   `sidecar[i+1] - sidecar[i]` in the middle, and repeat the last delta
   at the end).
4. Generated Driveline channel has `kind = Video`; no signal channels are
   synthesised.

### Decode flow

Identical to the MCAP path from the decoder's perspective: keyframe
lookup, configure with extradata, feed AVCC access units.

## Why not `HTMLVideoElement` + MSE

- MSE does not give us frame-accurate PTS. `<video>.currentTime` snaps to
  decoded frame boundaries but the mapping from our ns-UTC clock to
  `currentTime` (seconds, relative to the MSE buffered timeline) is
  painful when the recorded timebase is sparse or jittered.
- MSE seeking across large jumps requires careful source-buffer removal
  and re-append; WebCodecs `decoder.reset()` is one call.
- MSE inherits `<video>` element quirks (autoplay policies, layout reflow,
  preload heuristics) that add flakiness to a scrubbing-heavy UX.
- WebCodecs is explicitly designed for this use case: give me bytes, I
  give you frames with PTS you chose.

The tradeoff: narrower browser support (see `08-risks-and-open-questions.md`).
Acceptable given the Chromium-first stance.

## Error handling

- **Decoder error event.** Treated as fatal for the active stream; we
  close the decoder, surface an error in the VideoPanel ("decode failed
  at t=…"), keep the rest of the session alive.
- **Codec not supported.** `VideoDecoder.isConfigSupported()` is called
  before `configure`; if unsupported we disable the video channel and
  show a message with the detected codec string.
- **Missing SPS/PPS.** If we cannot find codec extradata within the first
  few MB of a stream, we fail open with a clear error rather than
  silently producing a black panel.
- **PTS gap.** A chunk whose `pts_ns` is more than a configurable
  threshold (default 1 s) ahead of the previous chunk triggers a
  one-shot warning in the dev console but does not halt playback.
