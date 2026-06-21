// Issue #2 — shared cursor-gating epsilon.
//
// Leaf constants module (imports nothing) so both the playback loop
// (`timeline/playback.ts`) and the video panel (`panels/VideoPanel.tsx`)
// consult one definition instead of each keeping a hand-copied literal
// that can silently drift. Keeping it a leaf avoids any panels↔timeline
// import cycle: nothing here depends on either side.
//
// Rationale: ε must exceed the STEADY-STATE lag between the cursor and the
// newest blitted frame, or the gate fires during healthy playback and
// throttles the cursor into slow-motion (measured: at ε=100 ms on ~12 fps
// nuScenes the cursor was gated ~62 % of ticks → 0.38× playback, even with
// the decoder 763 ms ahead and 9 frames queued). That steady-state lag =
// setCursor coalescing (~33 ms) + frame quantisation (≈ one inter-frame
// interval). At 30/60 fps that interval is ~17–33 ms so 100 ms covered it,
// but low-rate camera streams (nuScenes CAM_FRONT ≈ 12 fps → ~85 ms frames)
// push the lag to ~130 ms, above the old ε. 300 ms comfortably clears the
// low-rate case while still catching a genuine stall (whose lag grows
// without bound).
export const READY_EPSILON_NS = 300_000_000n;
