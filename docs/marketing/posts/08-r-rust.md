# r/rust (+ This Week in Rust)

- **Where:** https://www.reddit.com/r/rust ; then submit a PR to
  https://github.com/rust-lang/this-week-in-rust linking the writeup
- **When:** weekday AM ET
- **Format:** a **technical writeup**, not a product pitch. Lead with the Rust/WASM
  lesson; the repo is supporting detail. Bare product links get downvoted/removed.
- **Rules:** r/rust tolerates "I built X in Rust" when there's real engineering
  substance. TWiR wants a link-worthy artifact (blog post / release) — write it
  first, then PR it into the news section (or suggest the crate for Crate of the
  Week).
- **Risk:** Medium (anti-ad).

> Note: the "What's everyone working on this week" thread is on the official
> users.rust-lang.org forum, not the subreddit — good low-friction first mention.

---

**Title:** Shipped a 4K-video + CAN-log viewer with a Rust→WASM core — notes on keeping it under the size budget

I built an open-source browser log viewer (Driveline) where the whole data core is
portable Rust compiled to `wasm32-unknown-unknown` and driven from Comlink workers.
A few things that were fun/painful and might interest r/rust:

- Keeping first-load **WASM under 2 MB gzip** with `wasm-opt -Oz` while still
  parsing MCAP + ASAM MF4 and producing Arrow.
- **Apache Arrow IPC** as the zero-copy wire format between Rust and JS; the
  pipeline is lazy and ranged (panels request `[startNs, endNs]`, never whole
  channels).
- Keeping the core **browser-dependency-free** so it's testable natively with
  `cargo test` and reusable from a native CLI.

It reads vehicle/robot logs and syncs 4K video to signals on one ns clock, fully
client-side. MPL-2.0. Repo (the design docs are detailed):
https://github.com/dmagyar-0/driveline — happy to go deep on the WASM or Arrow bits.

---

**Pre-post checklist**
- [ ] Title is about the Rust/WASM lesson, not the product
- [ ] Real technical substance in the body
- [ ] Writeup/blog exists before the TWiR PR
- [ ] Disclosed authorship
