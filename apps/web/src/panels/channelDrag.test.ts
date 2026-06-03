// Unit tests for the channel drag-and-drop contract (drawer → plot panel).
//
// The helpers are pure wrappers over a DataTransfer, so we exercise them
// against a minimal fake rather than a real drag context (unavailable in
// jsdom). The key behaviours: a round-trippable typed payload, a
// dragover-safe `types` probe, and null-safety for the shell-level guard.

import { describe, expect, it } from "vitest";
import {
  CHANNEL_DND_MIME,
  getChannelDragData,
  hasChannelDrag,
  setChannelDragData,
} from "./channelDrag";

// Stand-in for the slice of DataTransfer the helpers touch.
class FakeDataTransfer {
  private store = new Map<string, string>();
  effectAllowed = "";
  dropEffect = "";
  get types(): string[] {
    return [...this.store.keys()];
  }
  setData(type: string, value: string): void {
    this.store.set(type, value);
  }
  getData(type: string): string {
    return this.store.get(type) ?? "";
  }
}

function dt(): DataTransfer {
  return new FakeDataTransfer() as unknown as DataTransfer;
}

describe("channelDrag", () => {
  it("round-trips a channel id through set/get", () => {
    const d = dt();
    setChannelDragData(d, "mcap::/vehicle/speed");
    expect(getChannelDragData(d)).toBe("mcap::/vehicle/speed");
  });

  it("writes a text/plain mirror and a copy effect", () => {
    const d = dt();
    setChannelDragData(d, "abc");
    expect(d.getData("text/plain")).toBe("abc");
    expect(d.effectAllowed).toBe("copy");
  });

  it("detects a channel drag from the types list (dragover-safe)", () => {
    const d = dt();
    expect(hasChannelDrag(d)).toBe(false);
    setChannelDragData(d, "abc");
    expect(Array.from(d.types)).toContain(CHANNEL_DND_MIME);
    expect(hasChannelDrag(d)).toBe(true);
  });

  it("does not treat a plain-text or file drag as a channel drag", () => {
    const d = dt();
    d.setData("text/plain", "hello");
    expect(hasChannelDrag(d)).toBe(false);
  });

  it("is null/undefined safe (shell-level guard calls it on any drag)", () => {
    expect(hasChannelDrag(null)).toBe(false);
    expect(hasChannelDrag(undefined)).toBe(false);
    expect(getChannelDragData(null)).toBeNull();
    expect(getChannelDragData(undefined)).toBeNull();
  });

  it("returns null when no channel payload is present", () => {
    expect(getChannelDragData(dt())).toBeNull();
  });
});
