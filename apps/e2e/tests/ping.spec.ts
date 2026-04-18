import { test, expect } from "@playwright/test";

declare global {
  interface Window {
    __drivelineDevHooks?: {
      ping: () => Promise<string>;
      pingVideo: () => Promise<string>;
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
