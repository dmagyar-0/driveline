# Design Patterns, Modularity, Cohesion & Separation-of-Concerns Audit

**Date:** 2026-06-22
**Branch:** `claude/design-patterns-modularity-audit-45yq5b`
**Method:** Read-only architectural fan-out — five domain audits (state, panels,
workers/agent/llm, Rust `data-core`, shell/layout/wasm-bindings). Findings are
graded by severity, effort (S/M/L) and risk, with explicit attention to the
project's deliberate constraints (single Zustand store, CSS Modules, BigInt-ns
discipline, the cursor/video hot path, and the cross-language Arrow IPC contract).

## Executive summary

The codebase is, on the whole, **well-factored and disciplined.** The recurring
issues are not architectural rot but **growth pressure**: a handful of files have
become god-files under their own weight, and several copy-paste "families" exist
that the codebase *already has a proven pattern to collapse* (dispatch tables,
canonical-shape helpers, shared pure transforms).

Two things stand out as genuinely good and were explicitly judged **NOT** defects
(don't "refactor them away"):

- `crates/wasm-bindings/src/lib.rs` is a textbook **thin facade** — every endpoint
  borrows a slab, calls a `data-core` `Reader` method, serialises. No business
  logic leaks in. `data-cli` and `wasm-bindings` do **not** duplicate orchestration;
  both are thin shims over the same `Reader` trait + Arrow producers.
- `state/bindings.ts` (canonical-shape pattern), the `FETCH_RANGE_BY_KIND` /
  `CLOSE_METHOD_BY_KIND` dispatch tables, the persistence shards, and the
  never-throw agent contract are all model implementations.

### God-files (size-verified)

| File | LOC | Note |
| --- | --- | --- |
| `state/store.ts` | 3741 | Types + mappers + ingestion FSM + binding CRUD + bookmarks + fetch dispatch + factory |
| `workers/videoDecode.worker.ts` | 1876 | Decode state machine **+** ~340 LOC self-contained cadence instrumentation |
| `crates/data-core/src/mcap.rs` | 1846 | Summary parsing + ROS2 CDR expansion + NAL/Annex-B video scanning |
| `panels/VideoPanel.tsx` | 1688 | Video blit **+** a ~250 LOC LiDAR point-cloud overlay sub-system |
| `panels/PlotPanel.tsx` | 1547 | uPlot build effect ~250 LOC of inline assembly |
| `shell/UnknownFormatDialog.tsx` | 1359 | Four weakly-related sub-flows in one module |
| `App.tsx` | 1014 | ~83% is the inlined `window.__driveline*` dev-hook surface |
| `agent/agentApi.ts` | 969 | Thin facade **+** heavy `snapshotAt`/sampling business logic |

## Consolidated findings

Full per-domain tables follow. Each finding: **Severity · Category · Location ·
Effort · Risk**. `Category ∈ {Pattern, Modularity, Cohesion, SoC}`.

### State layer (`apps/web/src/state/`)

| ID | Sev | Cat | Location | Finding | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| STATE-01 | High | Cohesion | `store.ts` (whole) | God-file owns ~7 distinct concerns | L | Low–Med |
| STATE-02 | High | SoC | `store.ts:2671-3195` `openFiles` + siblings | ~900-line ingestion concern; 11 copy-paste `open*` loops | L | Med |
| STATE-03 | Med | SoC | `store.ts:2360-2543` | Bookmark/event-tag domain logic inline in factory | M | Low |
| STATE-04 | Med | Pattern | `store.ts:1168-1444` | 9 near-identical `*Channels` builders (2 byte-identical) | S | Low |
| STATE-05 | Med | Cohesion | `store.ts:1490-1539,3717-3731` | `removeSource` hand-enumerates 9 binding maps — the bug class `bindings.ts` exists to prevent | M | Low |
| STATE-06 | Med | Modularity | `bindings.ts:19`, many `import type … from "./store"` | Leaf modules depend on the god-file for types (inverted direction) | S | Low |
| STATE-07 | Med | SoC | `tabularImport.ts:161-170` | UI presentation strings (`timeUnitLabel`) live in the state layer | S | Low |
| STATE-08 | Low | Cohesion | `store.ts:2622-2669` | 4 identical `*FrameTimes` actions | S | Low |
| STATE-09 | Low | Pattern | `store.ts:2671-3195` | `open` path still uses the if/else ladder the dispatch tables replaced | — | — |
| STATE-10 | Low | SoC | `store.ts:1945-1958` | Layout/active-id invariant lives in call ordering, not a guarded helper | S | Low |
| STATE-11 | Low | SoC | `tabularImport.ts:168` | (Confirmed compliant — BigInt narrowing only at the frozen wasm JSON boundary) | — | None |

### Panels (`apps/web/src/panels/`)

| ID | Sev | Cat | Location | Finding | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| PANEL-01 | Med | Pattern | `boxesFromArrow.ts:66` + 3 others | `listRowF32`/`listRowI32`/`ListCol`/`ListData` byte-identical across 4–5 decoders (`calibrationFromArrow` already has the generic) | S | None |
| PANEL-02 | Med | Pattern | 4 geometry decoders | `ts`-extraction block duplicated verbatim | S | None |
| PANEL-03 | Med | Cohesion | `VideoPanel.tsx:782-892` | ~250 LOC LiDAR overlay sub-system embedded in the video panel | M | Hot-path |
| PANEL-04 | Med | Cohesion | `PlotPanel.tsx:555-809` | ~250 LOC inline uPlot option assembly; extract `buildPlotOptions()` factory | M | Med |
| PANEL-05 | Low | Pattern | `ScenePanel.tsx:154-362` | ~200 LOC branch-per-kind; a renderer-strategy table is the missing pattern | M | Hot-path |
| PANEL-06 | Low | Modularity | `VideoPanel.tsx:604-637` | Panel reaches into store source internals to build the mp4 relay | M | Med |
| PANEL-07 | Low | Pattern | `PlotPanel.tsx:337-346` | Hand-rolls the stale-binding cull the other 4 panels get from `usePanelChannels` | S | None |
| PANEL-08 | Low | SoC | `VideoPanel.tsx:944-1000` | HUD/stats string formatting inline in the rAF tick | S | Hot-path |

### Workers / Agent / LLM

| ID | Sev | Cat | Location | Finding | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| WAL-01 | Med | Cohesion | `videoDecode.worker.ts` (~L509-813) | ~340 LOC cadence/smoothness instrumentation in the decode god-file; extract `videoCadence.ts` | M | Low |
| WAL-02 | Med | Cohesion/SoC | `agentApi.ts:742-803,381-419,619-654` | `snapshotAt`/`sampleScalarAt`/column-decode are session-analysis logic wearing a facade | M | Low–Med |
| WAL-03 | Low | Modularity | `agentApi.ts:815-936` | `bindChannels` reaches into store internals; should delegate to one store action | M | Med |
| WAL-04 | Low | Pattern | `engine.ts:108-151` | `buildTools()` returns `unknown[]`; the two client tools have known shapes | S | Low |
| WAL-05 | Low | SoC | `layoutProposal.ts` | 4 concerns in one module; `sanitizeProposal` is pure+tested+reusable — split out | S | Low |
| WAL-06 | Low | Cohesion | `dataCore.worker.ts` | ~10× identical `fetchRange` transfer bodies (vs. intentional flat wasm manifest) | M | Med |
| WAL-07 | Info | Modularity | `applyLayoutProposal.ts` | Good inverse-dependency example to preserve | — | — |

### Rust `data-core`

| ID | Sev | Cat | Location | Finding | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| CORE-01 | High | Modularity | `ros1_bag.rs` vs `ros2_db3.rs` | Two ROS readers are near-clones differing only by wire format | M | Low |
| CORE-02 | High | Cohesion | `mcap.rs` (1846) | God-file: summary parsing + ROS2 CDR + NAL video scanning | L | Low |
| CORE-03 | Med | Pattern | `data-cli/lib.rs:41-48`, `wasm-bindings/lib.rs:64-76` | Format→reader dispatch duplicated and **divergent** (CLI silently omits formats) | M | Low |
| CORE-04 | Med | SoC | `mf4.rs:471` + ~7 readers | `partition_point` range-slice + `infer_period_ns` hand-rolled in ~8 readers (correctness-drift hazard) | S–M | Low |
| CORE-05 | Low | Pattern | `mcap.rs:1362-1390` | Local `build_*_ipc` wrappers shadow shared `arrow::*` names | S | Low |
| CORE-06 | Low | Pattern | `reader.rs:26-49` | Single-blob `open(&[u8])` is a leaky abstraction 2+ readers can't honor | S | Low |
| CORE-07 | Low | Modularity | `mcap.rs:53` | MCAP borrows its byte-range source type from the **MF4** module | S | Low |

### Shell / Layout / wasm-bindings

| ID | Sev | Cat | Location | Finding | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| SHELL-01 | High | Cohesion | `App.tsx:65-915` | ~83% of `App.tsx` is the inlined dev-hook surface; extract `devHooks.ts` | M | Low |
| SHELL-02 | Med | Pattern | 6 dialogs/overlays | No shared modal primitive; scrim/`aria-modal`/Escape/focus copy-pasted (Escape in 11 files), no real focus-trap | M | Low–Med |
| SHELL-03 | Med | Cohesion | `UnknownFormatDialog.tsx` (1359) | 4 weakly-related sub-flows in one module | L | Low |
| SHELL-04 | Low | Modularity | `App.tsx:995`→`Shell`→`Drawer`→`ChannelsDrawer` | `ensurePlotPanel` prop-drilled 3 layers while every other caller uses `workspaceBridge` | S | Low |
| SHELL-05 | Low | SoC | `App.tsx:1000` | Worker-crash banner vs render-crash boundary responsibilities slightly blurred | S | None |
| SHELL-06 | Low | Pattern | `App.tsx` dev hooks vs `agentApi.ts` | Two automation surfaces repeat BigInt-serialising read glue (intentional DEV-gating boundary) | M | Med |

## Decision: what gets implemented now

Selection criteria for this pass: **high value, low risk, behavior-preserving,
already test-backed, disjoint file sets, and no exposure to the cursor/video hot
path or the Arrow IPC byte contract.** These were implemented in Workflow 2:

| # | Findings | Change |
| --- | --- | --- |
| 1 | PANEL-01, PANEL-02 | New `panels/shared/arrowList.ts` (generic `listRow<T>` + `lastRowTsNs`); 4–5 decoders de-duplicated |
| 2 | STATE-04, STATE-08 | Collapse the 9 `*Channels` builders + 4 `*FrameTimes` actions to parameterized helpers |
| 3 | WAL-05 | Split `sanitizeProposal` into `llm/layoutSanitize.ts` |
| 4 | CORE-04 | Extract `data-core/src/time.rs` (`range_window`, `infer_period_ns`); route readers through it |
| 5 | SHELL-04 | Drop the `ensurePlotPanel` prop-drill; `ChannelsDrawer` uses `workspaceBridge` |

## Deferred (worth doing, larger/higher-risk — recommended follow-ups)

These are real and valuable but exceed the risk/size envelope for a single
behavior-preserving pass; each deserves its own focused change with dedicated
verification:

- **STATE-01 / STATE-02 / STATE-03** — carve `store.ts` into `types.ts`,
  `state/ingest/` (with a `SOURCE_OPENERS` table), and a bookmarks slice. The
  single highest-leverage structural win, but touches the ingestion FSM.
- **CORE-01 / CORE-02** — unify the ROS1/ROS2 readers and split `mcap.rs`. Pairs
  naturally (the ROS2 split feeds the shared helper).
- **CORE-03** — a central `SourceKind`→reader registry in `data-core` so CLI and
  wasm capability can't silently diverge.
- **SHELL-01** — extract the dev-hook surface from `App.tsx` into `devHooks.ts`
  (pure move, but touches the Playwright contract surface).
- **SHELL-02** — a shared `Dialog`/`useEscape` primitive with a real focus-trap.
- **WAL-01 / WAL-02** — extract `videoCadence.ts` and the agent `snapshotAt`
  session-snapshot helper.
- **PANEL-03 / PANEL-04** — lift the LiDAR overlay out of `VideoPanel` and the
  `buildPlotOptions()` factory out of `PlotPanel` (both touch the hot path).
</content>
