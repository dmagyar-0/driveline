import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UrlFetchBlockedError, urlProbeSize, urlReadRange } from "./urlRange";

// What the next `xhr.send()` should do. Either throw (the way a sync XHR
// reports a CORS/network block) or complete with a status + headers + body.
type SendBehavior =
  | { throwOnSend: true }
  | { status: number; headers?: Record<string, string>; response?: ArrayBuffer };

let behavior: SendBehavior;
const sentRanges: string[] = [];

// Minimal synchronous-XHR stand-in. urlRange.ts only touches this surface.
class FakeXHR {
  status = 0;
  responseType = "";
  response: ArrayBuffer | null = null;
  #headers: Record<string, string> = {};

  open(): void {}

  setRequestHeader(name: string, value: string): void {
    if (name === "Range") sentRanges.push(value);
  }

  send(): void {
    if ("throwOnSend" in behavior) {
      throw new DOMException("network error", "NetworkError");
    }
    this.status = behavior.status;
    this.#headers = behavior.headers ?? {};
    this.response = behavior.response ?? null;
  }

  getResponseHeader(name: string): string | null {
    return this.#headers[name] ?? null;
  }
}

function bytes(...vals: number[]): ArrayBuffer {
  return new Uint8Array(vals).buffer;
}

beforeEach(() => {
  sentRanges.length = 0;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("urlProbeSize", () => {
  it("reads the total size out of Content-Range on a 206", () => {
    behavior = { status: 206, headers: { "Content-Range": "bytes 0-0/123456" } };
    expect(urlProbeSize("https://host/log.mf4")).toBe(123456);
    // The probe asks for a single byte.
    expect(sentRanges).toEqual(["bytes=0-0"]);
  });

  it("flags a CORS/network block when send() throws", () => {
    behavior = { throwOnSend: true };
    expect(() => urlProbeSize("https://host/log.mf4")).toThrow(
      UrlFetchBlockedError,
    );
  });

  it("flags a CORS/network block when status is 0", () => {
    behavior = { status: 0 };
    expect(() => urlProbeSize("https://host/log.mf4")).toThrow(
      UrlFetchBlockedError,
    );
  });

  it("reports a range-unsupported error (not a CORS block) on a 200", () => {
    behavior = { status: 200 };
    let caught: unknown;
    try {
      urlProbeSize("https://host/log.mf4");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UrlFetchBlockedError);
    expect(String(caught)).toMatch(/range requests/);
  });

  it("rejects a 206 that lacks a usable total size", () => {
    behavior = { status: 206, headers: { "Content-Range": "bytes 0-0/*" } };
    expect(() => urlProbeSize("https://host/log.mf4")).toThrow(
      /usable total size/,
    );
  });

  it("phrases the block message for the user (URL + CORS + escape hatch)", () => {
    behavior = { throwOnSend: true };
    let message = "";
    try {
      urlProbeSize("https://host/log.mf4");
    } catch (e) {
      if (e instanceof Error) message = e.message;
    }
    expect(message).toContain("https://host/log.mf4");
    expect(message).toContain("CORS");
    expect(message).toContain("drop it in");
    // The displayed reason must not carry the error class-name prefix.
    expect(message).not.toMatch(/^UrlFetchBlockedError:/);
  });
});

describe("urlReadRange", () => {
  it("returns exactly the requested window on a 206", () => {
    behavior = { status: 206, response: bytes(10, 20, 30, 40) };
    const out = urlReadRange("https://host/log.mf4", 8, 4);
    expect([...out]).toEqual([10, 20, 30, 40]);
    expect(sentRanges).toEqual(["bytes=8-11"]);
  });

  it("slices the window out of a whole-body 200 response", () => {
    behavior = { status: 200, response: bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9) };
    const out = urlReadRange("https://host/log.mf4", 2, 3);
    expect([...out]).toEqual([2, 3, 4]);
  });

  it("flags a CORS/network block when send() throws", () => {
    behavior = { throwOnSend: true };
    expect(() => urlReadRange("https://host/log.mf4", 0, 16)).toThrow(
      UrlFetchBlockedError,
    );
  });

  it("flags a CORS/network block when status is 0", () => {
    behavior = { status: 0 };
    expect(() => urlReadRange("https://host/log.mf4", 0, 16)).toThrow(
      UrlFetchBlockedError,
    );
  });

  it("reports a plain HTTP error (not a CORS block) on a 404", () => {
    behavior = { status: 404 };
    let caught: unknown;
    try {
      urlReadRange("https://host/log.mf4", 0, 16);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UrlFetchBlockedError);
    expect(String(caught)).toMatch(/status 404/);
  });

  it("throws on a short read", () => {
    behavior = { status: 206, response: bytes(1, 2) };
    expect(() => urlReadRange("https://host/log.mf4", 0, 4)).toThrow(
      /short read/,
    );
  });
});
