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
  });

  it("includes an alert role for assistive tech", () => {
    expect(unsupportedSplashHtml).toContain('role="alert"');
  });
});
