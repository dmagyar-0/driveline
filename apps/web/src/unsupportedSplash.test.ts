import { describe, expect, it } from "vitest";
import {
  isWebCodecsSupported,
  unsupportedSplashHtml,
} from "./unsupportedSplash";

describe("isWebCodecsSupported", () => {
  it("returns false when VideoDecoder is missing", () => {
    expect(isWebCodecsSupported({})).toBe(false);
  });

  it("returns false when VideoDecoder lacks isConfigSupported", () => {
    const stub = function VideoDecoder() {} as unknown;
    expect(isWebCodecsSupported({ VideoDecoder: stub })).toBe(false);
  });

  it("returns true when VideoDecoder and isConfigSupported exist", () => {
    const stub = function VideoDecoder() {} as unknown as {
      isConfigSupported: () => void;
    };
    stub.isConfigSupported = () => {};
    expect(isWebCodecsSupported({ VideoDecoder: stub })).toBe(true);
  });
});

describe("unsupportedSplashHtml", () => {
  it("mentions WebCodecs and the supported browsers", () => {
    expect(unsupportedSplashHtml).toContain("WebCodecs");
    expect(unsupportedSplashHtml).toContain("Chrome");
    expect(unsupportedSplashHtml).toContain("Edge");
    // Firefox 130+ ships WebCodecs and IS supported — the old copy wrongly
    // lumped it in with Safari as unsupported.
    expect(unsupportedSplashHtml).toContain("Firefox");
  });

  it("advertises the documented 130+ baseline, not the stale 94+", () => {
    expect(unsupportedSplashHtml).toContain("130+");
    expect(unsupportedSplashHtml).not.toContain("94+");
  });

  it("names Safari as the unsupported browser (by design)", () => {
    expect(unsupportedSplashHtml).toContain("Safari");
    // Firefox must not be described as unsupported any more.
    expect(unsupportedSplashHtml).not.toMatch(
      /Firefox and Safari do not/,
    );
  });

  it("includes an alert role for assistive tech", () => {
    expect(unsupportedSplashHtml).toContain('role="alert"');
  });
});
