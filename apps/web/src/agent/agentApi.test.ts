// Unit coverage for the `window.__drivelineAgent` surface: install
// gating, BigInt-as-string serialisation, event CRUD with agent
// provenance, export/import round-trip, frame capture against the canvas
// registry, and the v2 layout write ops (create/bind/close, validated
// against channel existence + the MAX_PLOT_SERIES cap). The worker-backed
// `fetchChannelRange` happy path is covered by the e2e spec
// (apps/e2e/tests/agentApi.spec.ts); here we assert the no-worker guard
// rails only. The layout ops stand in a fake workspace bridge for the
// FlexLayout model (the real one mounts in `Workspace.tsx`); the live
// FlexLayout path is exercised in apps/e2e/tests/agentLayoutOps.spec.ts.

// @vitest-environment jsdom
//
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentApiRequested,
  installAgentApi,
  AGENT_API_VERSION,
} from "./agentApi";
import { useSession } from "../state/store";
import type { Channel } from "../state/store";
import {
  setVideoCanvas,
  clearVideoCanvas,
} from "../panels/videoCanvasRegistry";
import {
  setWorkspaceBridge,
  type WorkspaceBridge,
} from "../layout/workspaceBridge";
import type { PanelKind } from "../layout/panelId";

let uninstall: (() => void) | null = null;

beforeEach(async () => {
  await useSession.getState().clear();
  // `clear()` only resets session state when a worker is attached; these unit
  // tests run without one, so reset the session slice directly (the inline
  // ingestion tests load real sources, which would otherwise leak forward).
  useSession.setState({
    sources: [],
    channels: [],
    globalRange: null,
    cursorNs: 0n,
  });
  for (const b of [...useSession.getState().bookmarks]) {
    useSession.getState().removeBookmark(b.id);
  }
  uninstall = installAgentApi(true);
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

// ── layout test harness ───────────────────────────────────────────
// A fake workspace bridge that mints `${kind}-N` ids and keeps the store's
// `layoutJson` in lockstep (real `createPanel`/`closePanel` push
// `model.toJson()` into the store), so `bindChannels`/`setMapBinding`'s
// "panel exists" check sees what the bridge created.

function seedChannels(ids: string[]): void {
  const channels: Channel[] = ids.map((id) => ({
    id,
    nativeId: id,
    sourceId: "src",
    name: id,
    kind: "scalar",
    dtype: "f64",
    unit: null,
    sampleCount: 1,
    timeRange: { startNs: 0n, endNs: 1n },
  }));
  useSession.setState({ channels });
}

function layoutTabIds(): string[] {
  const root = (useSession.getState().layoutJson as { layout?: unknown } | null)
    ?.layout;
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as { type?: unknown; id?: unknown; children?: unknown };
    if (obj.type === "tab" && typeof obj.id === "string") out.push(obj.id);
    if (Array.isArray(obj.children)) obj.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** Push a `${kind}-N` tab into a minimal FlexLayout JSON snapshot. */
function addTabToLayout(id: string): void {
  const prev = useSession.getState().layoutJson as {
    layout?: { children?: unknown[] };
  } | null;
  const children = Array.isArray(prev?.layout?.children)
    ? [...prev!.layout!.children]
    : [];
  children.push({
    type: "tabset",
    children: [{ type: "tab", id, name: id }],
  });
  useSession.getState().setLayoutJson({ layout: { type: "row", children } });
}

function removeTabFromLayout(id: string): boolean {
  if (!layoutTabIds().includes(id)) return false;
  const prev = useSession.getState().layoutJson as {
    layout?: { children?: unknown[] };
  } | null;
  const children = (prev?.layout?.children ?? []).filter((c) => {
    const set = c as { children?: { id?: unknown }[] };
    return !(set.children ?? []).some((t) => t.id === id);
  });
  useSession.getState().setLayoutJson({ layout: { type: "row", children } });
  return true;
}

function installFakeBridge(): { detach: () => void; minted: string[] } {
  const minted: string[] = [];
  const counters: Record<string, number> = {};
  const bridge: WorkspaceBridge = {
    createPanel(kind: PanelKind) {
      const n = (counters[kind] = (counters[kind] ?? 0) + 1);
      const id = `${kind}-${n}`;
      addTabToLayout(id);
      minted.push(id);
      return id;
    },
    closePanel(panelId: string) {
      return removeTabFromLayout(panelId);
    },
    resetLayout() {
      useSession.getState().setLayoutJson(null);
    },
  };
  return { detach: setWorkspaceBridge(bridge), minted };
}

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
    expect(AGENT_API_VERSION).toBe(3);
    uninstall?.();
    uninstall = null;
    expect(window.__drivelineAgent).toBeUndefined();
  });

  it("read-only install (no ?agent) exposes only the discovery trio", () => {
    // Re-install in the no-?agent mode: discovery is always on, but the
    // mutating surface (addDataSource, fetchChannelRange, …) is absent.
    uninstall?.();
    uninstall = installAgentApi(false);
    const a = api();
    expect(a.version).toBe(AGENT_API_VERSION);
    expect(typeof a.getSkill()).toBe("string");
    expect(a.getSkill().length).toBeGreaterThan(0);
    const manifest = a.describe();
    expect(manifest.version).toBe(AGENT_API_VERSION);
    expect(manifest.agentParamRequired).toBe(true);
    // The gated ops are not installed on the read-only surface.
    expect(
      (a as unknown as { addDataSource?: unknown }).addDataSource,
    ).toBeUndefined();
    expect(
      (a as unknown as { fetchChannelRange?: unknown }).fetchChannelRange,
    ).toBeUndefined();
  });
});

describe("discovery (getSkill / describe)", () => {
  it("getSkill returns the BYOA guide with the spec + worked example", () => {
    const skill = api().getSkill();
    expect(skill).toContain("AgentDataSourceSpec");
    expect(skill).toContain("addDataSource");
    expect(skill).toContain("?agent");
    // The BigInt rule and a concrete worked example must be present.
    expect(skill).toContain("DECIMAL STRING");
    expect(skill).toContain("vehicle/speed");
  });

  it("describe lists every method with mutating flags", () => {
    const m = api().describe();
    const byName = new Map(m.capabilities.map((c) => [c.name, c]));
    expect(byName.get("getSkill")?.mutating).toBe(false);
    expect(byName.get("describe")?.mutating).toBe(false);
    expect(byName.get("addDataSource")?.mutating).toBe(true);
    // `mutating` is the semantic flag, not the gating signal: read-only ops
    // (still `?agent`-gated) report false so an agent can reason about safety.
    expect(byName.get("fetchChannelRange")?.mutating).toBe(false);
    expect(byName.get("listChannels")?.mutating).toBe(false);
    expect(byName.get("createPanel")?.mutating).toBe(true);
    // The full surface is the gated set + the discovery trio.
    expect(m.capabilities.length).toBeGreaterThan(10);
  });
});

describe("addDataSource (inline ingestion)", () => {
  const N = 50;
  function sineSpec() {
    const startNs = 1_700_000_000_000_000_000n;
    const stepNs = 20_000_000n;
    const timestampsNs: string[] = [];
    const values: number[] = [];
    for (let i = 0; i < N; i++) {
      timestampsNs.push((startNs + stepNs * BigInt(i)).toString());
      values.push(Math.sin(i / 5));
    }
    return {
      name: "agent-run",
      channels: [
        { name: "vehicle/speed", unit: "m/s", timestampsNs, values },
        {
          name: "vehicle/gear",
          kind: "enum" as const,
          timestampsNs,
          values: values.map((_, i) => (i % 4) + 1),
        },
      ],
    };
  }

  it("registers channels that appear in listChannels and widen the range", () => {
    const res = api().addDataSource(sineSpec());
    expect(res).not.toBeNull();
    expect(res!.channels).toHaveLength(2);
    const names = api()
      .listChannels()
      .map((c) => c.name);
    expect(names).toContain("/vehicle/speed");
    expect(names).toContain("/vehicle/gear");
    const snap = api().getSessionSnapshot();
    expect(snap.globalRange).not.toBeNull();
    expect(snap.globalRange!.startNs).toBe("1700000000000000000");
  });

  it("the pushed channel is fetchable and decodes to the right samples", async () => {
    const res = api().addDataSource(sineSpec());
    const speedId = res!.channels.find((c) => c.name === "/vehicle/speed")!.id;
    const range = await api().fetchChannelRange(
      speedId,
      "1700000000000000000",
      "1700000001000000000",
    );
    expect(range).not.toBeNull();
    expect(range!.rows).toBeGreaterThan(0);
    const tsCol = range!.columns.find((c) => c.name === "ts")!;
    const valCol = range!.columns.find((c) => c.name === "value")!;
    // ts arrives as decimal strings; value as numbers.
    expect(typeof tsCol.values[0]).toBe("string");
    expect(tsCol.values[0]).toBe("1700000000000000000");
    expect(typeof valCol.values[0]).toBe("number");
  });

  it("returns null on invalid specs (never throws)", () => {
    const bad: unknown[] = [
      { name: "", channels: [] },
      { name: "x", channels: [] },
      {
        name: "x",
        channels: [{ name: "a", timestampsNs: ["1", "2"], values: [1] }],
      },
      {
        name: "x",
        channels: [{ name: "a", timestampsNs: ["2", "1"], values: [1, 2] }],
      },
      {
        name: "x",
        channels: [{ name: "a", timestampsNs: ["nope"], values: [1] }],
      },
    ];
    for (const spec of bad) {
      const add = api().addDataSource as (s: unknown) => unknown;
      expect(add(spec)).toBeNull();
    }
    // None of the bad specs leaked a channel into the session.
    expect(api().listChannels()).toHaveLength(0);
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

describe("layout write ops (v2)", () => {
  let detach: (() => void) | null = null;

  afterEach(() => {
    detach?.();
    detach = null;
    // Reset everything these tests touch: panel ids restart at `${kind}-1`
    // on each fake-bridge install, so leftover bindings under a reused id
    // would leak between tests.
    useSession.setState({
      layoutJson: null,
      channels: [],
      plotBindings: {},
      enumBindings: {},
      tableBindings: {},
      valueBindings: {},
      mapBindings: {},
    });
  });

  describe("createPanel", () => {
    it("mints a panel of the given kind and returns its id", () => {
      detach = installFakeBridge().detach;
      const id = api().createPanel("plot");
      expect(id).toBe("plot-1");
      expect(layoutTabIds()).toContain("plot-1");
    });

    it("returns null for an unknown panel kind", () => {
      detach = installFakeBridge().detach;
      // Cast through unknown: the typed API rejects this at compile time,
      // but an external/JS caller can still hand over a bogus string.
      const id = api().createPanel("bogus" as unknown as PanelKind);
      expect(id).toBeNull();
      expect(layoutTabIds()).toEqual([]);
    });

    it("returns null when no workspace bridge is mounted", () => {
      // No installFakeBridge() — the Workspace hasn't mounted.
      expect(api().createPanel("plot")).toBeNull();
    });
  });

  describe("bindChannels", () => {
    beforeEach(() => {
      detach = installFakeBridge().detach;
      seedChannels(["/a", "/b", "/c"]);
    });

    it("binds known channels to a plot panel", () => {
      const id = api().createPanel("plot")!;
      expect(api().bindChannels(id, ["/a", "/b"])).toBe(true);
      expect(useSession.getState().plotBindings[id]).toEqual(["/a", "/b"]);
    });

    it("binds to enum / table / value panels too", () => {
      const enumId = api().createPanel("enum")!;
      const tableId = api().createPanel("table")!;
      const valueId = api().createPanel("value")!;
      expect(api().bindChannels(enumId, ["/a"])).toBe(true);
      expect(api().bindChannels(tableId, ["/b"])).toBe(true);
      expect(api().bindChannels(valueId, ["/c"])).toBe(true);
      const st = useSession.getState();
      expect(st.enumBindings[enumId]).toEqual(["/a"]);
      expect(st.tableBindings[tableId]).toEqual(["/b"]);
      expect(st.valueBindings[valueId]).toEqual(["/c"]);
    });

    it("returns false (binding nothing) when any channel is unknown", () => {
      const id = api().createPanel("plot")!;
      expect(api().bindChannels(id, ["/a", "/missing"])).toBe(false);
      expect(useSession.getState().plotBindings[id] ?? []).toEqual([]);
    });

    it("returns false for an unknown panel id", () => {
      expect(api().bindChannels("plot-999", ["/a"])).toBe(false);
    });

    it("returns false for a non-bindable kind (map / video / scene)", () => {
      const mapId = api().createPanel("map")!;
      expect(api().bindChannels(mapId, ["/a"])).toBe(false);
    });

    it("rejects a request that would exceed MAX_PLOT_SERIES", () => {
      const ids = Array.from({ length: 20 }, (_, i) => `/s${i}`);
      seedChannels(ids);
      const id = api().createPanel("plot")!;
      // One over the cap → reject the whole request, bind nothing.
      const over = ids.slice(0, 17);
      expect(over.length).toBeGreaterThan(16);
      expect(api().bindChannels(id, over)).toBe(false);
      expect(useSession.getState().plotBindings[id] ?? []).toEqual([]);
      // Exactly at the cap → accepted.
      const exactly = ids.slice(0, 16);
      expect(api().bindChannels(id, exactly)).toBe(true);
      expect(useSession.getState().plotBindings[id]).toHaveLength(16);
    });

    it("counts only new ids against the cap (re-bind is a no-op)", () => {
      const ids = Array.from({ length: 16 }, (_, i) => `/s${i}`);
      seedChannels(ids);
      const id = api().createPanel("plot")!;
      expect(api().bindChannels(id, ids)).toBe(true);
      // Re-binding the same set must not trip the cap.
      expect(api().bindChannels(id, ids.slice(0, 4))).toBe(true);
      expect(useSession.getState().plotBindings[id]).toHaveLength(16);
    });
  });

  describe("setMapBinding", () => {
    beforeEach(() => {
      detach = installFakeBridge().detach;
      seedChannels(["/lat", "/lon"]);
    });

    it("sets a map panel's lat/lon binding", () => {
      const id = api().createPanel("map")!;
      expect(api().setMapBinding(id, "/lat", "/lon")).toBe(true);
      expect(useSession.getState().mapBindings[id]).toEqual({
        latChannelId: "/lat",
        lonChannelId: "/lon",
      });
    });

    it("returns false when the panel is not a map", () => {
      const id = api().createPanel("plot")!;
      expect(api().setMapBinding(id, "/lat", "/lon")).toBe(false);
    });

    it("returns false when a channel is unknown", () => {
      const id = api().createPanel("map")!;
      expect(api().setMapBinding(id, "/lat", "/missing")).toBe(false);
      expect(useSession.getState().mapBindings[id] ?? null).toBeNull();
    });

    it("returns false for an unknown panel id", () => {
      expect(api().setMapBinding("map-999", "/lat", "/lon")).toBe(false);
    });
  });

  describe("closePanel", () => {
    it("deletes an existing panel and returns true", () => {
      detach = installFakeBridge().detach;
      const id = api().createPanel("plot")!;
      expect(layoutTabIds()).toContain(id);
      expect(api().closePanel(id)).toBe(true);
      expect(layoutTabIds()).not.toContain(id);
    });

    it("returns false for an unknown panel id", () => {
      detach = installFakeBridge().detach;
      expect(api().closePanel("plot-999")).toBe(false);
    });

    it("returns false when no workspace bridge is mounted", () => {
      expect(api().closePanel("plot-1")).toBe(false);
    });
  });
});
