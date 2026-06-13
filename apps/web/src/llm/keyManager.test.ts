import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_BASE_URL,
  assertAnthropicBaseUrl,
  clearKey,
  getKey,
  hasPersistedKey,
  setKey,
} from "./keyManager";

// A minimal in-memory localStorage so the key-persistence tests run under the
// `node` vitest environment (no jsdom). Installed on globalThis for the suite.
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => store.delete(k),
    setItem: (k, v) => void store.set(k, v),
  };
  vi.stubGlobal("localStorage", mock);
}

describe("keyManager", () => {
  beforeEach(() => {
    installLocalStorage();
    clearKey();
  });

  afterEach(() => {
    clearKey();
    vi.unstubAllGlobals();
  });

  it("holds the key in memory by default and does NOT persist it", () => {
    setKey("sk-ant-memory");
    expect(getKey()).toBe("sk-ant-memory");
    expect(hasPersistedKey()).toBe(false);
    expect(localStorage.getItem("driveline.anthropic.key")).toBeNull();
  });

  it("persists only when the opt-in flag is set", () => {
    setKey("sk-ant-persisted", { persist: true });
    expect(hasPersistedKey()).toBe(true);
    expect(localStorage.getItem("driveline.anthropic.key")).toBe(
      "sk-ant-persisted",
    );
  });

  it("reads a persisted key back through getKey()", () => {
    localStorage.setItem("driveline.anthropic.key", "sk-ant-from-disk");
    expect(getKey()).toBe("sk-ant-from-disk");
  });

  it("toggling persist off forgets the device copy but keeps it in memory", () => {
    setKey("sk-ant-x", { persist: true });
    expect(hasPersistedKey()).toBe(true);
    setKey("sk-ant-x"); // no persist
    expect(hasPersistedKey()).toBe(false);
    expect(getKey()).toBe("sk-ant-x");
  });

  it("clearKey() forgets memory and disk", () => {
    setKey("sk-ant-x", { persist: true });
    clearKey();
    expect(getKey()).toBeNull();
    expect(hasPersistedKey()).toBe(false);
  });

  describe("assertAnthropicBaseUrl", () => {
    it("accepts exactly https://api.anthropic.com", () => {
      expect(() => assertAnthropicBaseUrl(ANTHROPIC_BASE_URL)).not.toThrow();
      expect(() =>
        assertAnthropicBaseUrl("https://api.anthropic.com/v1"),
      ).not.toThrow();
    });

    it("rejects any other host, scheme, or port", () => {
      expect(() => assertAnthropicBaseUrl("https://evil.example.com")).toThrow(
        /non-Anthropic base URL/,
      );
      expect(() =>
        assertAnthropicBaseUrl("http://api.anthropic.com"),
      ).toThrow();
      expect(() =>
        assertAnthropicBaseUrl("https://api.anthropic.com:8443"),
      ).toThrow();
      expect(() =>
        assertAnthropicBaseUrl("https://api.anthropic.com.evil.com"),
      ).toThrow();
      expect(() => assertAnthropicBaseUrl("not a url")).toThrow();
    });
  });
});
