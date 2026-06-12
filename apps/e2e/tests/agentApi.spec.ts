// Agent interface (`window.__drivelineAgent`) e2e.
//
// Drives the surface exactly like an automation agent would: install
// check, channel discovery, a worker-backed ranged fetch (ts arrives as
// decimal-string ns), transport seek, event creation with tags +
// provenance, and the export → import round-trip. The UI side is
// asserted through the Events drawer (agent badge on the row) so the
// surface and the human review path are tested against each other.
//
// The API installs unconditionally in DEV (the dev server Playwright
// targets); the `?agent` opt-in gate has unit coverage in
// `apps/web/src/agent/agentApi.test.ts`.

import { test, expect, type Page } from "@playwright/test";
import type { AgentApi } from "../../web/src/agent/agentApi";

declare global {
  interface Window {
    __drivelineAgent?: AgentApi;
    __drivelineDevHooks?: {
      openFiles: (
        descs: { name: string; bytes: Uint8Array }[],
      ) => Promise<{
        opened: string[];
        errors: { name: string; reason: string }[];
      }>;
      clearSession: () => Promise<void>;
      resetLayout: () => void;
      setActiveRailTab: (tab: string | null) => void;
    };
  }
}

async function loadMf4(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const r = await fetch(`/sample-data/short.mf4`);
    if (!r.ok) throw new Error(`fetch short.mf4: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    return await window.__drivelineDevHooks!.openFiles([
      { name: "short.mf4", bytes },
    ]);
  });
  expect(result.errors).toEqual([]);
}

test.describe("agent interface", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?agent=1");
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );
    await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      for (const e of agent.listEvents()) agent.removeEvent(e.id);
    });
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      const agent = window.__drivelineAgent!;
      for (const e of agent.listEvents()) agent.removeEvent(e.id);
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("installs with version 1 and a JSON-safe empty snapshot", async ({
    page,
  }) => {
    const probe = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      return {
        version: agent.version,
        snapshot: agent.getSessionSnapshot(),
        sources: agent.listSources(),
      };
    });
    expect(probe.version).toBe(1);
    expect(probe.snapshot.globalRange).toBeNull();
    expect(typeof probe.snapshot.cursorNs).toBe("string");
    expect(probe.sources).toEqual([]);
  });

  test("discovers channels and fetches a range with string-ns timestamps", async ({
    page,
  }) => {
    await loadMf4(page);
    const fetched = await page.evaluate(async () => {
      const agent = window.__drivelineAgent!;
      const channels = agent.listChannels();
      const scalar = channels.find((c) => c.kind === "scalar");
      if (!scalar) throw new Error("no scalar channel in short.mf4");
      const range = agent.getSessionSnapshot().globalRange!;
      const data = await agent.fetchChannelRange(
        scalar.id,
        range.startNs,
        // end is exclusive; +1 keeps the final sample in the window.
        (BigInt(range.endNs) + 1n).toString(),
      );
      return { channelCount: channels.length, scalarId: scalar.id, data };
    });
    expect(fetched.channelCount).toBeGreaterThan(0);
    expect(fetched.data).not.toBeNull();
    expect(fetched.data!.rows).toBeGreaterThan(0);
    const ts = fetched.data!.columns.find((c) => c.name === "ts");
    expect(ts).toBeDefined();
    expect(typeof ts!.values[0]).toBe("string");
    expect(/^\d+$/.test(ts!.values[0] as string)).toBe(true);
  });

  test("seeks via setCursor and reads it back from the snapshot", async ({
    page,
  }) => {
    await loadMf4(page);
    const cursor = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      const range = agent.getSessionSnapshot().globalRange!;
      const mid = (
        (BigInt(range.startNs) + BigInt(range.endNs)) /
        2n
      ).toString();
      agent.pause();
      agent.setCursor(mid);
      return { want: mid, got: agent.getSessionSnapshot().cursorNs };
    });
    expect(cursor.got).toBe(cursor.want);
  });

  test("addEvent lands in the drawer with the agent badge; export → import round-trips", async ({
    page,
  }) => {
    await loadMf4(page);
    const made = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      const range = agent.getSessionSnapshot().globalRange!;
      const id = agent.addEvent({
        ns: range.startNs,
        label: "agent finding",
        tags: { weather: "Clear", road_type: "Highway" },
        confidence: 0.9,
      });
      return { id, events: agent.listEvents() };
    });
    expect(made.id).not.toBeNull();
    expect(made.events).toHaveLength(1);
    expect(made.events[0].origin).toBe("agent");

    // Human review path: the drawer row carries the provenance badge.
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("events"),
    );
    await expect(page.getByTestId(`bookmark-row-${made.id}`)).toBeVisible();
    await expect(
      page.getByTestId(`bookmark-origin-${made.id}`),
    ).toHaveText("agent 90%");

    // Export, wipe, re-import — the finding survives the round-trip.
    const roundTrip = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      const json = agent.exportEvents();
      for (const e of agent.listEvents()) agent.removeEvent(e.id);
      const result = agent.importEvents(json, "replace");
      return { result, events: agent.listEvents() };
    });
    expect(roundTrip.result).toEqual({ added: 1, updated: 0 });
    expect(roundTrip.events[0].label).toBe("agent finding");
    expect(roundTrip.events[0].tags).toEqual({
      weather: "Clear",
      road_type: "Highway",
    });
    await expect(page.getByTestId(`bookmark-row-${made.id}`)).toBeVisible();
  });
});
