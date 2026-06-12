// Unit coverage for the `window.__drivelineAgent` surface: install
// gating, BigInt-as-string serialisation, event CRUD with agent
// provenance, export/import round-trip, and frame capture against the
// canvas registry. The worker-backed `fetchChannelRange` happy path is
// covered by the e2e spec (apps/e2e/tests/agentApi.spec.ts); here we
// assert the no-worker guard rails only.

// @vitest-environment jsdom
//
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentApiRequested,
  installAgentApi,
  AGENT_API_VERSION,
} from "./agentApi";
import { useSession } from "../state/store";
import {
  setVideoCanvas,
  clearVideoCanvas,
} from "../panels/videoCanvasRegistry";

let uninstall: (() => void) | null = null;

beforeEach(async () => {
  await useSession.getState().clear();
  for (const b of [...useSession.getState().bookmarks]) {
    useSession.getState().removeBookmark(b.id);
  }
  uninstall = installAgentApi();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

function api() {
  const a = window.__drivelineAgent;
  if (!a) throw new Error("agent api not installed");
  return a;
}

describe("install gating", () => {
  it("agentApiRequested keys on the ?agent query param", () => {
    expect(agentApiRequested("?agent")).toBe(true);
    expect(agentApiRequested("?agent=1&demo")).toBe(true);
    expect(agentApiRequested("?demo")).toBe(false);
    expect(agentApiRequested("")).toBe(false);
  });

  it("install exposes the api; the uninstaller removes it", () => {
    expect(api().version).toBe(AGENT_API_VERSION);
    uninstall?.();
    uninstall = null;
    expect(window.__drivelineAgent).toBeUndefined();
  });
});

describe("session snapshot + transport", () => {
  // Real seeking needs a loaded session (`setCursor` clamps against
  // `globalRange` and no-ops without one) — the e2e spec covers it.
  it("snapshot is JSON-safe: ns as strings, no bigints", () => {
    const snap = api().getSessionSnapshot();
    expect(typeof snap.cursorNs).toBe("string");
    expect(typeof snap.playing).toBe("boolean");
    expect(typeof snap.speed).toBe("number");
    expect(snap.globalRange).toBeNull();
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  it("setCursor is a safe no-op without a session or with bad input", () => {
    expect(() => api().setCursor("42")).not.toThrow();
    expect(() => api().setCursor("not-a-number")).not.toThrow();
    expect(useSession.getState().cursorNs).toBe(0n);
  });
});

describe("events", () => {
  it("addEvent stamps agent origin, tags, range and clamped confidence", () => {
    const id = api().addEvent({
      ns: "5000000000",
      label: "cut-in ahead",
      beforeNs: "1000000000",
      afterNs: "2000000000",
      tags: { maneuver: "Lane change", weather: "Clear" },
      confidence: 0.85,
    });
    expect(id).not.toBeNull();
    const events = api().listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id,
      ns: "5000000000",
      beforeNs: "1000000000",
      afterNs: "2000000000",
      label: "cut-in ahead",
      origin: "agent",
      confidence: 0.85,
      tags: { maneuver: "Lane change", weather: "Clear" },
    });
  });

  it("addEvent without ns needs a loaded session (globalRange)", () => {
    expect(api().addEvent({ label: "floating" })).toBeNull();
    expect(api().listEvents()).toHaveLength(0);
  });

  it("setEventTag / setEventRange / renameEvent / removeEvent round-trip", () => {
    const id = api().addEvent({ ns: "10", label: "x" });
    if (id === null) throw new Error("addEvent failed");
    api().setEventTag(id, "weather", "Fog");
    api().setEventRange(id, "3", "4");
    api().renameEvent(id, "renamed");
    let e = api().listEvents()[0];
    expect(e.tags.weather).toBe("Fog");
    expect(e.beforeNs).toBe("3");
    expect(e.afterNs).toBe("4");
    expect(e.label).toBe("renamed");
    api().setEventTag(id, "weather", "");
    e = api().listEvents()[0];
    expect("weather" in e.tags).toBe(false);
    api().removeEvent(id);
    expect(api().listEvents()).toHaveLength(0);
  });

  it("exportEvents → importEvents(replace) round-trips losslessly", () => {
    api().addEvent({ ns: "7", label: "a", confidence: 0.4 });
    api().addEvent({ ns: "8", label: "b", tags: { road_type: "Highway" } });
    const exported = api().exportEvents();
    const before = api().listEvents();
    api().removeEvent(before[0].id);
    api().removeEvent(before[1].id);
    expect(api().listEvents()).toHaveLength(0);
    const result = api().importEvents(exported, "replace");
    expect(result).toEqual({ added: 2, updated: 0 });
    expect(api().listEvents()).toEqual(before);
  });

  it("importEvents defaults to merge and rejects malformed JSON", () => {
    const id = api().addEvent({ ns: "1", label: "keep" });
    expect(api().importEvents("not json {")).toBeNull();
    const result = api().importEvents(
      JSON.stringify([{ ns: "2", label: "new", origin: "agent" }]),
    );
    expect(result).toEqual({ added: 1, updated: 0 });
    expect(
      api()
        .listEvents()
        .map((e) => e.id),
    ).toContain(id);
    expect(api().listEvents()).toHaveLength(2);
  });
});

describe("data access guard rails", () => {
  it("fetchChannelRange resolves null for an unknown channel", async () => {
    await expect(
      api().fetchChannelRange("nope", "0", "10"),
    ).resolves.toBeNull();
  });

  it("fetchChannelRange resolves null for unparseable ns bounds", async () => {
    await expect(
      api().fetchChannelRange("any", "abc", "10"),
    ).resolves.toBeNull();
  });
});

describe("captureVideoFrame", () => {
  it("returns null when no video panel is registered", () => {
    expect(api().listVideoPanels()).toEqual([]);
    expect(api().captureVideoFrame()).toBeNull();
  });

  it("captures the registered canvas as a PNG data URL", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 3;
    // jsdom has no real raster backend — stub the encoder; the agent
    // contract is "PNG data URL of the registered canvas".
    canvas.toDataURL = () => "data:image/png;base64,stub";
    setVideoCanvas("video-test", canvas);
    try {
      expect(api().listVideoPanels()).toEqual(["video-test"]);
      const shot = api().captureVideoFrame();
      expect(shot).toEqual({
        panelId: "video-test",
        dataUrl: "data:image/png;base64,stub",
        width: 4,
        height: 3,
      });
      expect(api().captureVideoFrame("missing-panel")).toBeNull();
    } finally {
      clearVideoCanvas("video-test");
    }
  });
});
