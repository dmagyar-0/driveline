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

  // Iter 4 issue #1 — `healthTone` now takes a richer input that
  // includes the play/pause flag and the time since the most recent
  // seek. Pause beats every other signal so a paused stream NEVER
  // reads bad/warn (the previous behaviour, which read red on
  // FPS=0 mid-pause, is what the designer audit caught).
  const playing = (over: Partial<Parameters<typeof __test.healthTone>[0]>) =>
    __test.healthTone({
      fps: 30,
      droppedRecent: false,
      targetFps: 30,
      playing: true,
      msSinceSeek: 10_000,
      ...over,
    });

  it("healthTone: bad when fps drops below half the target while playing", () => {
    expect(playing({ fps: 10 })).toBe("bad");
  });

  it("healthTone: warn when drops occurred even with good fps", () => {
    expect(playing({ droppedRecent: true })).toBe("warn");
  });

  it("healthTone: warn when fps below 90% of target", () => {
    expect(playing({ fps: 25 })).toBe("warn");
  });

  it("healthTone: ok when fps is at target and no drops", () => {
    expect(playing({})).toBe("ok");
  });

  it("healthTone: unknown when fps not yet sampled", () => {
    expect(playing({ fps: null })).toBe("unknown");
  });

  it("healthTone: paused short-circuits — does NOT turn red on fps=0", () => {
    // The regression the iter3 audit caught: a paused panel reads
    // fps=0 (correct), which used to flip the dot to red ("bad
    // decode"). Pause MUST win over the live-fps thresholds — a
    // paused stream is intentionally idle, not stalled.
    expect(
      __test.healthTone({
        fps: 0,
        droppedRecent: false,
        targetFps: 30,
        playing: false,
        msSinceSeek: 50_000,
      }),
    ).toBe("paused");
  });

  it("healthTone: paused even with null fps and recent drops", () => {
    // Defensive — `playing=false` is the highest-priority short
    // circuit. No combination of FPS/drops/seek-age should override
    // a paused transport.
    expect(
      __test.healthTone({
        fps: null,
        droppedRecent: true,
        targetFps: 30,
        playing: false,
        msSinceSeek: 0,
      }),
    ).toBe("paused");
  });

  it("healthTone: buffering during the post-seek window while playing", () => {
    // A fresh seek (<400 ms ago) reads amber regardless of FPS so
    // the user sees "decoder is catching up" rather than a misleading
    // green/yellow tint based on the pre-seek FPS sample.
    expect(playing({ msSinceSeek: 50 })).toBe("buffering");
  });

  it("formatFps: integer at 30+ fps, one decimal below", () => {
    expect(__test.formatFps(30)).toBe("30 fps");
    expect(__test.formatFps(24.3)).toBe("24.3 fps");
    expect(__test.formatFps(null)).toBe("— fps");
  });

  it("formatFps: reads 'paused' when transport is paused (iter4 #1)", () => {
    // The chip text itself replaces the "0.0 fps" string with
    // "paused" so the user has *two* cues that the idle state is
    // intentional (chip text + neutral dot), not just the colour.
    expect(__test.formatFps(0, false)).toBe("paused");
    expect(__test.formatFps(null, false)).toBe("paused");
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

  it("FIT/FILL segmented control: both options visible, active one is aria-pressed", () => {
    // Iter 4 issue #2 — the single-button toggle was replaced with a
    // 2-state segmented control. Both segments are always in the DOM
    // so the user can read the current mode without clicking. The
    // active segment carries `aria-pressed=true`; the inactive one
    // carries `aria-pressed=false` (per the WAI-ARIA toolbar pattern
    // for binary segmented controls).
    const onFitModeChange = vi.fn();
    const { rerender } = render(
      <VideoToolbar
        panelId="vp"
        ptsNs={null}
        resolution={null}
        fitMode="fit"
        onFitModeChange={onFitModeChange}
      />,
    );
    const fitSeg = screen.getByTestId("video-fit-segment-fit");
    const fillSeg = screen.getByTestId("video-fit-segment-fill");
    expect(fitSeg.getAttribute("aria-pressed")).toBe("true");
    expect(fillSeg.getAttribute("aria-pressed")).toBe("false");
    // Clicking the *active* segment is a no-op (it's already selected)
    // — this avoids a re-render storm when a user mashes the same
    // segment they're on.
    act(() => {
      fireEvent.click(fitSeg);
    });
    expect(onFitModeChange).not.toHaveBeenCalled();
    // Clicking the inactive segment flips to that mode.
    act(() => {
      fireEvent.click(fillSeg);
    });
    expect(onFitModeChange).toHaveBeenCalledWith("fill");
    // Re-render with the new mode and check `aria-pressed` follows.
    rerender(
      <VideoToolbar
        panelId="vp"
        ptsNs={null}
        resolution={null}
        fitMode="fill"
        onFitModeChange={onFitModeChange}
      />,
    );
    expect(screen.getByTestId("video-fit-segment-fit").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByTestId("video-fit-segment-fill").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("resolution renders inline inside the health badge when provided", () => {
    // Iter 4 issue #6 — the three previously-equal chips (codec, fps,
    // resolution) collapse into the health badge as subordinate
    // text. The badge's textContent therefore carries the dimensions
    // rather than a separate `video-resolution` testid.
    render(
      <VideoToolbar
        panelId="vp"
        ptsNs={null}
        resolution={{ width: 1280, height: 720 }}
        fitMode="fit"
        onFitModeChange={() => undefined}
      />,
    );
    const badge = screen.getByTestId("video-health-badge");
    expect(badge.textContent ?? "").toContain("1280×720");
  });

  it("resolution dimensions absent from the badge before the first frame", () => {
    // The dimensions only render once a real frame has been decoded.
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
    expect(badge.textContent ?? "").not.toMatch(/\d+×\d+/);
  });

  it("health badge starts in 'paused' tone before any FPS sample on a paused transport", () => {
    // Iter 4 issue #1 — the initial state is paused (the store's
    // `beforeEach` sets `playing: false`), so the badge must report
    // "paused" and NOT "unknown" / "bad". This is the entire point of
    // decoupling tone from FPS.
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
    expect(badge.getAttribute("data-tone")).toBe("paused");
    expect(badge.textContent ?? "").toContain("paused");
  });

  it("frame-step buttons advertise their keyboard shortcut in the tooltip", () => {
    // Iter 4 issue #3 — `,` / `.` are the frame-step bindings. The
    // tooltip must surface them so users discover the shortcut
    // without opening the help overlay. `aria-keyshortcuts` mirrors
    // the binding for AT users.
    render(
      <VideoToolbar
        panelId="vp"
        ptsNs={ptsNs}
        resolution={null}
        fitMode="fit"
        onFitModeChange={() => undefined}
      />,
    );
    const back = screen.getByTestId("video-frame-back");
    const fwd = screen.getByTestId("video-frame-forward");
    expect(back.title).toContain(",");
    expect(fwd.title).toContain(".");
    expect(back.getAttribute("aria-keyshortcuts")).toBe(",");
    expect(fwd.getAttribute("aria-keyshortcuts")).toBe(".");
  });

  it("keyboard ',' / '.' step frames when a sidecar is bound", () => {
    // Iter 4 issue #3 — exercise the window-level keydown binding so
    // a refactor that disconnects the listener regresses loudly. We
    // dispatch on `window` (the toolbar's effect attaches there) and
    // assert the store cursor moved one PTS in each direction.
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
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "." }));
    });
    expect(useSession.getState().cursorNs).toBe(66_666_666n);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "," }));
    });
    expect(useSession.getState().cursorNs).toBe(33_333_333n);
  });

  it("keyboard frame-step bindings are inert when no sidecar is present", () => {
    // No ptsNs ⇒ no listener attached at all, so the cursor must be
    // untouched by the keys (the global Transport handler doesn't
    // bind `,` / `.`, so this is a real "no-op" check, not a
    // delegation).
    setRange(0n, 1_000_000_000n, 500_000_000n);
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
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "." }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "," }));
    });
    expect(useSession.getState().cursorNs).toBe(500_000_000n);
  });
});
