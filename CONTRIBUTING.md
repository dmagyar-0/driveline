# Contributing to Driveline

Thanks for helping out. This file covers the licensing mechanics; for the
day-to-day workflow (build, test, ship) see [`CLAUDE.md`](./CLAUDE.md) and
[`docs/book/11-run-test-ship.md`](./docs/book/11-run-test-ship.md).

## Licensing

Driveline is [MPL-2.0](./LICENSE). By contributing you agree your changes are
licensed under the same terms.

### Per-file header (recommended)

MPL-2.0 applies to the whole repository through the `LICENSE` file, so a
header on every source file is **not required** for the license to take
effect. We still recommend adding the standard MPL "Exhibit A" notice to new
source files — it makes the license unambiguous if a single file is copied
out of the tree.

For TypeScript / Rust / JS (`//` comments):

```
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
```

For CSS (`/* */` comments):

```css
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
```

Existing files were not mass-edited to add this header; add it to new files
and feel free to add it to files you're already touching.

### Adding a dependency

Dependency licenses are gated in CI and must be permissive or
MPL-compatible. Non-OSI terms (GPL/AGPL, ethical-source licenses such as
Hippocratic, etc.) will fail the build. Before adding a dependency, check it
locally:

```sh
pnpm license:check:rust   # cargo deny check licenses
pnpm license:check:js     # scripts/check-js-licenses.mjs
```

If a new dependency introduces a license that is acceptable but not yet on
the allow list, add its SPDX identifier to **both** gates so the Rust and JS
trees stay in sync:

- [`deny.toml`](./deny.toml) — the `allow` list under `[licenses]`
- [`scripts/check-js-licenses.mjs`](./scripts/check-js-licenses.mjs) — the
  `ALLOW` set

If a dependency is only acceptable under a narrow exception (rather than
blanket-allowing its license everywhere), prefer a scoped exception in
`deny.toml` and a comment explaining why.
