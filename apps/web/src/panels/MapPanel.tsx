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
// Leaflet is loaded eagerly because react-leaflet pulls it in on import
// anyway. Bundle hit ≈ 40 KB gzipped, well under the 350 KB budget.

import { useEffect, useMemo, useState } from "react";
import { MapContainer, Polyline, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLngExpression } from "leaflet";
import { useSession } from "../state/store";
import type { Channel, SourceMeta } from "../state/store";
import { colorFor } from "./palette";
import { seriesFromArrow } from "./seriesFromArrow";
import styles from "./MapPanel.module.css";

interface MapPanelProps {
  panelId: string;
}

const MAX_POINTS = 5000;
const DEFAULT_CENTER: LatLngExpression = [0, 0];
const DEFAULT_ZOOM = 2;

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

function downsample(
  lats: Float64Array,
  lons: Float64Array,
): LatLngExpression[] {
  const n = Math.min(lats.length, lons.length);
  if (n === 0) return [];
  const stride = n > MAX_POINTS ? Math.ceil(n / MAX_POINTS) : 1;
  const out: LatLngExpression[] = [];
  for (let i = 0; i < n; i += stride) {
    const lat = lats[i];
    const lon = lons[i];
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      out.push([lat, lon]);
    }
  }
  // Always include the final sample so the polyline tail isn't clipped
  // by the stride.
  if (n > 0) {
    const lat = lats[n - 1];
    const lon = lons[n - 1];
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const last = out[out.length - 1] as [number, number] | undefined;
      if (!last || last[0] !== lat || last[1] !== lon) out.push([lat, lon]);
    }
  }
  return out;
}

// Subscribe inside the MapContainer so we can `fitBounds` whenever the
// polyline changes — useMap() must be called within the MapContainer
// children tree, hence this nested component rather than a ref dance.
function FitToPolyline({ points }: { points: LatLngExpression[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length < 2) return;
    map.fitBounds(points as [number, number][], {
      padding: [20, 20],
      animate: false,
    });
  }, [map, points]);
  return null;
}

export function MapPanel({ panelId }: MapPanelProps) {
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  const binding = useSession((s) => s.mapBindings[panelId] ?? null);
  const setMapBinding = useSession((s) => s.setMapBinding);

  const latChannel = useMemo(
    () =>
      binding === null
        ? null
        : findChannel(sources, binding.latChannelId),
    [binding, sources],
  );
  const lonChannel = useMemo(
    () =>
      binding === null
        ? null
        : findChannel(sources, binding.lonChannelId),
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

  const [points, setPoints] = useState<LatLngExpression[]>([]);

  useEffect(() => {
    if (!globalRange || !latChannel || !lonChannel) {
      setPoints([]);
      return;
    }
    let aborted = false;
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
        const lats = seriesFromArrow(latBytes).ys;
        const lons = seriesFromArrow(lonBytes).ys;
        setPoints(downsample(lats, lons));
      } catch (err) {
        if (!aborted) console.error("MapPanel fetch failed", err);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [globalRange, latChannel, lonChannel]);

  const isEmpty = binding === null || latChannel === null || lonChannel === null;

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
                <FitToPolyline points={points} />
              </>
            )}
          </MapContainer>
          <span
            className={styles.pointsPill}
            data-testid="map-points-count"
          >
            {points.length} pts
          </span>
        </div>
      )}
    </section>
  );
}
