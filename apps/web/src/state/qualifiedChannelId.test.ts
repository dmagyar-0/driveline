// Focused unit tests for `qualifiedChannelId`. The function is exercised
// indirectly by `store.test.ts` (two MF4s with the same native id stay
// distinct after a double-drop), but the explicit length-prefix
// invariant — "distinct (sourceId, nativeId) pairs cannot compose to
// the same string regardless of how either side embeds `|`" — only has
// teeth as a unit test that probes the encoding directly. Without these,
// a refactor to a naive `${sourceId}|${nativeId}` would silently pass
// the integration test (since the two MF4 source ids differ on suffix)
// while breaking the documented collision-resistance.
//
// Lives next to `store.ts` rather than inside `store.test.ts` so the
// pure helper has a self-contained test file the way `bucket.ts` and
// `memoryBudget.ts` do.

import { describe, expect, it } from "vitest";
import { qualifiedChannelId } from "./store";

describe("qualifiedChannelId", () => {
  it("formats as `<nativeId.length>|<nativeId>|<sourceId>`", () => {
    // Pin the wire format so any consumer that splits / parses the
    // string later (currently none, but the format is observable in
    // localStorage via `videoBindings` / `plotBindings` keys) sees a
    // stable encoding.
    expect(qualifiedChannelId("src.mf4", "0/1")).toBe("3|0/1|src.mf4");
  });

  it("encodes the nativeId byte length, not the concatenated length", () => {
    // The leading number is `nativeId.length` — not the total length —
    // because that is what the parser would need to slice the nativeId
    // back out of the composed string. A regression that used the full
    // length would be undetectable from the integration test.
    expect(qualifiedChannelId("anything", "ab")).toBe("2|ab|anything");
    expect(qualifiedChannelId("x", "abcdef")).toBe("6|abcdef|x");
  });

  it("handles an empty nativeId without producing an empty prefix", () => {
    // `nativeId === ""` shouldn't be supplied in practice — every
    // reader emits at least a non-empty channel id — but the encoding
    // still has to be unambiguous for the empty case.
    expect(qualifiedChannelId("src", "")).toBe("0||src");
  });

  it("produces distinct ids when only the sourceId differs", () => {
    // The double-drop case: the wasm summary returns the same
    // `{group}/{channel}` native id, but the session-level ids must
    // differ so the binding maps and PlotPanel's channelMap don't
    // collide.
    const a = qualifiedChannelId("a.mf4", "0/1");
    const b = qualifiedChannelId("a.mf4 (2)", "0/1");
    expect(a).not.toBe(b);
  });

  it("produces distinct ids when only the nativeId differs", () => {
    const a = qualifiedChannelId("src", "0/1");
    const b = qualifiedChannelId("src", "0/2");
    expect(a).not.toBe(b);
  });

  it("collision-resistant against a `|` embedded in the sourceId", () => {
    // Without the length prefix, a sourceId of `b|x` could be
    // indistinguishable from `b` paired with a different nativeId via
    // straight concatenation. The length prefix forces a unique parse.
    const a = qualifiedChannelId("b|x", "a");
    const b = qualifiedChannelId("b", "a|x" /* different nativeId */);
    expect(a).not.toBe(b);
  });

  it("collision-resistant against a `|` embedded in the nativeId", () => {
    // Mirror of the above for the other side. The two compositions
    // that a naive `${sourceId}|${nativeId}` formatter would alias
    // ("src|0", "1") vs ("src", "0|1") must remain distinct.
    const a = qualifiedChannelId("src|0", "1");
    const b = qualifiedChannelId("src", "0|1");
    expect(a).not.toBe(b);
  });

  it("collision-resistant when the nativeId contains the source name", () => {
    // Pathological but legal: the channel id text happens to embed the
    // source name. Length prefix still keeps the two pairs apart.
    const a = qualifiedChannelId("a", "b");
    const b = qualifiedChannelId("ab", "");
    // `1|b|a` vs `0||ab` — different prefixes guarantee no alias.
    expect(a).not.toBe(b);
  });

  it("is deterministic across repeated calls with the same inputs", () => {
    // No hidden state — the function must be a pure projection so
    // restoring a saved layout (whose binding keys are qualified ids
    // captured at save time) matches the freshly-rebuilt session.
    const k = qualifiedChannelId("src", "0/1");
    expect(qualifiedChannelId("src", "0/1")).toBe(k);
    expect(qualifiedChannelId("src", "0/1")).toBe(k);
  });
});
