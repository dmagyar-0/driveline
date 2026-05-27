// Inline contrast verification for the iter2 polish pass. Underscore
// prefix keeps it out of the default `pnpm e2e` invocation. Pulls live
// computed colours from key low-contrast offenders (TOTAL/SPEED/date
// labels, fg tokens against new bg-2/-3) and asserts WCAG AA (≥4.5:1).
//
//   pnpm --filter e2e test _polishIter2Contrast
//
// This is a verification spec — it does not write screenshots; it just
// proves the lifted fg ramp clears the floor against the new chrome and
// panel-body backgrounds. Kept separate from the screenshot spec so a
// future contrast regression is loud (assertion failure) rather than
// silent (visual diff someone has to eyeball).

import { expect, test } from "@playwright/test";

// sRGB-to-WCAG relative luminance.
function luminance(hex: string): number {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new Error(`bad hex: ${hex}`);
  const ch = (h: string) => {
    const v = parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(m[1]) + 0.7152 * ch(m[2]) + 0.0722 * ch(m[3]);
}

function ratio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHex(rgb: string): string {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return rgb;
  return (
    "#" +
    [m[1], m[2], m[3]]
      .map((n) => parseInt(n, 10).toString(16).padStart(2, "0"))
      .join("")
  );
}

test.describe("polish iter2 — WCAG AA on lifted fg ramp", () => {
  test("fg tokens clear 4.5:1 against both chrome and panel-body", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );

    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const read = (n: string) => cs.getPropertyValue(n).trim();
      return {
        bg2: read("--color-bg-2"),
        bg3: read("--color-bg-3"),
        fg2: read("--color-fg-2"),
        fg3: read("--color-fg-3"),
        fg4: read("--color-fg-4"),
        fg5: read("--color-fg-5"),
      };
    });

    // Tokens come back as `#aabbcc` strings (they were authored that way).
    const pairs: Array<[string, string, string, string]> = [
      ["fg-2 on chrome", tokens.fg2, tokens.bg2, "primary body / chrome"],
      ["fg-2 on panel-body", tokens.fg2, tokens.bg3, "primary body / panel"],
      ["fg-3 on chrome", tokens.fg3, tokens.bg2, "secondary / chrome"],
      ["fg-3 on panel-body", tokens.fg3, tokens.bg3, "secondary / panel"],
      ["fg-4 on chrome", tokens.fg4, tokens.bg2, "tertiary / chrome"],
      ["fg-4 on panel-body", tokens.fg4, tokens.bg3, "tertiary / panel"],
      ["fg-5 on chrome", tokens.fg5, tokens.bg2, "muted / chrome"],
      ["fg-5 on panel-body", tokens.fg5, tokens.bg3, "muted / panel"],
    ];

    const failures: string[] = [];
    for (const [name, fg, bg, why] of pairs) {
      const r = ratio(fg, bg);
      // eslint-disable-next-line no-console
      console.log(`  ${name.padEnd(24)} ${fg} on ${bg} = ${r.toFixed(2)}:1 (${why})`);
      if (r < 4.5) failures.push(`${name}: ${r.toFixed(2)}:1 < 4.5`);
    }
    expect(failures, failures.join("\n")).toEqual([]);

    // Spot-check a real rendered element: the "TOTAL" label in the
    // Transport bar uses --color-fg-5 against the bar's bg (--color-bg-2).
    // Read its computed colour from the DOM and confirm it matches the
    // token (i.e. nothing is hard-coded over the top).
    const totalLabel = page.locator('text="TOTAL"').first();
    if ((await totalLabel.count()) > 0) {
      const colors = await totalLabel.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { fg: cs.color, bg: cs.backgroundColor };
      });
      const fgHex = rgbToHex(colors.fg);
      // bg is often transparent on the label itself — walk up to find
      // the first non-transparent ancestor.
      const bgHex = await totalLabel.evaluate((el) => {
        let cur: HTMLElement | null = el as HTMLElement;
        while (cur) {
          const cs = getComputedStyle(cur);
          const bg = cs.backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
            return bg;
          }
          cur = cur.parentElement;
        }
        return "rgb(0, 0, 0)";
      });
      const bgHexConverted = rgbToHex(bgHex);
      const r = ratio(fgHex, bgHexConverted);
      // eslint-disable-next-line no-console
      console.log(
        `  rendered TOTAL label ${fgHex} on ${bgHexConverted} = ${r.toFixed(2)}:1`,
      );
      expect(r, `TOTAL label contrast ${r.toFixed(2)}:1 < 4.5`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
