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
// Leaflet is driven through its imperative API (not a React wrapper) so
// the dependency tree stays fully OSI-permissive: leaflet is BSD-2-Clause.
// The map instance and polyline live in refs — they're DOM-bound and not
// serialisable, so they never enter React state or the store. Bundle hit
// ≈ 40 KB gzipped, well under the 350 KB budget.

import { useEffect, useMemo, useRef, useState } from "react";
import * as L from "leaflet";
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
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

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

  // Imperative Leaflet wiring. The host <div> only exists in the bound
  // branch, so the map is created when `isEmpty` flips to false and torn
  // down (map.remove) when it flips back. mapRef guards against a double
  // create under StrictMode's mount/cleanup/mount.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);

  useEffect(() => {
    if (isEmpty) return;
    const host = hostRef.current;
    if (!host || mapRef.current) return;
    const map = L.map(host, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      scrollWheelZoom: true,
      attributionControl: true,
    });
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      lineRef.current = null;
    };
  }, [isEmpty]);

  // Redraw the polyline (and fit to it) whenever the downsampled points or
  // the panel's palette colour change. Runs after the map-create effect on
  // the same commit, so mapRef is populated by the time we read it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (lineRef.current) {
      lineRef.current.remove();
      lineRef.current = null;
    }
    if (points.length > 1) {
      // Polyline colour is a data-viz series colour from the plot palette
      // (not the cursor accent). Two MapPanels in one workspace pick
      // distinct hues; cursor strokes stay separate via cursorOverlay.ts.
      const line = L.polyline(points, {
        color: colorFor(panelId),
        weight: 3,
      }).addTo(map);
      lineRef.current = line;
      map.fitBounds(line.getBounds(), { padding: [20, 20], animate: false });
    }
  }, [points, panelId]);

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
          <div
            ref={hostRef}
            className={styles.map}
            data-testid="map-leaflet"
          />
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
