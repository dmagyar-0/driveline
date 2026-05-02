# 05 — Video Pipeline

The MVP target is **4K H.264 at 30 fps, hardware-decoded in the browser**,
with frame-accurate alignment to the global ns-UTC clock.

## Building blocks

- **WebCodecs `VideoDecoder`** — the browser API that gives us hardware
  decoding and `VideoFrame` objects tagged with PTS.
- **`OffscreenCanvas` / `ImageBitmap`** — for blitting decoded frames to
  the `VideoPanel` without blocking the main thread.
- **`data-core` worker** — for MCAP sources, produces `EncodedChunk`
  streams (see `03-data-model.md`) from the active `Reader`. For mp4+
  sidecar sources it parses the moov box once at open time and then drops
  out of the encoded-bytes path entirely.
- **`Mp4SampleCache`** (main thread) — backs the mp4 path. Holds the
  per-sample index (`offsets`, `sizes`, `isSync`, `ptsNs`, plus SPS/PPS)
  exported by wasm at open time, and lazy-fetches sample bodies via
  `File.slice()` on demand with an LRU window around the active cursor.
- **`video-decode` worker** — owns one `VideoDecoder` per active video
  channel, implements seek, emits `VideoFrame`s. Reads encoded bytes from
  `data-core` for MCAP and from `Mp4SampleCache` for mp4 — the two routes
  are dispatched in `videoStreamOps()` and the rest of the worker is
  source-agnostic.

## Pipeline overview

The encoded-bytes route depends on the source kind. `video-decode` owns
the decoder and `VideoPanel` owns the canvas in both cases.

MCAP — `data-core` produces Annex-B `EncodedChunk`s, `video-decode`
configures the decoder from a scanned SPS:

```
              EncodedChunk (Annex-B)        VideoFrame
data-core ─────────────────────────▶ video-decode ───────────▶ VideoPanel
   ▲                                                              │
   │  video_open(channel_id, from_pts_ns)                         │
   │◀─────────────────────────────────────────────────────────────┘
              seek(t) / play / pause
```

mp4+sidecar — `data-core` is consulted **only at open time** to parse
the moov; thereafter `video-decode` pulls AVCC sample bodies straight
from `Mp4SampleCache` over a separate `mp4Lazy` MessagePort, and the
decoder runs in AVC (length-prefixed) mode against a synthesised `avcC`
description:

```
                 sample bytes (AVCC)         VideoFrame
Mp4SampleCache ─────────────────────▶ video-decode ─────────▶ VideoPanel
(main thread)   mp4Sample(handle, i)                            │
      ▲                                                         │
      │ File.slice([offset, offset+size))                       │
      ▼                                                         │
  source File                          seek(t) / play / pause   │
                                                                │
  data-core (open-time only)  ─── mp4_sidecar_index ──▶ index   │
                                  (offsets, sizes,             ◀┘
                                   isSync, pts, SPS, PPS)
```

`data-core` and `video-decode` communicate over a `MessageChannel` set up
by the main thread at session open, so they can swap `ArrayBuffer`s
directly without round-tripping through React. The mp4 path uses a
second `MessageChannel` (`mp4Lazy`) wired by `VideoPanel` so the decode
worker can call into the main-thread cache without ever holding the
source `File` blob itself.

## Per-channel lifecycle

1. User selects a video channel (or the default one is auto-selected on
   session open).
2. Main thread calls `videoDecode.open(sourceKind, sourceHandle, channel_id, fromNs)`.
3. The worker dispatches on `sourceKind` to one of two open paths:
   - **MCAP (Annex-B mode).** `video-decode` opens the channel in
     `data-core` via `openMcapVideoStream(handle, channel, from)`. The
     first batch of encoded chunks is scanned for an H.264 SPS NAL unit
     (`findSps` in `videoDecode.worker.ts`), and the codec string is
     derived from `profile_idc` / constraint flags / `level_idc` (e.g.
     `avc1.64002A`). The decoder is configured **without** a
     `description` — Annex-B start codes do the framing inline.
   - **mp4 (AVC mode).** The worker calls `mp4Index(handle)` over the
     `mp4Lazy` MessagePort and gets back the parallel-arrays index plus
     the SPS+PPS bytes the wasm reader extracted from the moov.
     `buildAvccDescription(sps, pps)` (in `mp4AnnexB.ts`) lays out a
     standard `AVCDecoderConfigurationRecord` per ISO/IEC 14496-15
     §5.3.3.1.2, and the codec string is read from the description's
     profile/level bytes. The decoder is configured **with**
     `description = avcC` and fed raw 4-byte length-prefixed AVCC
     samples directly. This sidesteps the Annex-B ordering pitfall
     where ffmpeg-encoded mp4s carry a leading AUD that, once
     prepended with SPS/PPS, made Chrome's H.264 parser reject the
     first chunk.
4. Either path then calls:
   ```js
   decoder.configure({
     codec: "avc1.64002A",         // derived per source kind (see above)
     description,                  // null for MCAP, avcC bytes for mp4
     hardwareAcceleration: "prefer-hardware",
     optimizeForLatency: false,    // replay, not live
   });
   ```
5. Decoder emits `VideoFrame`s with `timestamp = pts_ns / 1000` (WebCodecs
   takes PTS in µs; we preserve the ns value in a side map for exact
   comparisons).
6. Frames are forwarded to `VideoPanel`; the panel's blit loop picks the
   frame whose PTS matches the cursor and calls `.close()` on drained ones
   to release GPU memory.

## Seeking

`seek(target_ns)` from the transport:

1. Video-decode worker calls `decoder.reset()` (which implicitly
   discards in-flight frames) and tears down the active stream via
   `ops.close(streamId)`.
2. Re-opens the stream at `target_ns`. The keyframe-snap step is
   source-specific: MCAP delegates to `data-core` (binary search over
   the keyframe index baked into the channel slab); mp4 runs
   `pickStartCursor(index, target_ns)` against the in-memory sample
   table and snaps to the largest sync sample with `pts ≤ target_ns`.
3. Feeds chunks (MCAP) or pinned-active samples (mp4) into the
   decoder; frames with `pts < target_ns` are discarded on output
   (free + close). The first frame with `pts ≥ target_ns` is delivered
   to VideoPanel. The worker also retains the most-recent pre-target
   frame and emits it when the post-target frame arrives, so a paused
   scrub past the keyframe still lights up the canvas.
4. If the user is scrubbing continuously, seek calls are coalesced on a
   50 ms trailing debounce in the main thread. The debounce is gated on
   a `seekEpoch` counter, not on `cursorNs` — playback's 60 Hz cursor
   ticks advance via `advanceCursor` (no epoch bump) and so are
   invisible here, while user scrubs go through `setCursor` (epoch
   bump) and trigger the debounced seek even mid-playback.

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
  worth of NAL units), Annex-B framed (`00 00 00 01` start codes).
  These chunks go straight into `decoder.decode()` — the decoder is
  configured in Annex-B mode (no `description`) so framing is inline.
- The codec string is derived by scanning the first keyframe for an
  SPS NAL unit and reading `profile_idc` / constraint flags /
  `level_idc` from it (`findSps` + `codecStringFromSps`). MCAP channel
  metadata is not currently consulted for SPS/PPS extradata.
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
  newline. Surrounding ASCII whitespace inside each column is trimmed
  before parsing, so producers that pad numeric fields (e.g.
  `"0\t100 \n"` or `" 0 \t 100 \n"`) still open cleanly. The single-tab
  separator and exactly-two-fields invariants are still enforced. The
  frame column must equal the row's 0-based index — any skipped,
  reordered, or duplicated row fails the file open with a
  `sidecar line N: ...` error. A mismatch between the line count and the
  mp4's sample count also fails the open with a descriptive error.

### Open flow

1. User drops both `drive.mp4` and `drive.mp4.timestamps`. The UI pairs
   them by basename. If only one is dropped, the UI prompts for the other.
2. The main thread does **not** read the whole mp4 into memory. Instead
   `readMp4HeaderBytes(file)` (`apps/web/src/state/mp4HeaderSlice.ts`)
   walks the top-level box structure with small `File.slice()` reads,
   skips every `mdat`/`free`/`skip` body without allocation, and returns
   `[ftyp][moov]` concatenated — typically a few MB even on multi-GB
   recordings. Those header bytes (and only those) are handed to wasm.
   This is the OOM-avoidance fix that motivated the refactor: the
   previous flow `arrayBuffer()`-ed the whole mp4 on the main thread
   before the lazy cache could take over.
3. `Mp4SidecarReader::open` parses the header buffer to extract the
   sample table (`stts` / `ctts` / `stsc` / `stsz` / `stco`/`co64` /
   `stss`) and codec extradata. Sample chunk offsets stored in
   `stco`/`co64` are recorded in the index but **not dereferenced** at
   open time — they refer back into the source `File`, which the JS
   `Mp4SampleCache` will read lazily.
4. The sidecar array becomes the source of truth for `pts_ns` / `dts_ns`.
   The mp4's own `stts` / `ctts` offsets are ignored for synchronisation
   purposes — they are only used to compute `duration_ns` when the
   sidecar does not provide an end time for the last frame (we use
   `sidecar[i+1] - sidecar[i]` in the middle, and repeat the last delta
   at the end).
5. The wasm binding `mp4_sidecar_index` (in `wasm-bindings`) returns
   parallel typed arrays — `BigInt64Array ptsNs`, `BigUint64Array offsets`,
   `Uint32Array sizes`, `Uint8Array isSync`, plus `sps` and `pps` byte
   blobs. The main thread wraps the source `File` and the index in an
   `Mp4SampleCache` and stashes it on the `SourceMeta.mp4Cache` slot.
6. Generated Driveline channel has `kind = Video`; no signal channels are
   synthesised.

### Decode flow

The decoder is driven in **AVC (length-prefixed) mode** for mp4 sources:

1. `videoDecode` calls `mp4Index(handle)` over the `mp4Lazy` port at
   open time and uses `pickStartCursor(index, fromPtsNs)` to snap the
   start to the largest sync sample with `pts ≤ fromPtsNs`.
2. For each batch the worker pins the active range
   (`mp4SetActive(handle, lo, hi)`) so the cache won't evict samples
   the decoder is about to consume, then loops over
   `mp4Sample(handle, idx)` calls. Each call hits the cache; on a miss
   the cache issues a single `File.slice(offset, offset+size).arrayBuffer()`
   for that one sample, populates an LRU entry, and returns the bytes.
   Concurrent callers requesting the same sample share one in-flight
   promise.
3. Before the bytes are handed to the decoder, `stripInlineParameterSets`
   drops any in-band SPS/PPS NAL units (the x264 `repeat-headers=1`
   case). They're already in the `avcC` description, and when they
   appeared before the AUD they stalled the decoder.
4. The cache's budget defaults to half of `performance.memory.jsHeapSizeLimit`
   (clamped to a 64 MB floor; falls back to 512 MB on Firefox/Safari/node),
   computed in `apps/web/src/state/memoryBudget.ts`. Samples outside the
   active set are evicted in LRU order whenever the budget is exceeded
   or the browser reports `memoryPressure() === 'high'`.
5. The cache emits two notification streams to the session store:
   `loadedRanges` (rAF-coalesced — what's resident, in `[startNs, endNs]`
   pairs per source) and `pendingFetch` (a target ns, set when an
   awaited sample is not yet resident, cleared once it lands).

For MCAP the worker takes the simpler route: `openMcapVideoStream` /
`mcapVideoNextBatch` / `closeMcapVideoStream` produce Annex-B
`EncodedChunk`s that go straight into `decode()` after the SPS scan.

### Buffered ranges and pending-fetch UI

The two notification streams from `Mp4SampleCache` surface in the
transport bar:

- **`loadedRanges[sourceId]`** drives the `[data-testid="transport-buffered"]`
  strip — shaded segments under the scrubber showing which time ranges
  of the recording are currently resident in the cache. The strip
  re-renders only when the underlying ranges change (rAF-coalesced),
  not on every cursor tick.
- **`pendingFetch[sourceId]`** drives the `[data-testid="transport-fetch-spinner"]`
  marker — a small spinner positioned at the requested time, shown
  while a cold seek is awaiting bytes from disk and removed once the
  first sample of the new batch lands. This is the user-visible
  signal that the lazy cache had a miss; on a warm-cache seek the
  spinner never appears.

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
