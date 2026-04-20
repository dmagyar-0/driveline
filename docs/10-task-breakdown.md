# 10 — Future Work

The MVP described in `01-vision-and-scope.md` has shipped. This file
keeps track of items deliberately deferred past the MVP — additions
that were considered, scoped, and parked for later.

Nothing here is currently planned. Pick items up as requirements firm
up; delete items that turn out to be unnecessary.

## Deferred to post-MVP

- **Live streaming source.** Currently only recorded logs are
  supported. A Foxglove-style WebSocket consumer would require a
  new `Reader` variant that emits chunks as they arrive rather than
  pre-indexing the full range at `open`.
- **Tauri desktop wrapper.** The architecture preserves this: the
  `data-core` crate compiles natively, and `wasm-bindings` is the only
  browser-specific shim. A Tauri build would replace the bindings
  shim with a native adapter and drop WebCodecs in favour of
  `VideoDecoder` equivalents on the native side.
- **Schema-aware decoding of MCAP message payloads.** Today MCAP
  messages are classified and stored as scalar / vector / enum /
  bytes. Foxglove-style per-schema decoding (protobuf, ROS msg, etc.)
  would let the channel picker surface nested fields.
- **H.265, AV1, VP9.** The WebCodecs plumbing is codec-agnostic but
  the SPS scan in `videoDecode.worker.ts` is H.264-specific. Adding a
  second codec means a parallel "find parameter set" path plus
  per-codec config-string derivation.
- **Annotations / labels / markers.** Storing and rendering user-
  attached timeline annotations.
- **Shareable session URLs / cloud storage.** Currently everything is
  local; nothing leaves the browser.
- **Pre-decoded poster thumbnail strip.** A video-scrubber preview
  strip. Would need a second `VideoDecoder` instance running in
  parallel at low resolution.
- **Per-source time offset UI.** Sources with a known clock skew
  could be shifted by a user-supplied `offsetNs`. The `Reader`
  abstraction already supports this in principle; the UI is missing.
- **OPFS caching for large files.** Reopening the same MCAP currently
  re-parses the whole file. Origin Private File System storage would
  let us cache the parsed index.
- **Formal accessibility audit.** Keyboard navigation works for the
  transport bar today but hasn't been audited end-to-end.

## Out of scope for the original MVP — see `01-vision-and-scope.md`

The vision doc lists the MVP boundary and the non-goals. Cross-check
there before adding anything from the list above.
