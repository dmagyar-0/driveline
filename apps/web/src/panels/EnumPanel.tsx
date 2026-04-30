// Phase 6 · EnumPanel — single-channel state strip.
//
// The integration plan suggests uPlot step mode; in practice a single
// horizontal strip with coloured segments and a cursor line is simpler
// to render directly on a `<canvas>` than to talk uPlot into a step
// scale, and the frontend-skill rule allows "extend uPlot or stay
// native." This stays native.
//
// Each integer value in the bound scalar channel is treated as an enum
// state. Segments are coloured deterministically via `colorFor()` keyed
// on `String(value)` so two strips reading the same channel agree on
// colour. The cursor line tracks `cursorNs` exactly like PlotPanel's
// overlay — uses `cursorXPx()` from `cursorOverlay.ts` for the same
// math. One worker fetch per `globalRange` change.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { Channel, SourceMeta } from "../state/store";
import { seriesFromArrow, type PlotSeries } from "./seriesFromArrow";
import { cursorStrokeColor, cursorXPx } from "./cursorOverlay";
import { colorFor } from "./palette";
import styles from "./EnumPanel.module.css";

interface EnumPanelProps {
  panelId: string;
}

function findChannel(
  sources: SourceMeta[],
  channelId: string,
): Channel | null {
  for (const s of sources) {
    const hit = s.channels.find((c) => c.id === channelId);
    if (hit) return hit;
  }
  return null;
}

interface Segment {
  startNs: bigint;
  endNs: bigint;
  value: number;
  color: string;
}

// Walk the decoded series, coalescing consecutive samples with the same
// value into a single segment so a 10 k-sample binary channel becomes a
// handful of fills rather than 10 k of them.
function segmentsFor(series: PlotSeries, rangeEndNs: bigint): Segment[] {
  const out: Segment[] = [];
  if (series.ys.length === 0) return out;
  let curValue = series.ys[0];
  let curStart = series.rawTsNs[0];
  for (let i = 1; i < series.ys.length; i++) {
    const v = series.ys[i];
    if (v !== curValue) {
      out.push({
        startNs: curStart,
        endNs: series.rawTsNs[i],
        value: curValue,
        color: colorFor(String(curValue)),
      });
      curValue = v;
      curStart = series.rawTsNs[i];
    }
  }
  out.push({
    startNs: curStart,
    endNs: rangeEndNs,
    value: curValue,
    color: colorFor(String(curValue)),
  });
  return out;
}

export function EnumPanel({ panelId }: EnumPanelProps) {
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  const cursorNs = useSession((s) => s.cursorNs);
  const bindingId = useSession((s) => s.enumBindings[panelId] ?? null);
  const setEnumBinding = useSession((s) => s.setEnumBinding);

  const channel = useMemo(
    () => (bindingId === null ? null : findChannel(sources, bindingId)),
    [bindingId, sources],
  );

  // Drop the binding when the bound channel no longer exists. Gate on
  // `sources.length > 0` so a fresh hydrate (channels list empty)
  // doesn't wipe a persisted binding before the user has dropped a
  // file.
  useEffect(() => {
    if (sources.length === 0) return;
    if (bindingId !== null && channel === null) {
      setEnumBinding(panelId, null);
    }
  }, [bindingId, channel, panelId, setEnumBinding, sources.length]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const segmentsRef = useRef<Segment[]>([]);
  const [renderTick, setRenderTick] = useState(0);

  // Keep canvases sized to their parent.
  useEffect(() => {
    const el = containerRef.current;
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

  // Fetch + decode + segment on binding / range change.
  useEffect(() => {
    if (!channel || !globalRange) {
      segmentsRef.current = [];
      setRenderTick((n) => n + 1);
      return;
    }
    let aborted = false;
    void (async () => {
      try {
        const bytes = await useSession
          .getState()
          .fetchChannelRange(
            channel.id,
            globalRange.startNs,
            globalRange.endNs,
            false,
          );
        if (aborted) return;
        const series = seriesFromArrow(bytes);
        segmentsRef.current = segmentsFor(series, globalRange.endNs);
        setRenderTick((n) => n + 1);
      } catch (err) {
        if (!aborted) console.error("EnumPanel fetch failed", err);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [channel, globalRange]);

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
    if (segments.length === 0 || !globalRange) return;
    const span = Number(globalRange.endNs - globalRange.startNs);
    if (span <= 0) return;
    for (const seg of segments) {
      const x0 =
        (Number(seg.startNs - globalRange.startNs) / span) * w;
      const x1 =
        (Number(seg.endNs - globalRange.startNs) / span) * w;
      ctx.fillStyle = seg.color;
      ctx.fillRect(Math.floor(x0), 0, Math.max(1, Math.ceil(x1 - x0)), h);
    }
  }, [renderTick, globalRange]);

  // Cursor line redraw on every cursor tick.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !globalRange) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = overlay.width / dpr;
    const h = overlay.height / dpr;
    ctx.clearRect(0, 0, w, h);
    const x = cursorXPx(cursorNs, globalRange, w);
    if (x === null) return;
    ctx.strokeStyle = cursorStrokeColor();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }, [cursorNs, globalRange, renderTick]);

  // Current state at cursor for the legend pill.
  const currentValue = useMemo(() => {
    const segments = segmentsRef.current;
    if (segments.length === 0) return null;
    for (const seg of segments) {
      if (cursorNs >= seg.startNs && cursorNs <= seg.endNs) return seg;
    }
    return null;
    // renderTick threads the segment update through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorNs, renderTick]);

  const isEmpty = bindingId === null || channel === null;

  return (
    <section className={styles.panel} data-testid="enum-panel">
      {isEmpty ? (
        <div className={styles.empty} data-testid="enum-empty">
          <p className={styles.emptyTitle}>Enum</p>
          <p className={styles.emptyBody}>
            Bind a scalar channel from the Panel drawer.
          </p>
        </div>
      ) : (
        <>
          <header className={styles.header}>
            <span
              className={styles.channelName}
              data-testid="enum-channel-name"
            >
              {channel.name}
            </span>
            {currentValue !== null && (
              <span
                className={styles.currentPill}
                data-testid="enum-current"
              >
                <span
                  className={styles.swatch}
                  style={{ background: currentValue.color }}
                  aria-hidden="true"
                />
                <span className={styles.currentLabel}>
                  state {currentValue.value}
                </span>
              </span>
            )}
          </header>
          <div ref={containerRef} className={styles.stripContainer}>
            <canvas ref={stripRef} className={styles.strip} />
            <canvas ref={overlayRef} className={styles.overlay} />
          </div>
        </>
      )}
    </section>
  );
}
