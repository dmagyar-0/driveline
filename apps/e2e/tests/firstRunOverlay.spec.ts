import { test, expect } from "@playwright/test";

// Regression: the FirstRun "No session loaded" pool overlays the
// still-mounted workspace. The default layout (and any previously
// configured / persisted layout) is a multi-tabset split, so FlexLayout
// renders panel dividers (`.flexlayout__splitter`, z-index 10) behind the
// pool. The overlay must paint on top of those dividers — otherwise the
// divider bleeds through the empty state. See FirstRun.module.css.
test("empty-state pool paints over FlexLayout panel dividers", async ({
  page,
}) => {
  await page.goto("/");

  const pool = page.getByTestId("first-run");
  await expect(pool).toBeVisible();

  // The default 50/50 split puts at least one splitter behind the pool.
  const splitter = page.locator(".flexlayout__splitter").first();
  await expect(splitter).toBeVisible();
  const box = await splitter.boundingBox();
  expect(box).not.toBeNull();

  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  // The topmost painted element at the divider's centre must belong to
  // the empty-state pool, not the splitter underneath it.
  const coveredByPool = await page.evaluate(
    ([x, y]) =>
      !!document.elementFromPoint(x, y)?.closest('[data-testid="first-run"]'),
    [cx, cy],
  );
  expect(coveredByPool).toBe(true);
});
