// Phase 6 · MapPanel — OSM tiles + lat/lon polyline.
//
// Reads `mapBindings[panelId]` (latChannelId + lonChannelId) and renders
// a polyline on Leaflet over the OpenStreetMap tile layer. Channel
// binding is explicit through the Panel drawer — the integration plan
// rejects `*.lat`/`*.lon` magic (`docs/design/v1-shell-integration.md`
// §6 open-question 2).
//
// Polyline points are downsampled to ≤ MAX_POINTS by walking every Nth
// row of the decoded Arrow payload. Two fetches in parallel (lat, lon)
// per `globalRange` change; pairs are zipped on the *index* under the
// assumption that lat and lon are coordinate samples emitted by the
// same source (true for the MF4/MCAP fixtures we ship). If a future
// fixture uses two distinct cadences we'll need a merge step — flagged
// in STATUS.md as a Phase 7+ carry-over rather than fixed here.
//
// Beyond the polyline this panel surfaces explicit load/error/empty
// states (so a failed fetch is visible, not just `console.error` + a
// stale line) and a cursor marker that tracks the GPS fix at the shared
// `cursorNs`. Bounds are auto-fit only on first load / binding change so
// the fit doesn't fight manual pan/zoom on every refetch.
//
// Leaflet is loaded eagerly because react-leaflet pulls it in on import
// anyway. Bundle hit ≈ 40 KB gzipped, well under the 350 KB budget.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLngExpression } from "leaflet";
import { useSession } from "../state/store";
import type { Channel, SourceMeta } from "../state/store";
import { colorFor } from "./palette";
import { decodeSeries } from "./seriesFromArrow";
import styles from "./MapPanel.module.css";

interface MapPanelProps {
  panelId: string;
}

const MAX_POINTS = 5000;
const DEFAULT_CENTER: LatLngExpression = [0, 0];
const DEFAULT_ZOOM = 2;

// A GPS fix paired with the ns timestamp it was sampled at, so the cursor
// marker can locate "the fix at (or just before) cursorNs".
interface TrackPoint {
  lat: number;
  lon: number;
  tsNs: bigint;
}

// Load status for the fetch+decode pipeline. Discriminated so the render
// branches are explicit (no "blank when not ready" bug).
type Load =
  | { status: "idle" } // no binding / no range yet
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; track: TrackPoint[] };

function findChannel(sources: SourceMeta[], channelId: string): Channel | null {
  for (const s of sources) {
    const hit = s.channels.find((c) => c.id === channelId);
    if (hit) return hit;
  }
  return null;
}

// Zip lat/lon by index into timestamped track points, dropping non-finite
// coordinates, and downsample to ≤ MAX_POINTS. The final in-range sample is
// always kept so the tail isn't clipped by the stride.
function buildTrack(
  lats: Float64Array,
  lons: Float64Array,
  tsNs: BigInt64Array,
): TrackPoint[] {
  const n = Math.min(lats.length, lons.length, tsNs.length);
  if (n === 0) return [];
  const stride = n > MAX_POINTS ? Math.ceil(n / MAX_POINTS) : 1;
  const out: TrackPoint[] = [];
  const push = (i: number) => {
    const lat = lats[i];
    const lon = lons[i];
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      out.push({ lat, lon, tsNs: tsNs[i] });
    }
  };
  for (let i = 0; i < n; i += stride) push(i);
  // Always include the final sample so the polyline tail isn't clipped by
  // the stride.
  const lastIdx = n - 1;
  if (lastIdx % stride !== 0) {
    const last = out[out.length - 1];
    const lat = lats[lastIdx];
    const lon = lons[lastIdx];
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      (!last || last.lat !== lat || last.lon !== lon)
    ) {
      out.push({ lat, lon, tsNs: tsNs[lastIdx] });
    }
  }
  return out;
}

function toLatLng(track: TrackPoint[]): LatLngExpression[] {
  return track.map((p) => [p.lat, p.lon] as [number, number]);
}

// Locate the track point at (or just before) cursorNs via binary search.
// `track` is ordered by tsNs (GPS samples are emitted in time order).
function trackPointAt(
  track: TrackPoint[],
  cursorNs: bigint,
): TrackPoint | null {
  if (track.length === 0) return null;
  if (cursorNs < track[0].tsNs) return null;
  let lo = 0;
  let hi = track.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track[mid].tsNs <= cursorNs) lo = mid;
    else hi = mid - 1;
  }
  return track[lo];
}

// Auto-fit the map to the polyline only on first appearance of a track or
// when the binding changes (keyed by `fitKey`). After that the user owns the
// viewport — a refetch on range change won't yank the pan/zoom back.
function FitToPolyline({
  points,
  fitKey,
}: {
  points: LatLngExpression[];
  fitKey: string;
}) {
  const map = useMap();
  const lastFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (points.length < 2) return;
    if (lastFitKey.current === fitKey) return;
    lastFitKey.current = fitKey;
    map.fitBounds(points as [number, number][], {
      padding: [20, 20],
      animate: false,
    });
  }, [map, points, fitKey]);
  return null;
}

export function MapPanel({ panelId }: MapPanelProps) {
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  const binding = useSession((s) => s.mapBindings[panelId] ?? null);
  const setMapBinding = useSession((s) => s.setMapBinding);
  const cursorNs = useSession((s) => s.cursorNs);

  const latChannel = useMemo(
    () =>
      binding === null ? null : findChannel(sources, binding.latChannelId),
    [binding, sources],
  );
  const lonChannel = useMemo(
    () =>
      binding === null ? null : findChannel(sources, binding.lonChannelId),
    [binding, sources],
  );

  // Drop the binding if either channel went away (defence against
  // stale persisted ids). Gate on `sources.length > 0` so a fresh
  // hydrate (channels list empty) doesn't wipe a persisted binding
  // before the user has dropped a file.
  useEffect(() => {
    if (sources.length === 0) return;
    if (binding !== null && (latChannel === null || lonChannel === null)) {
      setMapBinding(panelId, null);
    }
  }, [binding, latChannel, lonChannel, panelId, setMapBinding, sources.length]);

  const [load, setLoad] = useState<Load>({ status: "idle" });

  useEffect(() => {
    if (!globalRange || !latChannel || !lonChannel) {
      setLoad({ status: "idle" });
      return;
    }
    let aborted = false;
    setLoad({ status: "loading" });
    void (async () => {
      try {
        const store = useSession.getState();
        const [latBytes, lonBytes] = await Promise.all([
          store.fetchChannelRange(
            latChannel.id,
            globalRange.startNs,
            globalRange.endNs,
            false,
          ),
          store.fetchChannelRange(
            lonChannel.id,
            globalRange.startNs,
            globalRange.endNs,
            false,
          ),
        ]);
        if (aborted) return;
        const latRes = decodeSeries(latBytes);
        const lonRes = decodeSeries(lonBytes);
        if (!latRes.ok) {
          setLoad({ status: "error", message: latRes.message });
          return;
        }
        if (!lonRes.ok) {
          setLoad({ status: "error", message: lonRes.message });
          return;
        }
        const track = buildTrack(latRes.ys, lonRes.ys, latRes.rawTsNs);
        setLoad({ status: "ready", track });
      } catch (err) {
        if (aborted) return;
        console.error("MapPanel fetch failed", err);
        setLoad({
          status: "error",
          message:
            err instanceof Error ? err.message : "Failed to load GPS data.",
        });
      }
    })();
    return () => {
      aborted = true;
    };
  }, [globalRange, latChannel, lonChannel]);

  const isEmpty =
    binding === null || latChannel === null || lonChannel === null;

  // Fit key changes when the binding changes, re-arming the one-shot
  // auto-fit; refetches on range change keep the same key so they don't
  // re-fit.
  const fitKey = binding
    ? `${binding.latChannelId}|${binding.lonChannelId}`
    : "";

  const track = load.status === "ready" ? load.track : [];
  const points = useMemo(() => toLatLng(track), [track]);
  const cursorPoint = useMemo(
    () => trackPointAt(track, cursorNs),
    [track, cursorNs],
  );

  return (
    <section className={styles.panel} data-testid="map-panel">
      {isEmpty ? (
        <div className={styles.empty} data-testid="map-empty">
          <p className={styles.emptyTitle}>Map</p>
          <p className={styles.emptyBody}>
            Bind lat / lon scalar channels from the Panel drawer.
          </p>
        </div>
      ) : (
        <div className={styles.mapContainer} data-testid="map-container">
          <MapContainer
            center={DEFAULT_CENTER}
            zoom={DEFAULT_ZOOM}
            scrollWheelZoom
            className={styles.map}
            attributionControl
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {points.length > 1 && (
              <>
                {/* Polyline colour is a data-viz series colour from the
                    plot palette (not the cursor accent). Two MapPanels
                    in one workspace pick distinct hues; cursor strokes
                    stay separate via panels/cursorOverlay.ts. */}
                <Polyline
                  positions={points}
                  pathOptions={{ color: colorFor(panelId), weight: 3 }}
                />
                <FitToPolyline points={points} fitKey={fitKey} />
              </>
            )}
            {cursorPoint !== null && (
              // Marker tracking the GPS fix at the shared cursor. Cursor
              // accent (not the series colour) so it reads as "where am I"
              // rather than "another track".
              <CircleMarker
                center={[cursorPoint.lat, cursorPoint.lon]}
                radius={6}
                pathOptions={{
                  color: "#f97316",
                  fillColor: "#f97316",
                  fillOpacity: 0.9,
                  weight: 2,
                }}
              />
            )}
          </MapContainer>

          {/* Status overlays. Mutually exclusive with the polyline so a
              failed/empty fetch is visible rather than a stale line. */}
          {load.status === "loading" && (
            <div
              className={styles.statusOverlay}
              data-testid="map-loading"
              role="status"
            >
              Loading GPS…
            </div>
          )}
          {load.status === "error" && (
            <div
              className={styles.statusOverlay}
              data-testid="map-error"
              role="alert"
            >
              <span className={styles.statusIcon} aria-hidden="true">
                !
              </span>
              {load.message}
            </div>
          )}
          {load.status === "ready" && points.length === 0 && (
            <div
              className={styles.statusOverlay}
              data-testid="map-no-data"
              role="status"
            >
              No GPS fixes in range.
            </div>
          )}

          <span className={styles.pointsPill} data-testid="map-points-count">
            {points.length} pts
          </span>
        </div>
      )}
    </section>
  );
}
