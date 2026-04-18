import { test, expect } from "@playwright/test";

declare global {
  interface Window {
    __drivelineDevHooks?: {
      ping: () => Promise<string>;
      pingVideo: () => Promise<string>;
      fetchScalar: () => Promise<{ rows: number; sum: number }>;
    };
  }
}

test("dataCore and videoDecode workers respond to ping", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("workers ready");

  const pong = await page.evaluate(async () => {
    return await window.__drivelineDevHooks!.ping();
  });
  expect(pong).toBe("pong");

  const videoPong = await page.evaluate(async () => {
    return await window.__drivelineDevHooks!.pingVideo();
  });
  expect(videoPong).toBe("pong");
});

test("dataCore fetchRangeStub returns Arrow bytes parseable as the scalar contract", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("workers ready");

  const result = await page.evaluate(async () => {
    return await window.__drivelineDevHooks!.fetchScalar();
  });
  expect(result.rows).toBe(3);
  expect(result.sum).toBeCloseTo(6.0, 9);
});
