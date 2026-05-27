// @vitest-environment jsdom
//
// Regression guard for PR #79. The container resolves the binding's
// `Channel` and forwards the *native* id ("0/1", "/cam/front",
// "1/video") to `VideoPanel`, not the session-level qualified id. The
// videoDecode worker, dataCore worker, and `Mp4SampleCache` all key
// off the wasm-internal native id, so passing the qualified id (the
// `<len>|<native>|<src>` envelope minted by `qualifiedChannelId`)
// tears down the entire video pipeline silently — the panel mounts,
// but no frames decode.
//
// We mock `VideoPanel` at the module boundary so the test runs under
// jsdom without web workers, OffscreenCanvas, or VideoDecoder; the
// stub records its props so we can assert the routing.
//
// We also mock `VideoPanelEmptyState` so its CSS Module + fetch logic
// don't have to run in this test — the empty-state component has its
// own dedicated assertions (and a smoke run via Playwright).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lastVideoPanelProps: { current: Record<string, unknown> | null } = {
  current: null,
};
const lastEmptyStateProps: { current: Record<string, unknown> | null } = {
  current: null,
};

vi.mock("./VideoPanel", () => ({
  VideoPanel: (props: Record<string, unknown>) => {
    lastVideoPanelProps.current = props;
    return <div data-testid="mock-video-panel" />;
  },
}));

vi.mock("./VideoPanelEmptyState", () => ({
  VideoPanelEmptyState: (props: Record<string, unknown>) => {
    lastEmptyStateProps.current = props;
    const candidates = props.candidates as
      | { channel: { id: string }; source: { name: string } }[]
      | undefined;
    return (
      <div
        data-testid="mock-video-empty-state"
        data-variant={(props.variant as string | undefined) ?? "primary"}
        data-candidate-count={candidates?.length ?? 0}
      >
        {/* Mirror the picker rows the real empty state renders so the
         *  container test can still assert `video-pick-${channelId}`
         *  remains reachable through the unified surface. */}
        {candidates?.map((c) => (
          <button
            key={c.channel.id}
            data-testid={`video-pick-${c.channel.id}`}
            onClick={() =>
              (props.onPick as (id: string) => void)?.(c.channel.id)
            }
          >
            {c.source.name}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock("./VideoPanelContainer.module.css", () => ({
  default: {
    wrap: "wrap",
    emptyWrap: "emptyWrap",
  },
}));

import { VideoPanelContainer } from "./VideoPanelContainer";
import { useSession, qualifiedChannelId, type SourceMeta } from "../state/store";

const NATIVE_ID = "1/video";
const QUALIFIED_ID = qualifiedChannelId("clip.mp4", NATIVE_ID);

const SOURCE: SourceMeta = {
  id: "clip.mp4",
  kind: "mp4+sidecar",
  name: "clip.mp4",
  handle: 7,
  timeRange: { startNs: 0n, endNs: 1_000_000_000n },
  channels: [
    {
      id: QUALIFIED_ID,
      nativeId: NATIVE_ID,
      sourceId: "clip.mp4",
      name: "track_1",
      kind: "video",
      dtype: null,
      unit: null,
      sampleCount: 30,
      timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    },
  ],
};

beforeEach(() => {
  lastVideoPanelProps.current = null;
  lastEmptyStateProps.current = null;
  useSession.setState({
    sources: [SOURCE],
    channels: SOURCE.channels,
    globalRange: SOURCE.timeRange,
    videoBindings: { "video-1": QUALIFIED_ID },
  });
});

afterEach(async () => {
  cleanup();
  await useSession.getState().clear();
  useSession.setState({ videoBindings: {} });
});

describe("VideoPanelContainer", () => {
  it("forwards the channel's nativeId (not the qualified id) to VideoPanel", () => {
    // PR #79 regression: previously this passed `resolved.channel.id`,
    // i.e. the qualified envelope, which the videoDecode worker can't
    // open — every video panel rendered an empty canvas after the
    // double-MF4 fix landed. The bug is undetectable from the
    // container's DOM output, so the assertion has to inspect the
    // forwarded prop directly.
    render(<VideoPanelContainer panelId="video-1" />);
    expect(screen.getByTestId("mock-video-panel")).toBeTruthy();
    const props = lastVideoPanelProps.current;
    expect(props).not.toBeNull();
    expect(props!.channelId).toBe(NATIVE_ID);
    // Critical negative: the qualified id must NOT leak through. If
    // someone reverts the fix, this catches it even when the qualified
    // id happens to equal the native id (single-source case).
    expect(props!.channelId).not.toBe(QUALIFIED_ID);
  });

  it("forwards the source's handle and the resolved sourceKind", () => {
    // Other props the container is responsible for assembling — pin
    // them so a refactor that drops one (e.g. forgetting `panelId`)
    // doesn't regress the worker wiring silently.
    render(<VideoPanelContainer panelId="video-1" />);
    const props = lastVideoPanelProps.current!;
    expect(props.sourceHandle).toBe(7);
    expect(props.sourceKind).toBe("mp4");
    expect(props.panelId).toBe("video-1");
  });

  it("forwards candidates into the unified empty state when channels are loaded but unbound", () => {
    // iter5 issue #5 — there used to be two diverging empty-state
    // designs (compact-with-picker vs rich-no-picker). The container
    // now passes candidates directly into a single empty-state
    // component, which renders the picker rows as its tertiary
    // affordance. Variant stays `primary` whenever no binding is set,
    // so the drop zone reads the same on every cold open.
    useSession.setState({ videoBindings: { "video-1": null } });
    render(<VideoPanelContainer panelId="video-1" />);
    expect(screen.queryByTestId("mock-video-panel")).toBeNull();
    expect(screen.getByTestId("video-panel-video-1-empty")).toBeTruthy();
    const empty = screen.getByTestId("mock-video-empty-state");
    // Same `primary` variant whether candidates exist or not — the
    // unified empty state owns the inner layout.
    expect(empty.getAttribute("data-variant")).toBe("primary");
    expect(empty.getAttribute("data-candidate-count")).toBe("1");
    // Picker channel button still surfaces through the unified empty
    // state (mocked) so the regression test from PR #79 holds.
    expect(screen.getByTestId(`video-pick-${QUALIFIED_ID}`)).toBeTruthy();
  });

  it("renders the primary empty state when no video candidates are loaded", () => {
    // First-impression case. The empty state still gets the primary
    // variant so the drop zone, sample link, and footnote are all
    // present.
    useSession.setState({
      sources: [],
      channels: [],
      globalRange: null,
      videoBindings: { "video-1": null },
    });
    render(<VideoPanelContainer panelId="video-1" />);
    expect(screen.queryByTestId("mock-video-panel")).toBeNull();
    const empty = screen.getByTestId("mock-video-empty-state");
    expect(empty).toBeTruthy();
    expect(empty.getAttribute("data-variant")).toBe("primary");
    expect(empty.getAttribute("data-candidate-count")).toBe("0");
  });

  it("uses the compact variant when a stale binding points at a missing channel", () => {
    // iter5 issue #5 — the "channel no longer available" branch keeps
    // its tighter (`compact`) variant so the explainer copy fits
    // when the panel is small. The unified structure still applies
    // (drop zone + sample + picker), just at compact spacing.
    useSession.setState({
      sources: [SOURCE],
      channels: SOURCE.channels,
      globalRange: SOURCE.timeRange,
      // Binding points at a channel id that does NOT exist in the
      // current session, mimicking a layout reload after the source
      // list changed.
      videoBindings: { "video-1": "stale-channel" },
    });
    render(<VideoPanelContainer panelId="video-1" />);
    const empty = screen.getByTestId("mock-video-empty-state");
    expect(empty.getAttribute("data-variant")).toBe("compact");
    // The picker is still available (candidate is the *real* channel
    // in the source) so the user can rebind in one click.
    expect(screen.getByTestId(`video-pick-${QUALIFIED_ID}`)).toBeTruthy();
  });

  it("picker click invokes setVideoBinding through the unified empty state", () => {
    // iter5 issue #5 — exercise the onPick → setVideoBinding wiring.
    // The container now passes a thin `onPick` callback to the empty
    // state instead of rendering the buttons inline.
    useSession.setState({ videoBindings: { "video-1": null } });
    render(<VideoPanelContainer panelId="video-1" />);
    expect(useSession.getState().videoBindings["video-1"]).toBeNull();
    act(() => {
      screen.getByTestId(`video-pick-${QUALIFIED_ID}`).click();
    });
    expect(useSession.getState().videoBindings["video-1"]).toBe(
      QUALIFIED_ID,
    );
  });
});
