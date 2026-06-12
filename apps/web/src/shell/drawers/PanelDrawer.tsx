// Phase 5 · Panel drawer. Phase 6 added bodies for the four new panel
// kinds (scene / map / table / enum); each binds via the existing
// `<ChannelPicker>` (filtered to scalar channels) so we don't introduce
// a parallel picker per kind.
//
// Replaces the inline `panel` stub in `Drawer.tsx`. Body switches on the
// kind of the currently-selected panel:
//   - none   → "Select a panel to configure it" empty state
//   - plot   → bound channels (× to remove), `+ add channel…` popover
//              reusing the existing `<ChannelPicker>`
//   - video  → decoder label, HUD overlay toggle (round-trips through
//              `setVideoHudOn` / `toggleVideoHudOn` in the store, so the
//              in-panel button + `h` keypress + this drawer all share
//              one bit), and the bound channel with × to clear.
//   - scene  → single-channel binding filtered to vector (point-cloud)
//              channels; auto-detects compatible signals and offers only
//              those. No rendering yet (pending the data-core format).
//   - map    → lat/lon two-channel binding via two pickers
//   - table  → multi-channel scalar binding (raw time-series table)
//   - value  → multi-channel scalar binding (sample-at-cursor reader)
//   - enum   → multi-channel scalar binding (one state strip per channel)
//
// The drawer reads everything from the store via single-key selectors
// and from the rAF-published `__drivelineVideoHud` snapshot for the
// codec label (which is not in the store — only the worker decoder
// owns it).

import { useEffect, useRef, useState } from "react";
import {
  MAX_PLOT_Y_AXES,
  effectivePlotZoomX,
  isPlotTimeAxisSynced,
  useSession,
  type Channel,
  type ChannelKind,
  type PlotTransform,
  type SourceMeta,
} from "../../state/store";
import { channelLabel } from "../../state/units";
import { colorFor, MAX_PLOT_SERIES } from "../../panels/palette";
import {
  WHEEL_ZOOM_STEP,
  isPlotZoomed,
  scaleWindowX,
} from "../../panels/plotZoom";
import { ChannelPicker } from "../../panels/ChannelPicker";
import type { PlotSeriesStats, PlotSyncSnapshot } from "../../panels/PlotPanel";
import {
  kindLabel,
  panelKindOf,
  panelNameFor,
  type PanelKind,
} from "../../layout/panelId";
import {
  PANEL_KINDS,
  PanelKindIcon,
  panelKindBlurb,
  panelKindName,
} from "../../layout/PanelKindIcon";
import drawerStyles from "../Drawer.module.css";
import { DRAWER_REGION_ID } from "../Drawer";
import s from "./PanelDrawer.module.css";

const HEADING_ID = "drawer-panel-h";

export function PanelDrawer() {
  // `selectedPanelId` is typed `string | null`, but the store can be written
  // from untyped JS (the dev hooks run via page.evaluate). Anything
  // non-string reads as "nothing selected" here — the `=== null` branches
  // below are the only guards between a bad id and a render crash.
  const selectedPanelId = useSession((st) =>
    typeof st.selectedPanelId === "string" ? st.selectedPanelId : null,
  );
  const layoutJson = useSession((st) => st.layoutJson);

  const kind: PanelKind | null =
    selectedPanelId === null ? null : panelKindOf(selectedPanelId);
  const panelName =
    selectedPanelId === null
      ? null
      : (panelNameFor(layoutJson, selectedPanelId) ?? selectedPanelId);

  return (
    <aside
      id={DRAWER_REGION_ID}
      className={drawerStyles.drawer}
      role="region"
      aria-labelledby={HEADING_ID}
      data-testid="drawer-panel"
    >
      <div className={drawerStyles.heading}>
        <h3 id={HEADING_ID}>Panel</h3>
      </div>

      {selectedPanelId === null ? (
        <Empty />
      ) : kind === null ? (
        <>
          <p className={s.subtitle} data-testid="drawer-panel-name">
            {panelName}
          </p>
          <UnknownKind />
        </>
      ) : (
        <>
          <KindCard kind={kind} panelName={panelName} />
          <PanelBody kind={kind} panelId={selectedPanelId} />
        </>
      )}
    </aside>
  );
}

/**
 * Identity card for the selected panel: kind glyph, the panel's own
 * name, the kind badge, and a one-line "what this panel shows" blurb.
 * Gives each settings page a visual anchor so the kind is readable at
 * a glance instead of from a lone text pill.
 */
function KindCard({
  kind,
  panelName,
}: {
  kind: PanelKind;
  panelName: string | null;
}) {
  return (
    <header className={s.kindCard} data-testid="drawer-panel-card">
      <span className={s.kindIcon}>
        <PanelKindIcon kind={kind} size={22} />
      </span>
      <div className={s.kindHead}>
        <div className={s.kindTitleRow}>
          <span
            className={s.kindName}
            data-testid="drawer-panel-name"
            title={panelName ?? undefined}
          >
            {panelName}
          </span>
          <span className={s.kindPill} data-testid="drawer-panel-kind">
            {kindLabel(kind)}
          </span>
        </div>
        <p className={s.kindBlurb}>{panelKindBlurb(kind)}</p>
      </div>
    </header>
  );
}

function PanelBody({
  kind,
  panelId,
}: {
  kind: PanelKind | null;
  panelId: string;
}) {
  switch (kind) {
    case "plot":
      return <PlotBody panelId={panelId} />;
    case "video":
      return <VideoBody panelId={panelId} />;
    case "scene":
      return <SceneBody panelId={panelId} />;
    case "map":
      // Keyed by panelId so the half-pick local state in MapBody resets
      // when a different map panel is selected (same-kind switches reuse
      // the instance otherwise, leaking a pending lat/lon across panels).
      return <MapBody key={panelId} panelId={panelId} />;
    case "table":
      return <TableBody panelId={panelId} />;
    case "value":
      return <ValueBody panelId={panelId} />;
    case "enum":
      return <EnumBody panelId={panelId} />;
    case null:
      return <UnknownKind />;
  }
}

function Empty() {
  return (
    <>
      <p className={s.empty} data-testid="panel-drawer-empty">
        Select a panel to configure it. Click any panel in the workspace or use
        the Channels drawer.
      </p>
      {/* Kind legend: doubles as the "what do these panel types mean"
          reference while nothing is selected. */}
      <section className={s.section} aria-label="Panel types">
        <div className={s.sectionHeader}>
          <h4 className={s.sectionTitle}>Panel types</h4>
        </div>
        <ul className={s.legend}>
          {PANEL_KINDS.map((k) => (
            <li key={k} className={s.legendRow}>
              <span className={s.legendIcon}>
                <PanelKindIcon kind={k} size={17} />
              </span>
              <span className={s.legendText}>
                <span className={s.legendName}>{panelKindName(k)}</span>
                <span className={s.legendBlurb}>{panelKindBlurb(k)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function UnknownKind() {
  return (
    <p className={s.empty} data-testid="panel-drawer-unknown">
      Unknown panel kind. The id prefix doesn't match any registered panel.
    </p>
  );
}

interface BodyProps {
  panelId: string;
}

function PlotBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const ids = useSession((st) => st.plotBindings[panelId] ?? EMPTY);
  const unitOverrides = useSession((st) => st.unitOverrides);

  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  const atCap = ids.length >= MAX_PLOT_SERIES;
  const bound = ids
    .map((id) => channels.find((c) => c.id === id))
    .filter((c): c is Channel => c !== undefined);

  const onToggle = (channelId: string) => {
    const cur = useSession.getState().plotBindings[panelId] ?? [];
    if (cur.includes(channelId)) {
      useSession.getState().removePlotChannel(panelId, channelId);
    } else {
      useSession.getState().addPlotChannel(panelId, channelId);
    }
  };

  const onRemove = (channelId: string) =>
    useSession.getState().removePlotChannel(panelId, channelId);

  const openPicker = () => {
    if (!addBtnRef.current) return;
    setPickerAnchor(addBtnRef.current.getBoundingClientRect());
  };

  return (
    <>
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <h4 className={s.sectionTitle}>Channels in panel</h4>
          <span className={s.countPill} data-testid="panel-plot-count">
            {ids.length} / {MAX_PLOT_SERIES}
          </span>
        </div>
        {bound.length === 0 ? (
          <p className={s.empty}>No channels bound. Add one below.</p>
        ) : (
          <ul className={s.list} data-testid="panel-plot-list">
            {bound.map((c) => (
              <li key={c.id} className={s.plotRowItem}>
                <div className={s.rowItem}>
                  <span className={s.row}>
                    <span
                      className={s.swatch}
                      style={{ background: colorFor(c.id) }}
                      aria-hidden="true"
                    />
                    <span className={s.name} title={c.name}>
                      {channelLabel(c, unitOverrides)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={s.removeBtn}
                    onClick={() => onRemove(c.id)}
                    aria-label={`Remove ${c.name}`}
                    data-testid={`panel-plot-remove-${c.id}`}
                  >
                    ×
                  </button>
                </div>
                <div className={s.channelFields}>
                  <PlotChannelAxisPicker panelId={panelId} channelId={c.id} />
                  <PlotChannelUnitInput channel={c} />
                  <PlotTransformPicker panelId={panelId} channelId={c.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <button
          ref={addBtnRef}
          type="button"
          className={s.addRow}
          aria-disabled={atCap || undefined}
          title={atCap ? `Plot full (${MAX_PLOT_SERIES})` : undefined}
          onClick={() => {
            if (atCap) return;
            openPicker();
          }}
          data-testid="panel-plot-add-channel"
        >
          + add channel…
        </button>
        {pickerAnchor !== null && (
          <ChannelPicker
            sources={sources}
            selectedIds={ids}
            maxSelected={MAX_PLOT_SERIES}
            anchorRect={pickerAnchor}
            onToggle={onToggle}
            onClose={() => setPickerAnchor(null)}
          />
        )}
      </section>
      <PlotSeriesStatsSection panelId={panelId} bound={bound} />
      <PlotZoomControl panelId={panelId} />
      <PlotStackAxesControl panelId={panelId} />
      <PlotGapThresholdControl panelId={panelId} />
    </>
  );
}

/**
 * Wheel-zoom controls, mirrored into the drawer so the same scaling is
 * reachable here as on the plot itself. "Reset zoom" clears every x/y
 * override (the drawer twin of the plot's top-right button) and disables
 * when nothing is zoomed; the ± buttons zoom the time axis in/out around
 * its centre (the most common scale, and the one whose base — `globalRange`
 * — is known here without the live uPlot). Per-axis y-zoom stays a
 * scroll-over-the-axis gesture, where the pointer picks the axis.
 */
function PlotZoomControl({ panelId }: BodyProps) {
  const zoom = useSession((st) => st.plotZoom[panelId]);
  const globalRange = useSession((st) => st.globalRange);
  // The visible time window (shared-or-own) drives both the ± base and the
  // "is anything zoomed?" check, so the controls reflect the synced window
  // even when this panel's own `plotZoom` entry is empty.
  const effX = useSession((st) => effectivePlotZoomX(st, panelId));
  const syncTimeAxis = useSession((st) => isPlotTimeAxisSynced(st, panelId));
  const zoomed = effX !== null || isPlotZoomed(zoom);

  const zoomTime = (factor: number) => {
    const st = useSession.getState();
    const bound = st.globalRange;
    if (!bound) return;
    // Zoom from whatever this panel shows, route back the same way as the
    // wheel — `applyPlotZoomX` moves the shared window when synced.
    const base = effectivePlotZoomX(st, panelId) ?? bound;
    st.applyPlotZoomX(panelId, scaleWindowX(base, 0.5, factor, bound));
  };

  return (
    <section className={s.section} data-testid="panel-plot-zoom-section">
      <div className={s.sectionHeader}>
        <h4 className={s.sectionTitle}>Zoom</h4>
      </div>
      <div className={s.zoomRow}>
        <span className={s.zoomRowLabel}>Time axis</span>
        <div className={s.zoomButtons}>
          <button
            type="button"
            className={s.zoomBtn}
            onClick={() => zoomTime(WHEEL_ZOOM_STEP)}
            disabled={!globalRange}
            aria-label="Zoom out on the time axis"
            data-testid="panel-plot-zoom-out"
          >
            −
          </button>
          <button
            type="button"
            className={s.zoomBtn}
            onClick={() => zoomTime(1 / WHEEL_ZOOM_STEP)}
            disabled={!globalRange}
            aria-label="Zoom in on the time axis"
            data-testid="panel-plot-zoom-in"
          >
            +
          </button>
        </div>
      </div>
      <button
        type="button"
        className={s.zoomReset}
        onClick={() => useSession.getState().clearPlotZoom(panelId)}
        disabled={!zoomed}
        data-testid="panel-plot-zoom-reset"
      >
        Reset zoom
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={syncTimeAxis}
        className={`${s.toggle} ${syncTimeAxis ? s.toggleOn : ""}`}
        onClick={() =>
          useSession.getState().setPlotSyncTimeAxis(panelId, !syncTimeAxis)
        }
        data-testid="panel-plot-sync-toggle"
      >
        <span>Sync time axis across plots</span>
        <span className={s.toggleState}>{syncTimeAxis ? "on" : "off"}</span>
      </button>
      <p className={s.gapHelp}>
        {syncTimeAxis
          ? "On: zooming the time axis here moves every synced plot to the same window. Y-axes stay independent."
          : "Off: this plot's time axis zooms on its own. Turn on to lock its timeline to the other synced plots."}
      </p>
    </section>
  );
}

/**
 * Stacked-axes toggle. Mirrors the in-panel "Stack" button (both flip the
 * one `stackAxes` bit via `setPlotStackAxes`), surfaced here next to the
 * other plot display settings. Only takes visible effect once two or more
 * y-axes carry data — the help text says so rather than hiding the control,
 * matching the always-shown gap-threshold toggle below.
 */
function PlotStackAxesControl({ panelId }: BodyProps) {
  const stackAxes = useSession(
    (st) => st.plotPanelSettings[panelId]?.stackAxes ?? false,
  );
  return (
    <section className={s.section} data-testid="panel-plot-stack-section">
      <div className={s.sectionHeader}>
        <h4 className={s.sectionTitle}>Stack axes</h4>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={stackAxes}
        className={`${s.toggle} ${stackAxes ? s.toggleOn : ""}`}
        onClick={() =>
          useSession.getState().setPlotStackAxes(panelId, !stackAxes)
        }
        data-testid="panel-plot-stack-toggle"
      >
        <span>Separate axes into bands</span>
        <span className={s.toggleState}>{stackAxes ? "on" : "off"}</span>
      </button>
      <p className={s.gapHelp}>
        {stackAxes
          ? "Each y-axis gets its own vertical band (lowest axis on top). Takes effect with 2+ axes in use."
          : "Off: all axes overlay across the full plot height."}
      </p>
    </section>
  );
}

/**
 * Per-series y-axis assignment. A small `<select>` (Axis 1…N) that maps
 * the channel to a 0-based y-axis via `setPlotChannelAxis`. Units no longer
 * drive grouping; this is the explicit control. Default is Axis 1 (the
 * shared left scale).
 */
function PlotChannelAxisPicker({
  panelId,
  channelId,
}: {
  panelId: string;
  channelId: string;
}) {
  const axis = useSession(
    (st) => st.plotPanelSettings[panelId]?.axisAssignments?.[channelId] ?? 0,
  );
  const onChange = (next: number) =>
    useSession.getState().setPlotChannelAxis(panelId, channelId, next);

  return (
    <label className={s.field}>
      <span className={s.fieldLabel}>Y-axis</span>
      <select
        className={s.fieldControl}
        value={axis}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
        data-testid={`panel-plot-axis-${channelId}`}
      >
        {Array.from({ length: MAX_PLOT_Y_AXES }, (_, i) => (
          <option key={i} value={i}>
            Axis {i + 1}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Per-series unit override. The unit is inferred from the file but often
 * missing or wrong, so this text input lets the user correct it. The
 * override is GLOBAL per channel (see `setChannelUnit`), so it also updates
 * the table / value panels. The placeholder shows the inferred unit; an
 * empty input means "no unit". A reset button clears the override.
 */
function PlotChannelUnitInput({ channel }: { channel: Channel }) {
  const override = useSession((st) => st.unitOverrides[channel.id]);
  const hasOverride = override !== undefined;
  // Local draft so a partially-typed value doesn't churn the store on every
  // keystroke; commit on blur / Enter. Re-seed when the store value changes
  // out from under us (e.g. a reset or a restored layout).
  const [draft, setDraft] = useState(override ?? channel.unit ?? "");
  const lastSeenRef = useRef<string | undefined>(override);
  useEffect(() => {
    if (lastSeenRef.current !== override) {
      lastSeenRef.current = override;
      setDraft(override ?? channel.unit ?? "");
    }
  }, [override, channel.unit]);

  const commit = () => useSession.getState().setChannelUnit(channel.id, draft);
  const reset = () => {
    useSession.getState().setChannelUnit(channel.id, null);
    setDraft(channel.unit ?? "");
  };

  return (
    <div className={s.field}>
      <label className={s.fieldStack}>
        <span className={s.fieldLabel}>Unit</span>
        <input
          type="text"
          className={`${s.fieldControl} ${hasOverride ? s.fieldControlWithReset : ""}`}
          value={draft}
          placeholder={channel.unit ?? "none"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          data-testid={`panel-plot-unit-${channel.id}`}
        />
      </label>
      {hasOverride && (
        <button
          type="button"
          className={s.unitResetBtn}
          onClick={reset}
          aria-label={`Reset unit for ${channel.name}`}
          title="Reset to file-inferred unit"
          data-testid={`panel-plot-unit-reset-${channel.id}`}
        >
          ↺
        </button>
      )}
    </div>
  );
}

/**
 * P7 · per-series transform picker. A small `<select>` (none / abs /
 * derivative / scale) with an inline mul+add pair when "scale" is chosen.
 * Round-trips through `setPlotChannelTransform`; "none" clears the entry.
 */
function PlotTransformPicker({
  panelId,
  channelId,
}: {
  panelId: string;
  channelId: string;
}) {
  const transform = useSession(
    (st) => st.plotPanelSettings[panelId]?.transforms?.[channelId],
  );
  const kind = transform?.kind ?? "none";
  const mul = transform?.kind === "scale" ? transform.mul : 1;
  const add = transform?.kind === "scale" ? transform.add : 0;

  const setTransform = (t: PlotTransform) =>
    useSession.getState().setPlotChannelTransform(panelId, channelId, t);

  const onKindChange = (next: string) => {
    switch (next) {
      case "abs":
        setTransform({ kind: "abs" });
        break;
      case "derivative":
        setTransform({ kind: "derivative" });
        break;
      case "scale":
        // Seed with an identity affine so the plot doesn't jump until the
        // user edits mul/add.
        setTransform({ kind: "scale", mul, add });
        break;
      default:
        setTransform({ kind: "none" });
    }
  };

  return (
    <div className={s.fieldWide}>
      <label className={s.fieldStack}>
        <span className={s.fieldLabel}>Transform</span>
        <select
          className={s.fieldControl}
          value={kind}
          onChange={(e) => onKindChange(e.target.value)}
          data-testid={`panel-plot-transform-${channelId}`}
        >
          <option value="none">None</option>
          <option value="abs">Absolute |x|</option>
          <option value="derivative">Derivative d/dt</option>
          <option value="scale">Scale (y·m + b)</option>
        </select>
      </label>
      {kind === "scale" && (
        <div
          className={s.transformScale}
          data-testid={`panel-plot-scale-${channelId}`}
        >
          <label className={s.transformScaleField}>
            <span>×</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              className={s.transformScaleInput}
              value={mul}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                setTransform({
                  kind: "scale",
                  mul: Number.isFinite(v) ? v : 0,
                  add,
                });
              }}
              data-testid={`panel-plot-scale-mul-${channelId}`}
            />
          </label>
          <label className={s.transformScaleField}>
            <span>+</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              className={s.transformScaleInput}
              value={add}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                setTransform({
                  kind: "scale",
                  mul,
                  add: Number.isFinite(v) ? v : 0,
                });
              }}
              data-testid={`panel-plot-scale-add-${channelId}`}
            />
          </label>
        </div>
      )}
    </div>
  );
}

// Compact value formatting for the stats block. Mirrors PlotPanel's
// `formatValue` so the drawer and the chips agree on how a number reads.
function formatStat(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return v.toExponential(3);
  return v.toFixed(3);
}

/**
 * P4 · per-series statistics block. Reads the rAF-published plot sync
 * snapshot (`window.__drivelinePlotPanels[panelId]`) — the same surface
 * the e2e specs assert on — and renders min / max / mean / current-at-
 * cursor for each bound channel. Polled at 250ms (the `useDecoderCodec`
 * cadence) plus re-read on cursor change so the "current" column tracks
 * the scrubber; kept off the hot path (no per-frame work here).
 */
function PlotSeriesStatsSection({
  panelId,
  bound,
}: {
  panelId: string;
  bound: Channel[];
}) {
  const cursorNs = useSession((st) => st.cursorNs);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const snap = usePlotSyncSnapshot(panelId, cursorNs);

  if (bound.length === 0) return null;

  const statsById = new Map<string, PlotSeriesStats>();
  for (const stat of snap?.seriesStats ?? [])
    statsById.set(stat.channelId, stat);
  const currentById = new Map<string, number>();
  for (const sample of snap?.sampleAtCursor ?? []) {
    if (sample) currentById.set(sample.channelId, sample.value);
  }

  return (
    <section className={s.section} data-testid="panel-plot-stats-section">
      <div className={s.sectionHeader}>
        <h4 className={s.sectionTitle}>Statistics</h4>
      </div>
      {/* One block per channel (name row + labelled 4-up grid) instead of
          a five-column table: the table overflowed the 220px drawer and
          clipped mean/cur behind a horizontal scrollbar. */}
      <ul className={s.statsList} data-testid="panel-plot-stats">
        {bound.map((c) => {
          const stat = statsById.get(c.id);
          const cur = currentById.get(c.id);
          const cells: ReadonlyArray<[string, string]> = [
            ["min", stat ? formatStat(stat.min) : "—"],
            ["max", stat ? formatStat(stat.max) : "—"],
            ["mean", stat ? formatStat(stat.mean) : "—"],
            ["cur", cur === undefined ? "—" : formatStat(cur)],
          ];
          return (
            <li
              key={c.id}
              className={s.statsItem}
              data-testid={`panel-plot-stats-${c.id}`}
            >
              <span className={s.statsChannel}>
                <span
                  className={s.statsSwatch}
                  style={{ background: colorFor(c.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={c.name}>
                  {channelLabel(c, unitOverrides)}
                </span>
              </span>
              <dl className={s.statsGrid}>
                {cells.map(([label, value]) => (
                  <div key={label} className={s.stat}>
                    <dt className={s.statLabel}>{label}</dt>
                    <dd className={s.statValue}>{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Poll the rAF-published plot sync snapshot. Re-reads on a 250ms interval
// (matches `useDecoderCodec`) and whenever the cursor changes (so the
// "current" column tracks the scrubber). The snapshot lives on `window`,
// not the store, so React can't subscribe to it directly. Returns a fresh
// reference only when the underlying object identity changes.
function usePlotSyncSnapshot(
  panelId: string,
  cursorNs: bigint,
): PlotSyncSnapshot | undefined {
  const [snap, setSnap] = useState(
    () => window.__drivelinePlotPanels?.[panelId],
  );
  useEffect(() => {
    const read = () => {
      const next = window.__drivelinePlotPanels?.[panelId];
      setSnap((prev) => (prev === next ? prev : next));
    };
    read();
    const id = window.setInterval(read, 250);
    return () => window.clearInterval(id);
    // `cursorNs` re-runs the effect so the "current" column refreshes on a
    // scrub without waiting for the next poll tick.
  }, [panelId, cursorNs]);
  return snap;
}

/**
 * "Gap threshold" control surface — a toggle plus a number input that
 * round-trips through `setPlotGapThreshold`. Lives in its own component
 * so the `useState` for the in-flight numeric input doesn't churn the
 * rest of `PlotBody` on every keystroke. Off (default) preserves the
 * spanGaps:true rendering shipped in PR #83; on flips the panel into
 * step-hold + explicit-gap mode.
 */
function PlotGapThresholdControl({ panelId }: BodyProps) {
  const gapThresholdSec = useSession(
    (st) => st.plotPanelSettings[panelId]?.gapThresholdSec ?? null,
  );
  const isOn = gapThresholdSec !== null;
  // Local draft so a partially-typed value (e.g. "0.") doesn't get
  // immediately normalised to null by the store. Synced from the store
  // value on every change, but only the blur/Enter commit calls the
  // store action.
  const [draft, setDraft] = useState<string>(
    gapThresholdSec === null ? "1" : String(gapThresholdSec),
  );
  // Track the value we last saw from the store so external changes
  // (e.g. restoring a named layout) re-seed the draft. We compare to
  // the numeric value, not the string, so a user typing "1.0" while
  // the store says 1 doesn't get clobbered.
  const lastSeenRef = useRef<number | null>(gapThresholdSec);
  useEffect(() => {
    if (lastSeenRef.current !== gapThresholdSec) {
      lastSeenRef.current = gapThresholdSec;
      setDraft(gapThresholdSec === null ? "1" : String(gapThresholdSec));
    }
  }, [gapThresholdSec]);

  const setStore = (sec: number | null) => {
    useSession.getState().setPlotGapThreshold(panelId, sec);
  };

  const commitDraft = () => {
    const parsed = Number.parseFloat(draft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      // Invalid input → revert the draft to the previous on-value
      // rather than turning the threshold off. The user's intent here
      // is "I typed something" not "turn this off."
      setDraft(gapThresholdSec === null ? "1" : String(gapThresholdSec));
      return;
    }
    setStore(parsed);
  };

  return (
    <section className={s.section} data-testid="panel-plot-gap-section">
      <div className={s.sectionHeader}>
        <h4 className={s.sectionTitle}>Gap threshold</h4>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        className={`${s.toggle} ${isOn ? s.toggleOn : ""}`}
        onClick={() => {
          if (isOn) {
            setStore(null);
          } else {
            const parsed = Number.parseFloat(draft);
            setStore(Number.isFinite(parsed) && parsed > 0 ? parsed : 1);
          }
        }}
        data-testid="panel-plot-gap-toggle"
      >
        <span>Show gaps for dropouts</span>
        <span className={s.toggleState}>{isOn ? "on" : "off"}</span>
      </button>
      {isOn && (
        <label className={s.gapInputRow} data-testid="panel-plot-gap-input-row">
          <span className={s.gapInputLabel}>Threshold</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.1"
            value={draft}
            className={s.gapInput}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            data-testid="panel-plot-gap-input"
          />
          <span className={s.gapInputUnit}>sec</span>
        </label>
      )}
      <p className={s.gapHelp}>
        {isOn
          ? "Inter-sample gaps longer than this render as breaks; shorter intervals stay step-held."
          : "Off: gaps render as horizontal step-holds (matches default behavior)."}
      </p>
    </section>
  );
}

function VideoBody({ panelId }: BodyProps) {
  const sources = useSession((st) => st.sources);
  const bindingId = useSession((st) => st.videoBindings[panelId] ?? null);
  const hudOn = useSession((st) => st.videoHudOn[panelId] ?? false);

  const codec = useDecoderCodec(bindingId);
  const boundChannel = bindingId ? findChannel(sources, bindingId) : null;

  return (
    <>
      <section className={s.section}>
        <h4 className={s.sectionTitle}>Decoder</h4>
        <p className={s.codec} data-testid="panel-video-decoder">
          {codec ?? "—"}
        </p>
      </section>

      <section className={s.section}>
        <h4 className={s.sectionTitle}>Toggles</h4>
        <button
          type="button"
          role="switch"
          aria-checked={hudOn}
          className={`${s.toggle} ${hudOn ? s.toggleOn : ""}`}
          onClick={() => useSession.getState().toggleVideoHudOn(panelId)}
          data-testid="panel-drawer-hud-toggle"
        >
          <span>HUD overlay</span>
          <span className={s.toggleState}>{hudOn ? "on" : "off"}</span>
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={false}
          aria-disabled
          className={`${s.toggle} ${s.toggleDisabled}`}
          title="Pending VideoPanel step-hold support"
          data-testid="panel-drawer-step-hold"
        >
          <span>Step-hold</span>
          <span className={s.toggleState}>pending</span>
        </button>
      </section>

      <section className={s.section}>
        <h4 className={s.sectionTitle}>Channels in panel</h4>
        {boundChannel === null ? (
          <p className={s.empty}>
            No channel bound. Use the Channels drawer to bind one.
          </p>
        ) : (
          <ul className={s.list} data-testid="panel-video-list">
            <li className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(boundChannel.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={boundChannel.name}>
                  {boundChannel.name}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={() =>
                  useSession.getState().setVideoBinding(panelId, null)
                }
                aria-label={`Remove ${boundChannel.name}`}
                data-testid={`panel-video-remove-${boundChannel.id}`}
              >
                ×
              </button>
            </li>
          </ul>
        )}
      </section>
    </>
  );
}

// Channel kinds a 3D scene can render. `point_cloud` is the dedicated
// per-frame LiDAR geometry kind the data core emits (a whole spin per
// sample); `vector` stays accepted as a fallback for 3D-vector channels.
// Scalars / enums / video can't describe a cloud, so they're excluded.
const SCENE_CHANNEL_KINDS: readonly ChannelKind[] = ["point_cloud", "vector"];

function SceneBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const bindingId = useSession((st) => st.sceneBindings[panelId] ?? null);
  const setSceneBinding = useSession((st) => st.setSceneBinding);

  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  // Auto-detect the bindable channels: only those whose kind the scene can
  // actually render. Drives both the picker contents and the empty/disabled
  // states below, so the user is never offered a channel that can't bind.
  const compatibleCount = channels.filter((c) =>
    SCENE_CHANNEL_KINDS.includes(c.kind),
  ).length;
  const hasCompatible = compatibleCount > 0;
  const boundChannel = bindingId ? findChannel(sources, bindingId) : null;

  const onToggle = (channelId: string) => {
    setSceneBinding(panelId, bindingId === channelId ? null : channelId);
    setPickerAnchor(null);
  };

  const openPicker = () => {
    if (!addBtnRef.current) return;
    setPickerAnchor(addBtnRef.current.getBoundingClientRect());
  };

  return (
    <>
      <section className={s.section}>
        <h4 className={s.sectionTitle}>Status</h4>
        <p className={s.empty} data-testid="panel-scene-status">
          Renders a 3D point cloud — bind a point-cloud channel to orbit the
          scene. Points are coloured by intensity and step with the cursor as
          you scrub or play.
        </p>
      </section>
      <section className={s.section}>
        <h4 className={s.sectionTitle}>Bound channel</h4>
        {boundChannel === null ? (
          <p className={s.empty}>No channel bound.</p>
        ) : (
          <ul className={s.list} data-testid="panel-scene-list">
            <li className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(boundChannel.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={boundChannel.name}>
                  {channelLabel(boundChannel, unitOverrides)}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={() => setSceneBinding(panelId, null)}
                aria-label={`Remove ${boundChannel.name}`}
                data-testid={`panel-scene-remove-${boundChannel.id}`}
              >
                ×
              </button>
            </li>
          </ul>
        )}
        <button
          ref={addBtnRef}
          type="button"
          className={s.addRow}
          aria-disabled={!hasCompatible || undefined}
          title={
            hasCompatible
              ? undefined
              : "No point-cloud-compatible channels loaded"
          }
          onClick={() => {
            if (!hasCompatible) return;
            openPicker();
          }}
          data-testid="panel-scene-add-channel"
        >
          + bind channel…
        </button>
        <p className={s.gapHelp} data-testid="panel-scene-detect">
          {hasCompatible
            ? `${compatibleCount} compatible channel${
                compatibleCount === 1 ? "" : "s"
              } detected — only point-cloud channels can bind here.`
            : "No point-cloud channels detected in the loaded sources yet."}
        </p>
        {pickerAnchor !== null && (
          <ChannelPicker
            sources={sources}
            selectedIds={bindingId ? [bindingId] : []}
            maxSelected={1}
            anchorRect={pickerAnchor}
            kinds={SCENE_CHANNEL_KINDS}
            onToggle={onToggle}
            onClose={() => setPickerAnchor(null)}
          />
        )}
      </section>
    </>
  );
}

function MapBody({ panelId }: BodyProps) {
  const sources = useSession((st) => st.sources);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const binding = useSession((st) => st.mapBindings[panelId] ?? null);
  const setMapBinding = useSession((st) => st.setMapBinding);

  // The store's MapBinding is all-or-nothing (both axes required), but the
  // two pickers are filled one at a time. Hold a freshly-picked axis here
  // until its partner is chosen, then commit the complete pair. Without
  // this, the first pick was written straight back as `null` (a half pair
  // can't be persisted), so the map could never be bound from the drawer.
  // The instance is keyed by panelId (see PanelBody) so these reset when a
  // different map panel is selected.
  const [pendingLat, setPendingLat] = useState<string | null>(null);
  const [pendingLon, setPendingLon] = useState<string | null>(null);

  const latBtnRef = useRef<HTMLButtonElement | null>(null);
  const lonBtnRef = useRef<HTMLButtonElement | null>(null);
  const [latAnchor, setLatAnchor] = useState<DOMRect | null>(null);
  const [lonAnchor, setLonAnchor] = useState<DOMRect | null>(null);

  // Effective selection: a half-pick (pending) overrides the committed
  // binding so the drawer reflects the click immediately, before its
  // partner lands.
  const latId = pendingLat ?? binding?.latChannelId ?? null;
  const lonId = pendingLon ?? binding?.lonChannelId ?? null;

  const latChannel = latId === null ? null : findChannel(sources, latId);
  const lonChannel = lonId === null ? null : findChannel(sources, lonId);

  const onPickLat = (channelId: string) => {
    if (lonId !== null) {
      // Partner already chosen → commit the full pair; the store now holds
      // the truth, so drop the local half-picks.
      setMapBinding(panelId, { latChannelId: channelId, lonChannelId: lonId });
      setPendingLat(null);
      setPendingLon(null);
    } else {
      setPendingLat(channelId);
    }
    setLatAnchor(null);
  };

  const onPickLon = (channelId: string) => {
    if (latId !== null) {
      setMapBinding(panelId, { latChannelId: latId, lonChannelId: channelId });
      setPendingLat(null);
      setPendingLon(null);
    } else {
      setPendingLon(channelId);
    }
    setLonAnchor(null);
  };

  // Removing either axis clears the whole pair (the binding is a pair) and
  // any in-flight half-pick.
  const clearBinding = () => {
    setPendingLat(null);
    setPendingLon(null);
    setMapBinding(panelId, null);
  };

  return (
    <>
      <section className={s.section}>
        <h4 className={s.sectionTitle}>Latitude</h4>
        {latChannel !== null ? (
          <ul className={s.list}>
            <li className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(latChannel.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={latChannel.name}>
                  {channelLabel(latChannel, unitOverrides)}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={clearBinding}
                aria-label={`Remove ${latChannel.name}`}
                data-testid="panel-map-remove-lat"
              >
                ×
              </button>
            </li>
          </ul>
        ) : (
          <p className={s.empty}>No latitude channel bound.</p>
        )}
        <button
          ref={latBtnRef}
          type="button"
          className={s.addRow}
          onClick={() =>
            setLatAnchor(latBtnRef.current?.getBoundingClientRect() ?? null)
          }
          data-testid="panel-map-pick-lat"
        >
          + pick lat channel…
        </button>
        {latAnchor !== null && (
          <ChannelPicker
            sources={sources}
            selectedIds={latId ? [latId] : []}
            maxSelected={1}
            anchorRect={latAnchor}
            onToggle={onPickLat}
            onClose={() => setLatAnchor(null)}
          />
        )}
      </section>
      <section className={s.section}>
        <h4 className={s.sectionTitle}>Longitude</h4>
        {lonChannel !== null ? (
          <ul className={s.list}>
            <li className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(lonChannel.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={lonChannel.name}>
                  {channelLabel(lonChannel, unitOverrides)}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={clearBinding}
                aria-label={`Remove ${lonChannel.name}`}
                data-testid="panel-map-remove-lon"
              >
                ×
              </button>
            </li>
          </ul>
        ) : (
          <p className={s.empty}>No longitude channel bound.</p>
        )}
        <button
          ref={lonBtnRef}
          type="button"
          className={s.addRow}
          onClick={() =>
            setLonAnchor(lonBtnRef.current?.getBoundingClientRect() ?? null)
          }
          data-testid="panel-map-pick-lon"
        >
          + pick lon channel…
        </button>
        {lonAnchor !== null && (
          <ChannelPicker
            sources={sources}
            selectedIds={lonId ? [lonId] : []}
            maxSelected={1}
            anchorRect={lonAnchor}
            onToggle={onPickLon}
            onClose={() => setLonAnchor(null)}
          />
        )}
      </section>
    </>
  );
}

function TableBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const ids = useSession((st) => st.tableBindings[panelId] ?? EMPTY);

  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  const atCap = ids.length >= MAX_PLOT_SERIES;
  const bound = ids
    .map((id) => channels.find((c) => c.id === id))
    .filter((c): c is Channel => c !== undefined);

  const onToggle = (channelId: string) => {
    const cur = useSession.getState().tableBindings[panelId] ?? [];
    if (cur.includes(channelId)) {
      useSession.getState().removeTableChannel(panelId, channelId);
    } else {
      useSession.getState().addTableChannel(panelId, channelId);
    }
  };

  const onRemove = (channelId: string) =>
    useSession.getState().removeTableChannel(panelId, channelId);

  const openPicker = () => {
    if (!addBtnRef.current) return;
    setPickerAnchor(addBtnRef.current.getBoundingClientRect());
  };

  return (
    <section className={s.section}>
      <div className={s.sectionHeader}>
        <h4 className={s.sectionTitle}>Channels in panel</h4>
        <span className={s.countPill} data-testid="panel-table-count">
          {ids.length} / {MAX_PLOT_SERIES}
        </span>
      </div>
      {bound.length === 0 ? (
        <p className={s.empty}>No channels bound. Add one below.</p>
      ) : (
        <ul className={s.list} data-testid="panel-table-list">
          {bound.map((c) => (
            <li key={c.id} className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(c.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={c.name}>
                  {channelLabel(c, unitOverrides)}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={() => onRemove(c.id)}
                aria-label={`Remove ${c.name}`}
                data-testid={`panel-table-remove-${c.id}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        ref={addBtnRef}
        type="button"
        className={s.addRow}
        aria-disabled={atCap || undefined}
        title={atCap ? `Table full (${MAX_PLOT_SERIES})` : undefined}
        onClick={() => {
          if (atCap) return;
          openPicker();
        }}
        data-testid="panel-table-add-channel"
      >
        + add channel…
      </button>
      {pickerAnchor !== null && (
        <ChannelPicker
          sources={sources}
          selectedIds={ids}
          maxSelected={MAX_PLOT_SERIES}
          anchorRect={pickerAnchor}
          onToggle={onToggle}
          onClose={() => setPickerAnchor(null)}
        />
      )}
    </section>
  );
}

// Mirror of `TableBody` against the Value panel's `valueBindings` map.
// Same multi-channel binding mechanics; only the store actions and the
// `panel-value-*` testids differ.
function ValueBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const ids = useSession((st) => st.valueBindings[panelId] ?? EMPTY);

  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  const atCap = ids.length >= MAX_PLOT_SERIES;
  const bound = ids
    .map((id) => channels.find((c) => c.id === id))
    .filter((c): c is Channel => c !== undefined);

  const onToggle = (channelId: string) => {
    const cur = useSession.getState().valueBindings[panelId] ?? [];
    if (cur.includes(channelId)) {
      useSession.getState().removeValueChannel(panelId, channelId);
    } else {
      useSession.getState().addValueChannel(panelId, channelId);
    }
  };

  const onRemove = (channelId: string) =>
    useSession.getState().removeValueChannel(panelId, channelId);

  const openPicker = () => {
    if (!addBtnRef.current) return;
    setPickerAnchor(addBtnRef.current.getBoundingClientRect());
  };

  return (
    <section className={s.section}>
      <div className={s.sectionHeader}>
        <h4 className={s.sectionTitle}>Channels in panel</h4>
        <span className={s.countPill} data-testid="panel-value-count">
          {ids.length} / {MAX_PLOT_SERIES}
        </span>
      </div>
      {bound.length === 0 ? (
        <p className={s.empty}>No channels bound. Add one below.</p>
      ) : (
        <ul className={s.list} data-testid="panel-value-list">
          {bound.map((c) => (
            <li key={c.id} className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(c.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={c.name}>
                  {channelLabel(c, unitOverrides)}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={() => onRemove(c.id)}
                aria-label={`Remove ${c.name}`}
                data-testid={`panel-value-remove-${c.id}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        ref={addBtnRef}
        type="button"
        className={s.addRow}
        aria-disabled={atCap || undefined}
        title={atCap ? `Panel full (${MAX_PLOT_SERIES})` : undefined}
        onClick={() => {
          if (atCap) return;
          openPicker();
        }}
        data-testid="panel-value-add-channel"
      >
        + add channel…
      </button>
      {pickerAnchor !== null && (
        <ChannelPicker
          sources={sources}
          selectedIds={ids}
          maxSelected={MAX_PLOT_SERIES}
          anchorRect={pickerAnchor}
          onToggle={onToggle}
          onClose={() => setPickerAnchor(null)}
        />
      )}
    </section>
  );
}

// Mirror of `TableBody`/`ValueBody` against the Enum panel's
// `enumBindings` map: multi-channel scalar binding, one state strip per
// bound channel. Only the store actions and the `panel-enum-*` testids
// differ.
function EnumBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const ids = useSession((st) => st.enumBindings[panelId] ?? EMPTY);

  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  const atCap = ids.length >= MAX_PLOT_SERIES;
  const bound = ids
    .map((id) => channels.find((c) => c.id === id))
    .filter((c): c is Channel => c !== undefined);

  const onToggle = (channelId: string) => {
    const cur = useSession.getState().enumBindings[panelId] ?? [];
    if (cur.includes(channelId)) {
      useSession.getState().removeEnumChannel(panelId, channelId);
    } else {
      useSession.getState().addEnumChannel(panelId, channelId);
    }
  };

  const onRemove = (channelId: string) =>
    useSession.getState().removeEnumChannel(panelId, channelId);

  const openPicker = () => {
    if (!addBtnRef.current) return;
    setPickerAnchor(addBtnRef.current.getBoundingClientRect());
  };

  return (
    <section className={s.section}>
      <div className={s.sectionHeader}>
        <h4 className={s.sectionTitle}>Channels in panel</h4>
        <span className={s.countPill} data-testid="panel-enum-count">
          {ids.length} / {MAX_PLOT_SERIES}
        </span>
      </div>
      {bound.length === 0 ? (
        <p className={s.empty}>No channels bound. Add one below.</p>
      ) : (
        <ul className={s.list} data-testid="panel-enum-list">
          {bound.map((c) => (
            <li key={c.id} className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(c.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={c.name}>
                  {channelLabel(c, unitOverrides)}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={() => onRemove(c.id)}
                aria-label={`Remove ${c.name}`}
                data-testid={`panel-enum-remove-${c.id}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        ref={addBtnRef}
        type="button"
        className={s.addRow}
        aria-disabled={atCap || undefined}
        title={atCap ? `Panel full (${MAX_PLOT_SERIES})` : undefined}
        onClick={() => {
          if (atCap) return;
          openPicker();
        }}
        data-testid="panel-enum-add-channel"
      >
        + add channel…
      </button>
      {pickerAnchor !== null && (
        <ChannelPicker
          sources={sources}
          selectedIds={ids}
          maxSelected={MAX_PLOT_SERIES}
          anchorRect={pickerAnchor}
          kinds={["scalar", "enum"]}
          onToggle={onToggle}
          onClose={() => setPickerAnchor(null)}
        />
      )}
    </section>
  );
}

const EMPTY: readonly string[] = Object.freeze([]);

function findChannel(sources: SourceMeta[], channelId: string): Channel | null {
  for (const src of sources) {
    const hit = src.channels.find((c) => c.id === channelId);
    if (hit) return hit;
  }
  return null;
}

// Codec lives on the rAF-published HUD snapshot, not in the store.
// Poll at 250ms while a video is bound — cheap, doesn't churn the
// reconciler, and the codec field is set once per fixture load anyway.
function useDecoderCodec(bindingId: string | null): string | null {
  const [codec, setCodec] = useState<string | null>(null);
  useEffect(() => {
    if (bindingId === null) {
      setCodec(null);
      return;
    }
    setCodec(window.__drivelineVideoHud?.codec ?? null);
    const tick = () => {
      const next = window.__drivelineVideoHud?.codec ?? null;
      setCodec((prev) => (prev === next ? prev : next));
    };
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [bindingId]);
  return codec;
}
