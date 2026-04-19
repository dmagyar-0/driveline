// T4.1 · PlotPanel — single series.
//
// uPlot-backed scalar trace for one channel bound via a native picker. Data
// fetch goes through `useSession.fetchChannelRange`, which dispatches to the
// right reader based on the owning source's kind. Cursor overlay lives on a
// separate canvas so cursor ticks never rebuild the plot.
//
// Out of scope (later tasks): pan/zoom, multi-series, channel-picker tree,
// decimation, FlexLayout. See docs/06-ui-and-panels.md and
// docs/10-task-breakdown.md T4.2/T4.3.

import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useSession } from "../state/store";
import type { Channel, TimeRange } from "../state/store";
import { seriesFromArrow } from "./seriesFromArrow";
import { cursorXPx } from "./cursorOverlay";
import styles from "./PlotPanel.module.css";

const EMPTY_X = new Float64Array();
const EMPTY_Y = new Float64Array();

function pickScalarChannels(channels: Channel[]): Channel[] {
  return channels.filter((c) => c.kind === "scalar");
}

function labelFor(c: Channel): string {
  return c.unit ? `${c.name} (${c.unit})` : c.name;
}

export function PlotPanel() {
  const channels = useSession((s) => s.channels);
  const globalRange = useSession((s) => s.globalRange);
  const cursorNs = useSession((s) => s.cursorNs);

  const [boundChannelId, setBoundChannelId] = useState<string>("");

  const scalarChannels = useMemo(
    () => pickScalarChannels(channels),
    [channels],
  );
  const boundChannel = scalarChannels.find((c) => c.id === boundChannelId);

  // Drop a stale binding if the user cleared the session (or the channel
  // otherwise vanished). Mirrors the pattern used for cursor reseating in
  // the store's `openFiles`.
  useEffect(() => {
    if (boundChannelId && !scalarChannels.some((c) => c.id === boundChannelId)) {
      setBoundChannelId("");
    }
  }, [boundChannelId, scalarChannels]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotMountRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Range used for the most recent `setData`; the cursor overlay uses this
  // so a stale cursor tick doesn't project onto a range we haven't rendered.
  const lastRangeRef = useRef<TimeRange | null>(null);

  // Construct uPlot once; resize with the container.
  useEffect(() => {
    const mount = plotMountRef.current;
    const container = containerRef.current;
    if (!mount || !container) return;

    const rect = container.getBoundingClientRect();
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      scales: { x: { time: true } },
      series: [
        {},
        {
          label: "value",
          stroke: "#3b82f6",
          width: 1,
        },
      ],
      axes: [{}, {}],
      cursor: { show: false },
      legend: { show: false },
    };
    plotRef.current = new uPlot(
      opts,
      [EMPTY_X, EMPTY_Y] as uPlot.AlignedData,
      mount,
    );

    const sizeOverlayToContainer = () => {
      const overlay = overlayRef.current;
      const c = containerRef.current;
      if (!overlay || !c) return;
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      overlay.width = Math.max(1, Math.round(r.width * dpr));
      overlay.height = Math.max(1, Math.round(r.height * dpr));
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
    };
    sizeOverlayToContainer();

    const ro = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      plotRef.current?.setSize({
        width: Math.max(1, Math.round(r.width)),
        height: Math.max(1, Math.round(r.height)),
      });
      sizeOverlayToContainer();
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, []);

  // Fetch & render on bind or range change.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    if (!boundChannel || !globalRange) {
      plot.setData([EMPTY_X, EMPTY_Y] as uPlot.AlignedData);
      lastRangeRef.current = null;
      return;
    }

    // Update the series label so the legend/y-axis read naturally when we
    // add it in T4.2. `setSeries` doesn't rename; mutate in place is the
    // documented escape hatch for label-only tweaks.
    plot.series[1].label = labelFor(boundChannel);

    let aborted = false;
    void (async () => {
      try {
        const bytes = await useSession
          .getState()
          .fetchChannelRange(
            boundChannel.id,
            globalRange.startNs,
            globalRange.endNs,
            false,
          );
        if (aborted) return;
        const { xs, ys } = seriesFromArrow(bytes);
        plot.setData([xs, ys] as uPlot.AlignedData);
        lastRangeRef.current = globalRange;
      } catch (err) {
        if (!aborted) {
          console.error("PlotPanel fetch failed", err);
        }
      }
    })();

    return () => {
      aborted = true;
    };
  }, [boundChannel, globalRange]);

  // Cursor overlay redraw on every cursor tick.
  useEffect(() => {
    const overlay = overlayRef.current;
    const plot = plotRef.current;
    if (!overlay || !plot) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const range = lastRangeRef.current ?? globalRange;
    if (!range) return;
    const bbox = plot.bbox;
    // uPlot's `bbox` is in device pixels; convert back to CSS pixels for
    // drawing alongside the standard 2D context.
    const left = bbox.left / dpr;
    const top = bbox.top / dpr;
    const width = bbox.width / dpr;
    const height = bbox.height / dpr;

    const x = cursorXPx(cursorNs, range, width);
    if (x === null) return;

    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + x + 0.5, top);
    ctx.lineTo(left + x + 0.5, top + height);
    ctx.stroke();
  }, [cursorNs, globalRange]);

  const hasScalars = scalarChannels.length > 0;

  return (
    <section className={styles.panel} data-testid="plot-panel">
      <div className={styles.controls}>
        <label htmlFor="plot-channel-picker">channel</label>
        <select
          id="plot-channel-picker"
          data-testid="plot-channel-picker"
          value={boundChannelId}
          onChange={(e) => setBoundChannelId(e.target.value)}
          disabled={!hasScalars}
        >
          <option value="">
            {hasScalars ? "— pick a channel —" : "no scalar channels loaded"}
          </option>
          {scalarChannels.map((c) => (
            <option key={`${c.sourceId}::${c.id}`} value={c.id}>
              {labelFor(c)}
            </option>
          ))}
        </select>
      </div>
      <div ref={containerRef} className={styles.plotArea}>
        <div ref={plotMountRef} className={styles.plotMount} />
        <canvas ref={overlayRef} className={styles.overlay} />
        {!boundChannel && (
          <div className={styles.empty} data-testid="plot-empty">
            {hasScalars
              ? "Pick a channel to plot."
              : "Drop an MCAP or MF4 file to load scalar channels."}
          </div>
        )}
      </div>
    </section>
  );
}
