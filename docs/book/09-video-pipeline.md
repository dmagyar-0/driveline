# Chapter 9 — The Video Pipeline: WebCodecs on the Canvas

Playing back a 4K H.264 stream in a browser used to be the exclusive
domain of the `<video>` tag. Driveline doesn't use `<video>` at all,
because `<video>` can't open a file sitting inside an MCAP container
and can't be seek-aligned to nanosecond telemetry.

Instead, every video frame goes through the **WebCodecs API**: a
relatively recent browser API that exposes the raw hardware decoder.
This chapter follows a single frame from encoded bytes to pixels on
the canvas.

## The pipeline at a glance

There are two routes for encoded bytes — one per source kind. Both
land in the same `videoDecode` worker, which is source-agnostic from
`decode()` onward.

**MCAP** — `dataCore` produces Annex-B `EncodedChunk`s and
`videoDecode` scans the first keyframe for an SPS to derive the codec
string:

```
┌──────────────┐     ┌────────────────┐     ┌──────────────┐
│ dataCore     │  →  │ videoDecode    │  →  │ VideoPanel   │
│ (Rust/WASM)  │     │ worker         │     │ (main thread)│
│ EncodedChunk │     │ VideoDecoder   │     │ canvas blit  │
└──────────────┘     └────────────────┘     └──────────────┘
      ↑                    ↑                      │
      └ slab handle ───────┘                      │
                  MessagePort bridge              │
                                                  ↓
                                             user sees a
                                             frame
```

**MP4 + sidecar** — `dataCore` is consulted **only at open time** to
parse the moov box and hand back a sample index (offsets, sizes, sync
flags, PTS, plus SPS+PPS). After that the `videoDecode` worker pulls
sample bodies straight from `Mp4SampleCache` on the main thread over a
separate `mp4Lazy` `MessagePort`, and the decoder runs in AVC
(length-prefixed) mode against a synthesised `avcC` description:

```
┌──────────────┐                          ┌────────────────┐     ┌──────────────┐
│ dataCore     │  ── sample index ──────▶ │ videoDecode    │  →  │ VideoPanel   │
│ (open time)  │     (once at open)       │ worker         │     │ (main thread)│
└──────────────┘                          │ VideoDecoder   │     │ canvas blit  │
                                          └────────────────┘     └──────────────┘
                                                ↑   ↓
                                                │   │ mp4Sample(handle, idx)
                                                │   │
┌──────────────────┐                            │   │
│ Mp4SampleCache   │ ◀── mp4Lazy MessagePort ───┘   │
│ (main thread)    │ ────── sample bytes ───────────┘
│ LRU + on-demand  │
│ File.slice()     │ ──── reads from source File on miss
└──────────────────┘
```

The dataCore worker owns the open file metadata. The videoDecode
worker owns the `VideoDecoder`. The main thread owns the canvas — and
for mp4 sources, also owns the lazy sample cache and the source `File`
blob. `VideoFrame` objects travel from worker to main thread as
transferred messages in both routes.

## The decoder configuration problem

`VideoDecoder.configure({ codec })` wants a string like `"avc1.64002A"`.
That string encodes the H.264 profile, constraint flags, and level —
parameters that must match the bitstream or the decoder errors out.

Driveline could hard-code a codec string per format. Instead, it
discovers the parameters at open time. The route depends on the source
kind, because MCAP and mp4 expose H.264 parameter sets differently.

### MCAP: scan the first keyframe for an SPS

In MCAP, the encoded stream is Annex-B (`00 00 00 01` start codes), and
the SPS is just another NAL unit interleaved with slices. An H.264
stream's **Sequence Parameter Set** (SPS) is a NAL unit (type 7)
emitted before the first keyframe. The videoDecode worker scans the
first keyframe's Annex-B bytes for it:

```ts
function findSps(annexB: Uint8Array): Uint8Array | null {
  let i = 0;
  while (i + 2 < annexB.length) {
    const is3 = annexB[i] === 0 && annexB[i+1] === 0 && annexB[i+2] === 1;
    const is4 = /* ... 00 00 00 01 ... */;
    if (!is3 && !is4) { i += 1; continue; }
    const nalStart = i + (is4 ? 4 : 3);
    const nalType = annexB[nalStart] & 0x1f;
    if (nalType === 7) {
      // ... slice out the SPS body, bounded by the next start code ...
    }
    i = nalStart + 1;
  }
  return null;
}
```

Bytes `[0..3]` of the SPS payload — `profile_idc`, constraint flags,
`level_idc` — form the codec string:

```ts
function codecStringFromSps(sps: Uint8Array): string {
  if (sps.length < 3) return "avc1.64002A";      // safe default
  return `avc1.${hex(sps[0])}${hex(sps[1])}${hex(sps[2])}`;
}
```

The result is used to `configure` the decoder. A test fixture using
H.264 High Profile, Level 4.2 becomes `avc1.64002A`; a different
encoder emits a different string; the pipeline adapts. For MCAP, the
decoder is configured **without** a `description` — Annex-B start
codes do the framing inline.

### MP4: lift SPS+PPS out of the moov

mp4 doesn't need the scan. The SPS and PPS live in
`avcC` extradata inside the moov's sample-description box, and the wasm
`Mp4SidecarReader` extracts them at parse time. The `mp4_sidecar_index`
binding returns them alongside the per-sample arrays, and
`buildAvccDescription(sps, pps)` (in `mp4AnnexB.ts`) re-emits a standard
`AVCDecoderConfigurationRecord` per ISO/IEC 14496-15 §5.3.3.1.2:

```ts
const description = buildAvccDescription(index.sps, index.pps);
const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
decoder.configure({ codec, description, ... });
```

The decoder is configured **with** that `description`, and the worker
feeds raw 4-byte length-prefixed AVCC samples directly. There is no
Annex-B conversion on the mp4 path. This is the fix for ffmpeg-encoded
mp4s whose samples carry a leading AUD: with Annex-B prepending,
SPS/PPS landed *before* the AUD and Chrome's H.264 parser rejected the
chunk with `DataError: A key frame is required after configure() or
flush()`. AVC mode + an explicit `description` sidesteps the entire
ordering minefield.

### `isConfigSupported`

Before configuring, the worker asks the browser whether the codec
string is actually supported:

```ts
const supported = await VideoDecoder.isConfigSupported(baseConfig);
if (!supported.supported) {
  throw new Error(`videoDecode: codec not supported by this browser: ${codec}`);
}
decoder.configure(baseConfig);
```

Chromium Headless (used in Playwright tests) rejects `prefer-hardware`
when no hardware decoder is wired in, so the config is deliberately
minimal. The error path surfaces as a rejected `open()` promise, which
the panel turns into a console error.

## Decoding one frame

With the decoder configured, each `EncodedChunk` becomes an
`EncodedVideoChunk`:

```ts
const chunk = new EncodedVideoChunk({
  type: c.is_keyframe ? "key" : "delta",
  timestamp: ptsToMicros(c.pts_ns),   // nanoseconds → microseconds
  data: c.data,
});
session.decoder.decode(chunk);
session.inFlight += 1;
```

`decode()` returns synchronously. The actual decode happens
asynchronously on the GPU; when a frame is ready, the browser fires
the `output` callback provided at construction time:

```ts
const decoder = new VideoDecoder({
  output: (frame) => onFrame(frame),
  error: (e) => console.error("VideoDecoder error:", e),
});
```

`frame` is a `VideoFrame` object: an opaque handle backed by GPU
memory that can be drawn to a canvas without a round-trip through
pixel buffers.

## The seek-prime discard gate

H.264 is built on motion compensation: a "delta" frame depends on the
previous keyframe plus every delta between them. When the user
scrubs to the middle of a clip, the decoder can't start at the exact
target frame — it has to rewind to the nearest keyframe and replay
deltas forward.

Those pre-target frames are *needed for decoding* but must not be
*shown*. The worker's `onFrame` enforces that:

```ts
function onFrame(frame: VideoFrame): void {
  session.inFlight = Math.max(0, session.inFlight - 1);
  const ptsNs = BigInt(frame.timestamp) * 1000n;
  if (ptsNs < session.discardBeforePtsNs) {
    frame.close();           // prime frame; drop it
    void maybeRefill();
    return;
  }
  if (!session.sink) {
    frame.close();           // no consumer; drop
    void maybeRefill();
    return;
  }
  session.frameIndex += 1;
  session.sink.postMessage(
    { ptsNs, frame, frameIndex: session.frameIndex, decodeQueue: ... },
    [frame],                 // transfer, don't copy
  );
  void maybeRefill();
}
```

The `discardBeforePtsNs` field is set to the seek target at
`openInternal` time. Frames earlier than that are silently dropped
after they've done their job (populating the decoder's reference
buffers). From the user's perspective, scrubbing to "3.2 seconds"
shows the frame at 3.2 seconds, not the keyframe at 3.0 seconds.

## Transferring the frame

`session.sink.postMessage({ ... }, [frame])` is the crucial line.
Without the second argument, the structured-clone algorithm would
either copy the pixels (slow) or fail (some browsers refuse to clone
`VideoFrame`). With it, `frame` is **transferred** — the worker
instantly loses the handle, and the main thread instantly gains it.

On the main thread, `VideoPanel`'s message handler enqueues it:

```tsx
port.onmessage = (ev: MessageEvent) => {
  const { ptsNs, frame, frameIndex, decodeQueue } = ev.data;
  if (queueRef.current.length >= MAX_QUEUE) {
    const dropped = queueRef.current.shift();
    dropped?.frame.close();
    droppedFramesRef.current += 1;
  }
  queueRef.current.push({ ptsNs, frame, frameIndex, decodeQueue });
  if (!sizedRef.current) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    sizedRef.current = true;
  }
};
```

The queue caps at `MAX_QUEUE` (8). A stalled blit loop is never worth
starving the GPU frame pool, so the oldest gets dropped when the
queue fills. Every drop increments a counter surfaced in the HUD.

## Blitting to the canvas

`VideoPanel` runs a `requestAnimationFrame` loop. Each tick picks the
newest frame whose PTS is ≤ the cursor:

```tsx
const tick = () => {
  const q = queueRef.current;
  const cursor = cursorRef.current;
  let blitIdx = -1;
  for (let i = 0; i < q.length; i++) {
    if (q[i].ptsNs <= cursor) blitIdx = i;
    else break;
  }
  if (blitIdx >= 0) {
    const target = q[blitIdx];
    for (let i = 0; i < blitIdx; i++) q[i].frame.close();
    q.splice(0, blitIdx);
    ctx.drawImage(target.frame, 0, 0, canvas.width, canvas.height);
    target.frame.close();
    q.shift();
  }
  rafRef.current = requestAnimationFrame(tick);
};
```

- The loop walks forward while the next frame is still behind the
  cursor; it stops at the first frame *ahead* of the cursor. That
  leaves `blitIdx` pointing at the newest frame in `[−∞, cursor]` —
  exactly the one to show.
- Every frame strictly before the blit target is `.close()`-d. Not
  closing them would leak GPU memory; the frame pool is small, and
  leaking fills it in seconds.
- `ctx.drawImage(target.frame, ...)` copies the decoded frame into
  the canvas's backing store. After that, the canvas is independent
  of the `VideoFrame`, and the frame is closed.
- The blitted PTS is published on `window.__drivelineVideoLastBlitPtsNs`.
  Playwright tests assert on that value to verify the cursor lands on
  the right frame.

## Seeking

The cursor changes thousands of times a second when the user drags
the scrubber, **and** another 60 times a second once playback is
running. Issuing a worker `seek()` on every change would thrash the
decoder; treating *no* cursor change as a seek would mean the canvas
freezes on a mid-playback scrub. `VideoPanel` distinguishes the two
using a `seekEpoch` counter on the session store: only user-initiated
cursor moves (scrub, keyboard step, Home/End, play-from-end rewind)
bump it, while the playback rAF advances via `advanceCursor`, which
doesn't.

The panel subscribes to the store directly (not via a reactive
selector) and gates the debounced seek on the epoch, not on
`cursorNs`:

```tsx
const unsubscribe = useSession.subscribe((state, prev) => {
  cursorRef.current = state.cursorNs;
  // ... push a coalesced cursor watermark to the worker (~30 Hz) ...
  if (state.seekEpoch === prev.seekEpoch) return;
  if (seekTimerRef.current !== null) clearTimeout(seekTimerRef.current);
  seekTimerRef.current = setTimeout(() => {
    seekTimerRef.current = null;
    const target = useSession.getState().cursorNs;
    if (lastSeekTargetRef.current === target) return;
    lastSeekTargetRef.current = target;
    for (const e of queueRef.current) e.frame.close();
    queueRef.current = [];
    void client.seek(target).catch(() => undefined);
  }, SEEK_DEBOUNCE_MS);   // 50ms
});
```

The worker's `seek` tears down the old stream, opens a new one at the
target, and lets the decoder rebuild state:

```ts
async seek(targetNs: bigint): Promise<void> {
  if (!session) return;
  if (session.lastOpenedFromNs === targetNs) return;  // already there
  const { sourceKind, sourceHandle, channelId, ops } = session;
  try { session.decoder.reset(); } catch {}
  try { await ops.close(session.streamId); } catch {}
  await openInternal(sourceKind, sourceHandle, channelId, targetNs);
}
```

Note the two duplicate-target guards (one in the panel, one in the
worker). They look redundant but cover different cases: the panel's
guard blocks a seek when the user released the scrubber on the same
value that was already blit-aligned; the worker's guard catches a
follow-up `seek()` that arrives after `open()` has already positioned
the stream to the same target.

## The HUD

Pressing `h` while the video panel has focus toggles a small diagnostic
overlay:

```
PTS         1042.533 ms
frame #     63
decodeQueue 0
blitQueue   2 / 8
dropped     0
codec       avc1.64002A
```

Every field in it is a ref the rAF loop writes into a single DOM text
node. None of it goes through React state — 60 Hz updates would thrash
the reconciler. The same snapshot object is also published at
`window.__drivelineVideoHud` for Playwright to assert on.

## Why not `<video>`?

Summarising what the pipeline buys us:

- **Source flexibility.** `<video>` needs a URL or a `MediaSource`.
  We have bytes sitting inside an MCAP/MP4 container on the user's
  disk, extracted by Rust.
- **Exact frame addressing.** We can seek to a nanosecond timestamp
  and blit *the* frame that owns that timestamp, not whatever the
  browser's fuzzy keyframe alignment chose.
- **Cursor sync.** The same `cursorNs` that the plot panel reads is
  what the rAF loop uses to pick a frame. No cross-pipeline sync
  problem.
- **Frame-level diagnostics.** `decodeQueueSize`, explicit keyframe
  flags, per-frame PTS, HUD — none of which `<video>` exposes.

The price is that Driveline has to own the whole pipeline, including
SPS parsing and frame lifecycle. Chapters 6–8 have already done most
of that work; this chapter just put the last piece on the canvas.

Chapter 10 zooms back out to the timeline: how the cursor moves in the
first place.
