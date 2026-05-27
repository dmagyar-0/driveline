// @vitest-environment jsdom
//
// Unit coverage for the VideoToolbar (iter 3 video-polish).
//
// What we assert:
//   • frame-step buttons resolve to neighbouring sidecar PTS values
//     and disable when no sidecar is provided.
//   • scrub buttons add/subtract a full second from `cursorNs`.
//   • play/pause toggle delegates to the existing store actions.
//   • fit/fill toggle flips the displayed label + aria-pressed bit.
//   • resolution chip mirrors the prop passed in.
//   • health-tone helpers (the small bits of pure logic re-exported via
//     `__test`) classify drops/fps correctly.
//
// We don't drive the rAF FPS loop in jsdom — it's bookkeeping over
// `window.__drivelineVideoHud` which the real `VideoPanel` writes from
// its blit loop. The integration is exercised in Playwright; here we
// keep coverage focused on the pure handlers + DOM shape so a refactor
// can't silently break the button wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// CSS Module stub so vitest doesn't choke on the import. Class names
// round-trip as themselves which is enough for `toHaveClass`-style
// checks if we ever need them; for the assertions in this file we
// only ever query by data-testid / role.
vi.mock("./VideoToolbar.module.css", () => ({
  default: new Proxy(
    {},
    {
      get: (_t, p: string) => p,
    },
  ),
}));

import {
  VideoToolbar,
  loadFitMode,
  saveFitMode,
  __test,
} from "./VideoToolbar";
import { useSession } from "../state/store";

function setRange(startNs: bigint, endNs: bigint, cursor = startNs) {
  useSession.setState({
    globalRange: { startNs, endNs },
    cursorNs: cursor,
    playing: false,
  });
}

beforeEach(() => {
  // Ensure each test starts with a clean transport state and an empty
  // localStorage (fit-mode persistence keys land there).
  useSession.setState({
    cursorNs: 0n,
    playing: false,
    seekEpoch: 0,
    globalRange: { startNs: 0n, endNs: 10_000_000_000n },
  });
  try {
    localStorage.clear();
  } catch {
    // jsdom always exposes localStorage; defensive.
  }
});

afterEach(() => {
  cleanup();
});

describe("VideoToolbar pure helpers", () => {
  it("expectedFpsFromSidecar derives FPS from median PTS delta", () => {
    // 30 fps ≈ 33_333_333 ns per frame.
    const pts = new BigInt64Array([0n, 33_333_333n, 66_666_666n, 100_000_000n]);
    const fps = __test.expectedFpsFromSidecar(pts);
    expect(fps).toBeGreaterThan(29.5);
    expect(fps).toBeLessThan(30.5);
  });

  it("expectedFpsFromSidecar falls back to 30 when sidecar missing", () => {
    expect(__test.expectedFpsFromSidecar(null)).toBe(30);
    expect(__test.expectedFpsFromSidecar(new BigInt64Array([0n]))).toBe(30);
  });

  it("neighbourPts: step-back from a boundary returns the previous frame", () => {
    const pts = new BigInt64Array([0n, 100n, 200n, 300n]);
    // Cursor sits exactly on frame 2 (200n). Step back = frame 1 (100n).
    expect(__test.neighbourPts(pts, 200n, "back")).toBe(100n);
  });

  it("neighbourPts: step-back from between two frames snaps to the previous boundary", () => {
    const pts = new BigInt64Array([0n, 100n, 200n, 300n]);
    // Cursor between frame 1 (100n) and 2 (200n). Step back should
    // land on frame 1, not frame 0 — single step semantics.
    expect(__test.neighbourPts(pts, 150n, "back")).toBe(100n);
  });

  it("neighbourPts: step-back at frame 0 returns null", () => {
    const pts = new BigInt64Array([0n, 100n, 200n]);
    expect(__test.neighbourPts(pts, 0n, "back")).toBeNull();
  });

  it("neighbourPts: step-forward returns the next frame", () => {
    const pts = new BigInt64Array([0n, 100n, 200n, 300n]);
    expect(__test.neighbourPts(pts, 100n, "forward")).toBe(200n);
    // Between two frames — still snaps to the *next* boundary.
    expect(__test.neighbourPts(pts, 150n, "forward")).toBe(200n);
  });

  it("neighbourPts: step-forward at last frame returns null", () => {
    const pts = new BigInt64Array([0n, 100n, 200n]);
    expect(__test.neighbourPts(pts, 200n, "forward")).toBeNull();
  });

  it("healthTone: bad when fps drops below half the target", () => {
    expect(__test.healthTone(10, false, 30)).toBe("bad");
  });

  it("healthTone: warn when drops occurred even with good fps", () => {
    expect(__test.healthTone(30, true, 30)).toBe("warn");
  });

  it("healthTone: warn when fps below 90% of target", () => {
    expect(__test.healthTone(25, false, 30)).toBe("warn");
  });

  it("healthTone: ok when fps is at target and no drops", () => {
    expect(__test.healthTone(30, false, 30)).toBe("ok");
  });

  it("healthTone: unknown when fps not yet sampled", () => {
    expect(__test.healthTone(null, false, 30)).toBe("unknown");
  });

  it("formatFps: integer at 30+ fps, one decimal below", () => {
    expect(__test.formatFps(30)).toBe("30 fps");
    expect(__test.formatFps(24.3)).toBe("24.3 fps");
    expect(__test.formatFps(null)).toBe("— fps");
  });
});

describe("VideoToolbar — fit/fill persistence", () => {
  it("loadFitMode defaults to 'fit' when nothing persisted", () => {
    expect(loadFitMode("panel-1")).toBe("fit");
  });

  it("saveFitMode round-trips per-panel preference", () => {
    saveFitMode("panel-A", "fill");
    saveFitMode("panel-B", "fit");
    expect(loadFitMode("panel-A")).toBe("fill");
    expect(loadFitMode("panel-B")).toBe("fit");
  });

  it("loadFitMode discards bad persisted values", () => {
    localStorage.setItem("driveline.video.fitMode.x", "garbage");
    expect(loadFitMode("x")).toBe("fit");
  });
});

describe("VideoToolbar component", () => {
  const ptsNs = new BigInt64Array([
    0n,
    33_333_333n,
    66_666_666n,
    100_000_000n,
    133_333_333n,
  ]);

  it("frame-step buttons disable when no sidecar is provided", () => {
    render(
      <VideoToolbar
        panelId="vp"
        ptsNs={null}
        resolution={null}
        fitMode="fit"
        onFitModeChange={() => undefined}
      />,
    );
    const back = screen.getByTestId("video-frame-back") as HTMLButtonElement;
    const fwd = screen.getByTestId("video-frame-forward") as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(fwd.disabled).toBe(true);
    // Tooltip explains *why* — caught in the title attribute.
    expect(back.title).toMatch(/sidecar/i);
  });

  it("frame-step buttons advance the cursor to the neighbour PTS", () => {
    setRange(0n, 1_000_000_000n, 33_333_333n);
    render(
      <VideoToolbar
        panelId="vp"
        ptsNs={ptsNs}
        resolution={null}
        fitMode="fit"
        onFitModeChange={() => undefined}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByTestId("video-frame-forward"));
    });
    expect(useSession.getState().cursorNs).toBe(66_666_666n);
    act(() => {
      fireEvent.click(screen.getByTestId("video-frame-back"));
    });
    // Back from 66_666_666 (boundary) = 33_333_333.
    expect(useSession.getState().cursorNs).toBe(33_333_333n);
  });

  it("scrub buttons add/subtract one second", () => {
    setRange(0n, 10_000_000_000n, 5_000_000_000n);
    render(
      <VideoToolbar
        panelId="vp"
        ptsNs={null}
        resolution={null}
        fitMode="fit"
        onFitModeChange={() => undefined}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByTestId("video-scrub-forward"));
    });
    expect(useSession.getState().cursorNs).toBe(6_000_000_000n);
    act(() => {
      fireEvent.click(screen.getByTestId("video-scrub-back"));
    });
    expect(useSession.getState().cursorNs).toBe(5_000_000_000n);
  });

  it("play-pause toggle flips the store playing flag", () => {
    setRange(0n, 10_000_000_000n);
    render(
      <VideoToolbar
        panelId="vp"
        ptsNs={null}
        resolution={null}
        fitMode="fit"
        onFitModeChange={() => undefined}
      />,
    );
    expect(useSession.getState().playing).toBe(false);
    act(() => {
      fireEvent.click(screen.getByTestId("video-play-pause"));
    });
    expect(useSession.getState().playing).toBe(true);
    act(() => {
      fireEvent.click(screen.getByTestId("video-play-pause"));
    });
    expect(useSession.getState().playing).toBe(false);
  });

  it("fit/fill toggle calls onFitModeChange with the flipped mode", () => {
    const onFitModeChange = vi.fn();
    render(
      <VideoToolbar
        panelId="vp"
        ptsNs={null}
        resolution={null}
        fitMode="fit"
        onFitModeChange={onFitModeChange}
      />,
    );
    const toggle = screen.getByTestId("video-fit-toggle");
    expect(toggle.textContent).toContain("Fit");
    act(() => {
      fireEvent.click(toggle);
    });
    expect(onFitModeChange).toHaveBeenCalledWith("fill");
  });

  it("resolution chip renders dimensions when provided", () => {
    render(
      <VideoToolbar
        panelId="vp"
        ptsNs={null}
        resolution={{ width: 1280, height: 720 }}
        fitMode="fit"
        onFitModeChange={() => undefined}
      />,
    );
    const res = screen.getByTestId("video-resolution");
    expect(res.textContent).toBe("1280×720");
  });

  it("resolution chip hidden until the first frame", () => {
    render(
      <VideoToolbar
        panelId="vp"
        ptsNs={null}
        resolution={null}
        fitMode="fit"
        onFitModeChange={() => undefined}
      />,
    );
    expect(screen.queryByTestId("video-resolution")).toBeNull();
  });

  it("health badge starts in 'unknown' tone before any FPS sample", () => {
    render(
      <VideoToolbar
        panelId="vp"
        ptsNs={null}
        resolution={null}
        fitMode="fit"
        onFitModeChange={() => undefined}
      />,
    );
    const badge = screen.getByTestId("video-health-badge");
    expect(badge.getAttribute("data-tone")).toBe("unknown");
  });
});
