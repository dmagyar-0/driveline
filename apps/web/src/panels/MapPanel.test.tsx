// @vitest-environment jsdom
//
// Phase 6 · MapPanel render tests. Leaflet manipulates real DOM
// dimensions and crashes under jsdom, so react-leaflet is mocked at
// the module boundary. We assert the empty-state and the bound-state
// branch render; the actual tile/polyline rendering is exercised by
// the e2e spec under apps/e2e/tests/.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { ReactNode } from "react";

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="mock-map-container">{children}</div>
  ),
  TileLayer: () => <div data-testid="mock-tile-layer" />,
  Polyline: ({
    positions,
    pathOptions,
  }: {
    positions: unknown;
    pathOptions?: { color?: string };
  }) => (
    <div
      data-testid="mock-polyline"
      data-len={String((positions as unknown[]).length)}
      data-color={pathOptions?.color ?? ""}
    />
  ),
  useMap: () => ({
    fitBounds: () => undefined,
  }),
}));

vi.mock("leaflet/dist/leaflet.css", () => ({}));

vi.mock("./seriesFromArrow", () => ({
  seriesFromArrow: () => ({
    xs: new Float64Array([0, 1, 2]),
    ys: new Float64Array([10, 20, 30]),
  }),
}));

import { MapPanel } from "./MapPanel";
import { colorFor } from "./palette";
import { useSession, type SourceMeta } from "../state/store";

const SOURCE: SourceMeta = {
  id: "src-a",
  kind: "mcap",
  name: "a.mcap",
  handle: 1,
  timeRange: { startNs: 0n, endNs: 1_000_000_000n },
  channels: [
    {
      id: "/gps/lat",
      nativeId: "/gps/lat",
      sourceId: "src-a",
      name: "lat",
      kind: "scalar",
      dtype: "f64",
      unit: "deg",
      sampleCount: 3,
      timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    },
    {
      id: "/gps/lon",
      nativeId: "/gps/lon",
      sourceId: "src-a",
      name: "lon",
      kind: "scalar",
      dtype: "f64",
      unit: "deg",
      sampleCount: 3,
      timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    },
  ],
};

function seed(): void {
  useSession.setState({
    sources: [SOURCE],
    channels: SOURCE.channels,
    globalRange: SOURCE.timeRange,
  });
}

describe("MapPanel", () => {
  afterEach(async () => {
    cleanup();
    await useSession.getState().clear();
  });

  it("renders the empty state when nothing is bound", () => {
    seed();
    render(<MapPanel panelId="map-1" />);
    expect(screen.getByTestId("map-empty")).toBeTruthy();
  });

  it("renders the map container when a binding is set", () => {
    seed();
    useSession.getState().setMapBinding("map-1", {
      latChannelId: "/gps/lat",
      lonChannelId: "/gps/lon",
    });
    render(<MapPanel panelId="map-1" />);
    expect(screen.getByTestId("map-container")).toBeTruthy();
    expect(screen.getByTestId("mock-tile-layer")).toBeTruthy();
  });

  it("clears the binding when one of the channels disappears", () => {
    // Seed a source so the cull effect runs — the gate on
    // `sources.length > 0` exists so a fresh hydrate (channels list
    // empty) doesn't wipe persisted bindings before the user has
    // dropped a file.
    seed();
    useSession.setState({
      mapBindings: {
        "map-1": {
          latChannelId: "/ghost/lat",
          lonChannelId: "/ghost/lon",
        },
      },
    });
    render(<MapPanel panelId="map-1" />);
    expect(screen.getByTestId("map-empty")).toBeTruthy();
    expect(useSession.getState().mapBindings["map-1"]).toBeNull();
  });

  it("does not clear a persisted binding before any source loads", () => {
    useSession.setState({
      sources: [],
      channels: [],
      globalRange: null,
      mapBindings: {
        "map-1": {
          latChannelId: "/persisted/lat",
          lonChannelId: "/persisted/lon",
        },
      },
    });
    render(<MapPanel panelId="map-1" />);
    expect(useSession.getState().mapBindings["map-1"]).toEqual({
      latChannelId: "/persisted/lat",
      lonChannelId: "/persisted/lon",
    });
  });

  it("paints the polyline with the panel's palette colour", async () => {
    seed();
    useSession.setState({
      fetchChannelRange: async () => new Uint8Array(),
    });
    useSession.getState().setMapBinding("map-1", {
      latChannelId: "/gps/lat",
      lonChannelId: "/gps/lon",
    });
    render(<MapPanel panelId="map-1" />);
    const poly = await screen.findByTestId("mock-polyline");
    expect(poly.getAttribute("data-color")).toBe(colorFor("map-1"));
  });
});
