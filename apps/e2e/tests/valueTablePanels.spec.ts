// E2E · Value + Table panels.
//
// The single-value reader was renamed "Value" (Table kind → Value kind,
// per-row timestamp column dropped) and a new "Table" panel renders the
// full raw series as a virtualised, cursor-highlighted time-series. These
// specs drive both through the dev hooks against the short.mcap fixture.

import { test, expect } from "@playwright/test";

async function openFixture(page: import("@playwright/test").Page) {
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

async function firstScalar(page: import("@playwright/test").Page) {
  const id = await page.evaluate(() => {
    const list = window.__drivelineDevHooks!.listChannels();
    return list.find((c) => c.kind === "scalar")?.id ?? null;
  });
  expect(id).not.toBeNull();
  return id as string;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
  await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    await window.__drivelineDevHooks!.clearSession();
  });
});

test("Value panel binds a channel and shows the VALUE pill", async ({
  page,
}) => {
  await openFixture(page);
  const valueId = await page.evaluate(() =>
    window.__drivelineDevHooks!.addValuePanel(),
  );
  expect(valueId).toBeTruthy();
  const channelId = await firstScalar(page);

  await page.evaluate(
    ([panelId, id]) =>
      window.__drivelineDevHooks!.addValueChannelBinding(panelId, id),
    [valueId!, channelId],
  );

  await page.evaluate(() =>
    window.__drivelineDevHooks!.setActiveRailTab("panel"),
  );
  await page.evaluate(
    (id) => window.__drivelineDevHooks!.setSelectedPanelId(id),
    valueId!,
  );

  await expect(page.getByTestId("drawer-panel-kind")).toHaveText("VALUE");
  await expect(page.getByTestId("value-panel")).toBeVisible();
  await expect(page.getByTestId(`value-row-${channelId}`)).toBeVisible();
  // The renamed panel has no per-row timestamp column.
  await expect(page.getByText("ts (s)")).toHaveCount(0);
});

test("Table panel renders the raw series with a cursor-highlighted row", async ({
  page,
}) => {
  await openFixture(page);
  const tableId = await page.evaluate(() =>
    window.__drivelineDevHooks!.addTablePanel(),
  );
  expect(tableId).toBeTruthy();
  const channelId = await firstScalar(page);

  await page.evaluate(
    ([panelId, id]) =>
      window.__drivelineDevHooks!.addTableChannelBinding(panelId, id),
    [tableId!, channelId],
  );

  // Park the cursor mid-session via the scrubber so a row is active.
  const box = await page.getByTestId("scrubber").boundingBox();
  if (!box) throw new Error("scrubber not visible");
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  await expect(page.getByTestId("table-panel")).toBeVisible();
  await expect(page.getByTestId(`table-col-${channelId}`)).toBeVisible();
  // The merged model lands and the cursor row is highlighted + on screen.
  await expect(page.getByTestId("table-active-row")).toBeVisible();
  await expect(
    page.getByTestId(`table-active-${channelId}`),
  ).toBeVisible();
});
