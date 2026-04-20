# 08 — Open Questions (Post-MVP)

All MVP-blocking risks are resolved; `mf4-rs` compiles to WASM, the
WebCodecs path works on Chromium, and `log_time` semantics were
tractable for the sample corpus. What remains is a short list of
genuinely open questions that only matter once Driveline grows past
the MVP.

The historical risk register (R1–R8 from the original planning) has
been removed — each risk was either mitigated in code or shown to be a
non-issue in practice. Consult git history if you need the old
analysis.

---

## Memory ceiling for very large logs

The current code streams reads but keeps the parsed index in memory.
A 10+ GB MCAP would index in single-digit seconds and then sit in a
tab budget of a few GB. Open:

- **Graceful behaviour when the user drops something too big.** The
  MVP answer was "open it and see what happens." For production we
  probably want a size probe and an upfront warning.
- **OPFS caching for hot chunks.** Origin Private File System would
  let us spill the chunk cache to disk. Currently in-memory only.

## Per-source clock skew

Different recorders stamp MCAP `log_time` at slightly different
moments (capture vs queue vs publish). Driveline currently trusts
`log_time` as capture-instant. Open:

- **Warn when video `log_time` span disagrees with the MP4 container
  duration by more than a threshold.** Low-cost signal; not
  implemented.
- **Per-source time offset UI.** The store already leaves room for
  it. No UI yet.

## Keyframe sparsity scrub UX

Real-world recorders emit keyframes every 2–5 s to save bandwidth,
which makes scrubbing visibly laggy. Driveline does not transcode and
will not. Open:

- **Pre-decoded poster grid.** Decode one low-resolution frame per
  second at open time and keep them as scrub previews. Would need a
  second `VideoDecoder` instance in parallel.

## Codec coverage

H.264 only today. See `10-task-breakdown.md` for the codec-expansion
entry — notable here because the SPS scan in `videoDecode.worker.ts`
is H.264-specific and any second codec (H.265, VP9, AV1) needs its
own parameter-set extraction.

## Browser coverage beyond Chromium

Chromium and Edge are the primary targets. Firefox ships WebCodecs
from 130+ but may have format-support gaps. Safari is out of scope.
Open:

- **Do we invest in a non-WebCodecs software fallback?** The MVP
  answer was "no" — 4K software decode on the main thread would ship
  a worse experience. Revisit if there's ever demand for Safari /
  older-browser support.

## Shareable sessions

Driveline stores everything in the tab. No URLs, no cloud, no
multi-user. If that ever changes:

- Session URLs would need a stable source-identity scheme (hash of
  file bytes? manifest of byte-ranges?).
- Cloud-hosted logs would require a range-request `Reader` variant
  and a view of `log_time` that doesn't assume the whole file is
  local.

These are bigger pieces than the earlier items — each would change the
architecture materially, not just add a file.
