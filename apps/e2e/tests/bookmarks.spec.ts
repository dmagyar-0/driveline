// Phase 8 · Events drawer (bookmarks) e2e.
//
// Exercises the new drawer + transport overlay end-to-end:
//   1. Add at cursor: row appears, transport marker appears, both are
//      driven by a single store action.
//   2. Click a row to seek (asserted via `getSessionSnapshot`).
//   3. Rename round-trip (double-click → type → Enter → reload still
//      shows the new label — `localStorage` adapter is wired).
//   4. × removes both the row and the transport marker.
//   5. Reload survives — the persistence adapter round-trips `ns` as
//      a decimal string.
//
// Selection is via the drawer's testids and the marker's
// `bookmark-marker-<id>` attribute. State assertions go through
// `__drivelineDevHooks` per the frontend skill's "hook over selector"
// rule.

import { test, expect, type Page } from "@playwright/test";

interface Snapshot {
  cursorNs: string;
  globalRange: { startNs: string; endNs: string } | null;
}

interface BookmarkRow {
  id: string;
  ns: string;
  label: string;
  color: string;
  createdAt: number;
}

declare global {
  interface Window {
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
      getSessionSnapshot: () => Snapshot;
      addBookmarkAtCursor: (label?: string) => string | null;
      listBookmarks: () => BookmarkRow[];
      removeBookmark: (id: string) => void;
      renameBookmark: (id: string, label: string) => void;
    };
  }
}

async function snapshot(page: Page): Promise<Snapshot> {
  return await page.evaluate(() =>
    window.__drivelineDevHooks!.getSessionSnapshot(),
  );
}

async function listBookmarks(page: Page): Promise<BookmarkRow[]> {
  return await page.evaluate(() => window.__drivelineDevHooks!.listBookmarks());
}

async function loadMcap(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const r = await fetch(`/sample-data/short.mcap`);
    if (!r.ok) throw new Error(`fetch short.mcap: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    return await window.__drivelineDevHooks!.openFiles([
      { name: "short.mcap", bytes },
    ]);
  });
  expect(result.errors).toEqual([]);
}

test.describe("Events drawer / bookmarks (Phase 8)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    // Wipe any stray bookmarks left over from a previous test run.
    await page.evaluate(() => {
      const hooks = window.__drivelineDevHooks!;
      for (const b of hooks.listBookmarks()) hooks.removeBookmark(b.id);
    });
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      const hooks = window.__drivelineDevHooks!;
      for (const b of hooks.listBookmarks()) hooks.removeBookmark(b.id);
      await hooks.clearSession();
    });
  });

  test("add button is disabled when no fixture is loaded", async ({ page }) => {
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("events"),
    );
    const btn = page.getByTestId("bookmark-add-btn");
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
  });

  test("add at cursor → drawer row + transport marker both appear", async ({
    page,
  }) => {
    await loadMcap(page);
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("events"),
    );

    // Cursor is parked at globalRange.startNs after the first drop.
    await page.getByTestId("bookmark-add-btn").click();
    const bms = await listBookmarks(page);
    expect(bms).toHaveLength(1);
    const id = bms[0].id;

    // Row in drawer.
    await expect(page.getByTestId(`bookmark-row-${id}`)).toBeVisible();
    await expect(page.getByTestId("bookmarks-count-pill")).toHaveText("1");

    // Marker on transport.
    await expect(page.getByTestId(`bookmark-marker-${id}`)).toBeVisible();
  });

  test("click drawer row seeks the cursor", async ({ page }) => {
    await loadMcap(page);
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("events"),
    );

    // Drop a bookmark, then move the cursor; clicking the row should
    // bring the cursor back.
    const bookmarkNs = await page.evaluate(() => {
      const snap = window.__drivelineDevHooks!.getSessionSnapshot();
      return snap.cursorNs;
    });
    const id = await page.evaluate(() =>
      window.__drivelineDevHooks!.addBookmarkAtCursor("anchor"),
    );
    expect(id).not.toBeNull();

    // Move the cursor away to a different time inside globalRange.
    await page.evaluate(() => {
      const snap = window.__drivelineDevHooks!.getSessionSnapshot();
      const start = BigInt(snap.globalRange!.startNs);
      const end = BigInt(snap.globalRange!.endNs);
      const mid = start + (end - start) / 2n;
      // Use the scrubber slider via aria for portability — but the
      // simplest seam is just a setCursor through… we don't expose
      // setCursor as a dev hook; use the keyboard "End" shortcut to
      // jump to globalRange.endNs.
      void mid;
    });
    await page.keyboard.press("End");
    const afterEnd = await snapshot(page);
    expect(afterEnd.cursorNs).not.toBe(bookmarkNs);

    // Click the bookmark seek button — cursor returns to the bookmark.
    await page.getByTestId(`bookmark-seek-${id}`).click();
    const afterSeek = await snapshot(page);
    expect(afterSeek.cursorNs).toBe(bookmarkNs);
  });

  test("click transport marker also seeks", async ({ page }) => {
    await loadMcap(page);
    const id = await page.evaluate(() =>
      window.__drivelineDevHooks!.addBookmarkAtCursor("via-marker"),
    );
    expect(id).not.toBeNull();
    const before = await snapshot(page);
    await page.keyboard.press("End");
    expect((await snapshot(page)).cursorNs).not.toBe(before.cursorNs);

    await page.getByTestId(`bookmark-marker-${id}`).click();
    expect((await snapshot(page)).cursorNs).toBe(before.cursorNs);
  });

  test("rename round-trips and survives reload", async ({ page }) => {
    await loadMcap(page);
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("events"),
    );

    const id = await page.evaluate(() =>
      window.__drivelineDevHooks!.addBookmarkAtCursor("first"),
    );
    expect(id).not.toBeNull();

    // Double-click the label to swap in the input.
    const row = page.getByTestId(`bookmark-row-${id}`);
    await row.locator("text=first").dblclick();
    const input = page.getByTestId(`bookmark-rename-input-${id}`);
    await input.fill("renamed");
    await input.press("Enter");

    // Drawer reflects the rename.
    await expect(row.locator("text=renamed")).toBeVisible();
    expect((await listBookmarks(page))[0].label).toBe("renamed");

    // Reload — bookmark + new label survive.
    await page.reload();
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );
    const after = await listBookmarks(page);
    expect(after).toHaveLength(1);
    expect(after[0].label).toBe("renamed");
  });

  test("× removes drawer row and transport marker", async ({ page }) => {
    await loadMcap(page);
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("events"),
    );

    const id = await page.evaluate(() =>
      window.__drivelineDevHooks!.addBookmarkAtCursor("doomed"),
    );
    expect(id).not.toBeNull();
    await expect(page.getByTestId(`bookmark-row-${id}`)).toBeVisible();
    await expect(page.getByTestId(`bookmark-marker-${id}`)).toBeVisible();

    // Hover over the row first so the × is interactable, then click it.
    await page.getByTestId(`bookmark-row-${id}`).hover();
    await page.getByTestId(`bookmark-remove-${id}`).click();
    await expect(page.getByTestId(`bookmark-row-${id}`)).toHaveCount(0);
    await expect(page.getByTestId(`bookmark-marker-${id}`)).toHaveCount(0);
    await expect(page.getByTestId("bookmarks-count-pill")).toHaveText("0");
  });

  test("bookmarks survive clearSession (mirror namedLayouts posture)", async ({
    page,
  }) => {
    await loadMcap(page);
    const id = await page.evaluate(() =>
      window.__drivelineDevHooks!.addBookmarkAtCursor("survives"),
    );
    expect(id).not.toBeNull();
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
    const after = await listBookmarks(page);
    expect(after).toHaveLength(1);
    expect(after[0].label).toBe("survives");
  });
});
