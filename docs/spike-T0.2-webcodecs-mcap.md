# Spike T0.2 — WebCodecs + MCAP H.264 feasibility

**Status:** investigation complete; implementation pending.
**Related:** `10-task-breakdown.md` T0.2, `05-video-pipeline.md`,
`08-risks-and-open-questions.md` R2.
**Date:** 2026-04-17.

---

## 1. Verdict — GO

Every primitive the spike needs exists in stable form today:

- MCAP parsing from a `Blob` in the browser has a first-party TypeScript
  SDK (`@mcap/core` + `@mcap/browser` + `@mcap/support`) maintained by
  Foxglove.
- Foxglove standardised H.264 in MCAP behind the
  `foxglove.CompressedVideo` schema; the payload is Annex-B with SPS+PPS
  prepended to every IDR, which means we can build an `avcC` record from
  the first keyframe without external files.
- WebCodecs `VideoDecoder` is available in a secure context on Chrome/Edge
  94+, Firefox 130+, and Safari 26+. H.264 decode is hardware-accelerated
  on all three.

The only non-trivial piece of the spike is synthesising the AVCC
`description` record from the SPS and PPS NAL units in the stream. That
is roughly 30 lines of byte wrangling. Chrome also accepts Annex-B input
with `description` omitted, so the spike can take the easy path first
and tighten portability later.

COOP/COEP headers are **not** required for WebCodecs itself. A plain
`python3 -m http.server` serving the static HTML over `http://localhost`
is sufficient.

## 2. Dependencies

| Package | Version | Role |
|---|---|---|
| `@mcap/core` | latest | `McapIndexedReader` for summary + range reads |
| `@mcap/browser` | latest | `BlobReadable` adapter for `File` / `Blob` |
| `@mcap/support` | latest | `loadDecompressHandlers()` — zstd/lz4 WASM (~200 KB) |
| `@foxglove/schemas` or `protobufjs` | latest | Decode `CompressedVideo` message payload |

No build system required for the spike: ESM from `esm.sh` or a one-file
bundler (`esbuild index.js --bundle --outfile=out.js`) is enough.

## 3. Spike scope (one HTML file, ~200 LOC)

1. `<input type=file>` → `File`.
2. `BlobReadable` + `McapIndexedReader.Initialize({ readable,
    decompressHandlers })`.
3. Walk `reader.channelsById` joined to `reader.schemasById`; pick the
   first channel whose `schema.name` is `foxglove.CompressedVideo` or
   `foxglove_msgs/msg/CompressedVideo`.
4. `for await (msg of reader.readMessages({ topics: [topic] }))`: decode
   the payload (protobuf via the Foxglove schema, JSON, or CDR depending
   on `messageEncoding`), check `format === "h264"`, stop at the first
   message whose payload contains an IDR NAL (`nal_unit_type == 5`).
5. Scan the Annex-B bytes for SPS (`type 7`) and PPS (`type 8`). Build an
   `avcC` record (see §4). Derive the codec string from SPS bytes 1–3.
6. `await VideoDecoder.isConfigSupported({ codec, description })` — bail
   out with a clear message if unsupported.
7. `decoder.configure(config)`; construct one `EncodedVideoChunk` with
   `type: "key"`, `timestamp: 0`, `data` in the matching framing
   (AVCC-length-prefixed if `description` was supplied, Annex-B if not).
8. `decoder.decode(chunk); await decoder.flush();` — the `flush()` is
   load-bearing; without it the output callback may never fire for a
   single-chunk pipeline.
9. In the `output` callback: `canvas.width = frame.displayWidth;
   canvas.height = frame.displayHeight; ctx.drawImage(frame, 0, 0);
   frame.close();`.

## 4. Building `avcC` from SPS/PPS

ISO/IEC 14496-15 §5.3.3.1 layout, all big-endian:

```
u8  configurationVersion = 1
u8  AVCProfileIndication  = SPS[1]
u8  profile_compatibility = SPS[2]
u8  AVCLevelIndication    = SPS[3]
u8  0xFC | (lengthSizeMinusOne & 0x03)   // 0xFF → 4-byte NAL length prefix
u8  0xE0 | numOfSPS
  { u16 spsLen; u8 sps[spsLen] } × numOfSPS
u8  numOfPPS
  { u16 ppsLen; u8 pps[ppsLen] } × numOfPPS
```

Where `SPS[0]` is the NAL header byte (`0x67`) and `SPS[1..3]` are
`profile_idc`, constraint-set flags, `level_idc`. Those same three bytes
give the codec string: `` `avc1.${hex(SPS[1])}${hex(SPS[2])}${hex(SPS[3])}` ``
(e.g. `avc1.64002A` = High @ L4.2).

No full SPS/HRD parser is required for `configure()`. A ~30-line
start-code scanner identifies NAL boundaries; `OllieJones/h264-interp-utils`
(npm) handles this if preferred.

## 5. Two framing modes

**Annex-B + no `description`.** Chrome ≥ M107 accepts this for H.264.
Each keyframe chunk must carry its own SPS+PPS — Foxglove's producer
does this by default, so we're already set. Safari and Firefox support
is less guaranteed; feature-detect with `isConfigSupported`.

**AVCC + `description`.** Portable across all three engines. Requires
rewriting the keyframe bytes: strip start codes (`00 00 00 01` or
`00 00 01`) and prepend a 4-byte big-endian length for each NAL. Build
`description` once from the first SPS+PPS seen.

Recommendation: do Annex-B for the spike; add the AVCC path in M5 when
we need Safari/Firefox as a secondary target.

## 6. Channel-discovery details

- `foxglove.CompressedVideo` fields: `timestamp` (time), `frame_id`
  (string), `data` (bytes, **Annex-B**), `format` (string: `"h264"`,
  `"h265"`, `"vp9"`, `"av1"`). Foxglove's own encoder refuses B-frames
  and always prepends SPS+PPS to every IDR.
- `messageEncoding` on the channel determines the payload decoder:
  `protobuf` → `@foxglove/schemas` + protobufjs; `json` → `JSON.parse`;
  `cdr` (ROS 2) → `@foxglove/rosmsg2-serialization`.
- `sensor_msgs/CompressedImage` is JPEG/PNG, not H.264 — ignore.
- Shortcut for the spike: we control the fixture (T0.3). Generate it as
  `messageEncoding: "json"` and the payload decode is one
  `JSON.parse` + `atob`.

## 7. Gotchas

- **Secure context.** Plain `file://` won't work. Serve via
  `python3 -m http.server` or `npx serve`.
- **`flush()` is not optional.** A single-chunk decode pipeline may
  buffer forever without `await decoder.flush()`.
- **Canvas sizing.** Set `canvas.width/height` from
  `frame.displayWidth/displayHeight` **before** the first `drawImage`,
  otherwise the frame is scaled to the default 300×150.
- **`frame.close()`.** Every delivered `VideoFrame` must be closed;
  Chrome's GPU frame pool is small. Non-issue for a single-keyframe
  spike; load-bearing in the full pipeline.
- **Non-indexed MCAPs.** `McapIndexedReader.Initialize` throws for MCAPs
  without a summary. Not expected for our fixture, but fall back to
  `McapStreamReader` if seen in real customer files.
- **Producers that only emit SPS/PPS once.** The Foxglove encoder does
  not, but third-party MCAPs may. Cache SPS/PPS from stream start; if
  an IDR lacks them, fall back to the cached pair.
- **Linux VAAPI flakiness.** Chrome on Linux may need
  `--enable-features=AcceleratedVideoDecodeLinuxGL` for hardware decode.
  Spike should log the `VideoDecoderConfig.hardwareAcceleration` actually
  chosen.

## 8. Acceptance mapping

Task acceptance from `10-task-breakdown.md`:

1. Page opens, loads fixture via `<input type=file>` — satisfied by
   standard file input.
2. Produces a `<canvas>` with the first keyframe rendered — satisfied
   via the §3 sequence.
3. Works in Chrome current stable — all primitives are stable since
   M94, H.264 hardware decode since M107 on Linux with the flag above,
   earlier on macOS/Windows.

## 9. Deliverables when the spike is implemented

- `spikes/t0.2-webcodecs-mcap/` directory containing:
  - `index.html` — `<input type=file>` page.
  - `main.js` — ESM entry; all logic inline.
  - `package.json` — pins the four npm deps.
  - `README.md` — run instructions.
- An update to this doc's verdict (turn `GO` into `GO, verified`).
- A short note in `08-risks-and-open-questions.md` R2 if we hit any
  surprise during implementation.

## 10. References

- MCAP TS SDK: <https://mcap.dev/docs/typescript>
- `@mcap/core` / `@mcap/browser` / `@mcap/support` on npm
- Foxglove H.264 announcement:
  <https://foxglove.dev/blog/announcing-h264-support-in-foxglove>
- `foxglove.CompressedVideo`:
  <https://docs.foxglove.dev/docs/sdk/schemas/compressed-video>
- WebCodecs spec: <https://www.w3.org/TR/webcodecs/>
- WebCodecs AVC registration:
  <https://w3c.github.io/webcodecs/avc_codec_registration.html>
- Chrome WebCodecs best practices:
  <https://developer.chrome.com/docs/web-platform/best-practices/webcodecs>
- MDN `VideoDecoder`:
  <https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder>
- AVCC layout reference:
  <https://virinext.com/avc-bitstream-formats-and-decoder-configuration-record/>
- `h264-interp-utils`: <https://github.com/OllieJones/h264-interp-utils>
