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
  Polyline: ({ positions }: { positions: unknown }) => (
    <div data-testid="mock-polyline" data-len={String((positions as unknown[]).length)} />
  ),
  useMap: () => ({
    fitBounds: () => undefined,
  }),
}));

vi.mock("leaflet/dist/leaflet.css", () => ({}));

import { MapPanel } from "./MapPanel";
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
    useSession.setState({
      sources: [],
      channels: [],
      globalRange: null,
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
});
