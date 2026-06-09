// EnumPanel — multi-signal state strips.
//
// Each bound scalar channel renders as its own fixed-height "lane": a
// labelled, rounded canvas strip of coloured enum-state segments with the
// shared cursor overlay layered on top, plus a current-state pill that
// reads the value at the cursor. Lanes stack from the top and the panel
// scrolls once they overflow — a single signal occupies one short lane
// rather than stretching to fill the whole panel.
//
// The integration plan suggested uPlot step mode; in practice a single
// horizontal strip with coloured segments and a cursor line is simpler to
// render directly on a `<canvas>` than to talk uPlot into a step scale,
// and the frontend-skill rule allows "extend uPlot or stay native." This
// stays native.
//
// Each integer value in a bound scalar channel is treated as an enum
// state. Segments are coloured deterministically via `colorFor()` keyed on
// `String(value)` so two strips reading the same channel agree on colour,
// and the value is drawn inside any segment wide enough to fit it. The
// cursor line tracks `cursorNs` exactly like PlotPanel's overlay — uses
// `cursorXPx()` from `cursorOverlay.ts` for the same math. One worker fetch
// per lane per `globalRange` change.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { Channel, SourceMeta, TimeRange } from "../state/store";
import { decodeSeries, type PlotSeries } from "./seriesFromArrow";
import { cursorStrokeColor, cursorXPx } from "./cursorOverlay";
import { colorFor, MAX_PLOT_SERIES } from "./palette";
import styles from "./EnumPanel.module.css";

interface EnumPanelProps {
  panelId: string;
}

const EMPTY: readonly string[] = Object.freeze([]);

// Concrete font for in-strip value labels. Canvas `ctx.font` can't resolve
// CSS custom properties, so the mono stack is inlined; it mirrors
// `--font-mono` from tokens.css. Tabular figures keep narrow/wide digits
// from shifting the centring.
const LABEL_FONT =
  '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
// Horizontal slack (CSS px) a segment needs beyond its label width before
// we paint the value inside it — avoids labels crowding segment edges.
const LABEL_PAD = 8;

function findChannel(sources: SourceMeta[], channelId: string): Channel | null {
  for (const s of sources) {
    const hit = s.channels.find((c) => c.id === channelId);
    if (hit) return hit;
  }
  return null;
}

// Pick black or white for a value label so it stays legible on its
// segment fill. Perceived (sRGB-weighted) luminance; light fills get dark
// ink, dark fills get light. Palette colours are always `#rrggbb`.
function readableTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#0b0b0b" : "#ffffff";
}

// Colour rendered for a "no data" gap (consecutive NaN/non-finite samples).
// A neutral dark fill, visually distinct from any palette state colour.
const GAP_COLOR = "#2a2a2e";

export interface Segment {
  startNs: bigint;
  endNs: bigint;
  // `null` marks a "no data" gap (NaN / non-finite samples coalesced).
  value: number | null;
  color: string;
}

// Two samples belong to the same segment when they are the same finite value,
// OR both are non-finite (NaN / ±Inf) — so a run of NaN coalesces into one
// gap rather than fragmenting into one segment per sample (NaN !== NaN).
function sameState(a: number, b: number): boolean {
  const aFin = Number.isFinite(a);
  const bFin = Number.isFinite(b);
  if (!aFin && !bFin) return true;
  if (aFin !== bFin) return false;
  return a === b;
}

function segmentFor(value: number, startNs: bigint, endNs: bigint): Segment {
  const isGap = !Number.isFinite(value);
  return {
    startNs,
    endNs,
    value: isGap ? null : value,
    color: isGap ? GAP_COLOR : colorFor(String(value)),
  };
}

// Walk the decoded series, coalescing consecutive samples with the same
// value into a single segment so a 10 k-sample binary channel becomes a
// handful of fills rather than 10 k of them. Runs of NaN/non-finite samples
// collapse into a single "no data" gap segment instead of thousands of
// `colorFor("NaN")` fills.
export function segmentsFor(series: PlotSeries, rangeEndNs: bigint): Segment[] {
  const out: Segment[] = [];
  if (series.ys.length === 0) return out;
  let curValue = series.ys[0];
  let curStart = series.rawTsNs[0];
  for (let i = 1; i < series.ys.length; i++) {
    const v = series.ys[i];
    if (!sameState(v, curValue)) {
      out.push(segmentFor(curValue, curStart, series.rawTsNs[i]));
      curValue = v;
      curStart = series.rawTsNs[i];
    }
  }
  out.push(segmentFor(curValue, curStart, rangeEndNs));
  return out;
}

interface EnumLaneProps {
  channel: Channel;
  range: TimeRange;
}

// One bound channel's state strip. Self-contained: fetches + decodes +
// segments its own channel, draws its strip and cursor, and shows the
// state at the cursor. The strip canvas is stable during a scrub — only
// the lightweight overlay redraws per cursor tick — so N lanes cost N
// trivial line draws, not N strip rebuilds.
function EnumLane({ channel, range }: EnumLaneProps) {
  const cursorNs = useSession((s) => s.cursorNs);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const segmentsRef = useRef<Segment[]>([]);
  const [renderTick, setRenderTick] = useState(0);
  // Lane-level status so a schema/dtype mismatch surfaces as a visible error
  // instead of a silently blank strip. `null` = healthy.
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Keep both canvases sized to the strip wrapper.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      for (const c of [stripRef.current, overlayRef.current]) {
        if (!c) continue;
        c.width = Math.max(1, Math.round(r.width * dpr));
        c.height = Math.max(1, Math.round(r.height * dpr));
        c.style.width = `${r.width}px`;
        c.style.height = `${r.height}px`;
      }
      setRenderTick((n) => n + 1);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fetch + decode + segment on channel / range change.
  useEffect(() => {
    let aborted = false;
    void (async () => {
      try {
        const bytes = await useSession
          .getState()
          .fetchChannelRange(channel.id, range.startNs, range.endNs, false);
        if (aborted) return;
        const decoded = decodeSeries(bytes);
        if (!decoded.ok) {
          // A genuine schema/dtype mismatch (e.g. a vector channel bound
          // here, or a corrupt batch): clear the strip and show the reason
          // rather than rendering blank or garbage.
          segmentsRef.current = [];
          setErrorMsg(decoded.message);
          setRenderTick((n) => n + 1);
          return;
        }
        segmentsRef.current = segmentsFor(decoded, range.endNs);
        setErrorMsg(null);
        setRenderTick((n) => n + 1);
      } catch (err) {
        if (!aborted) {
          console.error("EnumPanel fetch failed", err);
          segmentsRef.current = [];
          setErrorMsg(
            err instanceof Error ? err.message : "Failed to load channel.",
          );
          setRenderTick((n) => n + 1);
        }
      }
    })();
    return () => {
      aborted = true;
    };
  }, [channel.id, range]);

  // Redraw the strip whenever segments or canvas size change.
  useEffect(() => {
    void renderTick;
    const strip = stripRef.current;
    if (!strip) return;
    const ctx = strip.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = strip.width / dpr;
    const h = strip.height / dpr;
    ctx.clearRect(0, 0, w, h);
    const segments = segmentsRef.current;
    const span = Number(range.endNs - range.startNs);
    if (segments.length === 0 || span <= 0) return;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = LABEL_FONT;
    for (const seg of segments) {
      // Clamp to the visible range and order the edges so an out-of-order
      // timestamp can never produce a negative-width rect (which paints
      // backwards / not at all on some canvas impls).
      const rawX0 = (Number(seg.startNs - range.startNs) / span) * w;
      const rawX1 = (Number(seg.endNs - range.startNs) / span) * w;
      const lo = Math.max(0, Math.min(rawX0, rawX1));
      const hi = Math.min(w, Math.max(rawX0, rawX1));
      const segW = hi - lo;
      if (segW <= 0) continue;
      ctx.fillStyle = seg.color;
      ctx.fillRect(Math.floor(lo), 0, Math.max(1, Math.ceil(segW)), h);
      // A "no data" gap (seg.value === null) gets the neutral fill but no
      // label. Otherwise label the state inside the segment when there's
      // room — turns the colour blocks into a readable state track.
      if (seg.value === null) continue;
      const label = String(seg.value);
      if (segW >= ctx.measureText(label).width + LABEL_PAD) {
        ctx.fillStyle = readableTextColor(seg.color);
        ctx.fillText(label, (lo + hi) / 2, h / 2 + 0.5);
      }
    }
  }, [renderTick, range]);

  // Cursor line redraw on every cursor tick. Only this small overlay
  // repaints during a scrub; the strip above is untouched.
  useEffect(() => {
    const overlay = overlayRef.current;
    const ctx = overlay?.getContext("2d");
    if (!overlay || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = overlay.width / dpr;
    const h = overlay.height / dpr;
    ctx.clearRect(0, 0, w, h);
    const x = cursorXPx(cursorNs, range, w);
    if (x === null) return;
    ctx.strokeStyle = cursorStrokeColor();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }, [cursorNs, range, renderTick]);

  // State at the cursor for the legend pill. `renderTick` threads the
  // segment update (a ref) through to this memo.
  //
  // Binary-search for the segment whose startNs ≤ cursorNs (segments are
  // built in time order by segmentsFor). O(log n) instead of O(n) — a
  // channel with many state transitions could have hundreds of segments.
  const currentSeg = useMemo(() => {
    const segs = segmentsRef.current;
    if (segs.length === 0) return null;
    // Find the last segment with startNs ≤ cursorNs.
    let lo = 0;
    let hi = segs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (segs[mid].startNs <= cursorNs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found === -1) return null;
    const seg = segs[found];
    // Confirm cursorNs falls within the segment's closed interval.
    return cursorNs <= seg.endNs ? seg : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorNs, renderTick]);

  return (
    <div className={styles.lane} data-testid="enum-lane">
      <div className={styles.laneHeader}>
        <span
          className={styles.channelName}
          data-testid="enum-channel-name"
          title={channel.name}
        >
          {channel.name}
        </span>
        {currentSeg !== null && currentSeg.value !== null ? (
          <span className={styles.currentPill} data-testid="enum-current">
            <span
              className={styles.swatch}
              style={{ background: currentSeg.color }}
              aria-hidden="true"
            />
            <span className={styles.currentLabel}>
              state {currentSeg.value}
            </span>
          </span>
        ) : (
          <span className={styles.currentPillMuted} data-testid="enum-current">
            <span className={styles.currentLabel}>
              {currentSeg !== null ? "no data" : "—"}
            </span>
          </span>
        )}
      </div>
      <div ref={wrapRef} className={styles.stripWrap}>
        <canvas ref={stripRef} className={styles.strip} />
        <canvas ref={overlayRef} className={styles.overlay} />
        {errorMsg !== null && (
          <div
            className={styles.laneError}
            role="alert"
            data-testid="enum-error"
          >
            {errorMsg}
          </div>
        )}
      </div>
    </div>
  );
}

export function EnumPanel({ panelId }: EnumPanelProps) {
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  const storedBindings = useSession((s) => s.enumBindings[panelId]);
  const setEnumBinding = useSession((s) => s.setEnumBinding);

  const boundIds = useMemo(() => storedBindings ?? EMPTY, [storedBindings]);

  const boundChannels = useMemo(
    () =>
      boundIds
        .map((id) => findChannel(sources, id))
        .filter((c): c is Channel => c !== null),
    [boundIds, sources],
  );

  // Drop bindings that no longer map to a live scalar/enum channel. Gate on
  // `sources.length > 0` so a fresh hydrate (channels list empty) doesn't
  // wipe a persisted binding before the user has dropped a file.
  useEffect(() => {
    if (sources.length === 0) return;
    const filtered = boundIds.filter((id) => {
      const c = findChannel(sources, id);
      return c !== null && (c.kind === "scalar" || c.kind === "enum");
    });
    if (filtered.length !== boundIds.length) {
      setEnumBinding(panelId, filtered);
    }
  }, [boundIds, sources, panelId, setEnumBinding]);

  const isEmpty = boundChannels.length === 0 || globalRange === null;

  return (
    <section className={styles.panel} data-testid="enum-panel">
      {isEmpty ? (
        <div className={styles.empty} data-testid="enum-empty">
          <p className={styles.emptyTitle}>Enum</p>
          <p className={styles.emptyBody}>
            Bind scalar or enum channels from the Panel drawer (up to{" "}
            {MAX_PLOT_SERIES}). Each becomes its own state strip.
          </p>
        </div>
      ) : (
        <div className={styles.lanes} data-testid="enum-lanes">
          {boundChannels.map((c) => (
            <EnumLane key={c.id} channel={c} range={globalRange} />
          ))}
        </div>
      )}
    </section>
  );
}
