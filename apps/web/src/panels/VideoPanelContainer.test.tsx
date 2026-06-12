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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const lastVideoPanelProps: { current: Record<string, unknown> | null } = {
  current: null,
};

vi.mock("./VideoPanel", () => ({
  VideoPanel: (props: Record<string, unknown>) => {
    lastVideoPanelProps.current = props;
    return <div data-testid="mock-video-panel" />;
  },
}));

vi.mock("./VideoPanelContainer.module.css", () => ({
  default: {
    wrap: "wrap",
    empty: "empty",
    clearBtn: "clearBtn",
    hint: "hint",
    list: "list",
    choice: "choice",
    choiceSource: "choiceSource",
    choiceName: "choiceName",
  },
}));

import { VideoPanelContainer } from "./VideoPanelContainer";
import {
  useSession,
  qualifiedChannelId,
  type SourceMeta,
} from "../state/store";

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

  it("renders the picker when the binding does not resolve to a video channel", () => {
    // Sanity guard: when there's no binding, the container shouldn't
    // render the mocked VideoPanel at all. Without this, the
    // `expect(props.channelId).toBe(NATIVE_ID)` assertion above would
    // also pass for a stale `lastVideoPanelProps` from a prior test —
    // catching that ordering bug here keeps the regression test honest.
    useSession.setState({ videoBindings: { "video-1": null } });
    render(<VideoPanelContainer panelId="video-1" />);
    expect(screen.queryByTestId("mock-video-panel")).toBeNull();
    expect(screen.getByTestId("video-panel-video-1-empty")).toBeTruthy();
  });
});
