// Plot panel settings body, split out of `PanelDrawer.tsx`: the channel
// list (via the shared `MultiChannelBindingSection`), per-series field
// controls (y-axis / unit / transform), the stats block, and the zoom /
// stack / gap-threshold controls.

import { useSession } from "../../../state/store";
import {
  MAX_PLOT_Y_AXES,
  effectivePlotZoomX,
  isPlotTimeAxisSynced,
  selectChannelsById,
  type Channel,
  type PlotTransform,
} from "../../../state/store";
import { channelLabel } from "../../../state/units";
import { colorFor } from "../../../panels/palette";
import {
  WHEEL_ZOOM_STEP,
  isPlotZoomed,
  scaleWindowX,
} from "../../../panels/plotZoom";
import type { PlotSeriesStats, PlotSyncSnapshot } from "../../../panels/PlotPanel";
import { MultiChannelBindingSection } from "./MultiChannelBindingSection";
import { usePolledSnapshot, useDraftField } from "./hooks";
import { EMPTY, formatStat, resolveBound, type BodyProps } from "./shared";
import s from "../PanelDrawer.module.css";

export function PlotBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const ids = useSession((st) => st.plotBindings[panelId] ?? EMPTY);
  const unitOverrides = useSession((st) => st.unitOverrides);

  const bound = resolveBound(ids, selectChannelsById({ channels }));

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

  return (
    <>
      <MultiChannelBindingSection
        ids={ids}
        bound={bound}
        sources={sources}
        unitOverrides={unitOverrides}
        toggleChannel={onToggle}
        removeChannel={onRemove}
        testidPrefix="panel-plot"
        fullLabel="Plot"
        renderRowFields={(c) => (
          <>
            <PlotChannelAxisPicker panelId={panelId} channelId={c.id} />
            <PlotChannelUnitInput channel={c} />
            <PlotTransformPicker panelId={panelId} channelId={c.id} />
          </>
        )}
      />
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
  const { draft, setDraft, commit, reseed } = useDraftField<string | undefined>(
    {
      storeValue: override,
      format: (v) => v ?? channel.unit ?? "",
      commit: (d) => useSession.getState().setChannelUnit(channel.id, d),
    },
  );

  const reset = () => {
    useSession.getState().setChannelUnit(channel.id, null);
    reseed(channel.unit ?? "");
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

/**
 * P4 · per-series statistics block. Reads the rAF-published plot sync
 * snapshot (`window.__drivelinePlotPanels[panelId]`) — the same surface
 * the e2e specs assert on — and renders min / max / mean / current-at-
 * cursor for each bound channel. Polled at `SNAPSHOT_POLL_MS` plus
 * re-read on cursor change so the "current" column tracks the scrubber;
 * kept off the hot path (no per-frame work here).
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
  const snap = usePolledSnapshot<PlotSyncSnapshot | undefined>(
    () => window.__drivelinePlotPanels?.[panelId],
    [panelId, cursorNs],
  );

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
  // immediately normalised to null by the store. Re-seeded from the store
  // value (compared numerically) when it changes externally; only the
  // blur/Enter commit calls the store action.
  const { draft, setDraft, reseed } = useDraftField<number | null>({
    storeValue: gapThresholdSec,
    format: (v) => (v === null ? "1" : String(v)),
    commit: () => {},
  });

  const setStore = (sec: number | null) => {
    useSession.getState().setPlotGapThreshold(panelId, sec);
  };

  const commitDraft = () => {
    const parsed = Number.parseFloat(draft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      // Invalid input → revert the draft to the previous on-value
      // rather than turning the threshold off. The user's intent here
      // is "I typed something" not "turn this off."
      reseed(gapThresholdSec === null ? "1" : String(gapThresholdSec));
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
