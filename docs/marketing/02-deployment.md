# Driveline — Public Deployment Runbook

> How to put Driveline on a public URL so it can be shared. The hard part — a
> Rust→WASM build — is already solved in CI for Cloudflare Pages. Vercel is a
> complete fallback but you maintain the Rust bootstrap yourself.

## Recommendation: Cloudflare Pages

Already wired end-to-end: `.github/workflows/deploy.yml` installs Rust +
`wasm32-unknown-unknown` + a pinned `wasm-pack v0.15.0`, runs `pnpm build`
(`wasm:build` then web build), and ships `apps/web/dist` via `wrangler pages
deploy`. `wrangler.toml`, the SPA fallback (`apps/web/public/_redirects`), and
the docs are all aligned to Pages. Vercel's build image has no Rust by default,
so the WASM step must be bootstrapped in the install command — it works, but
it's a slower custom path you'd own.

## Cloudflare Pages runbook (the wired path)

1. **Add two repo secrets** (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN` — create at
     <https://dash.cloudflare.com/profile/api-tokens> with the **"Cloudflare
     Pages: Edit"** permission (use the template of that name).
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard → any domain → right
     sidebar, or read it from the URL after `dash.cloudflare.com/`.
2. **Trigger the first deploy** — push/merge to `main`, or Actions → "Deploy
   (Cloudflare Pages)" → Run workflow. First run does `wrangler pages project
   create driveline --production-branch=main` (idempotent) then `wrangler pages
   deploy apps/web/dist`.
3. **Expected URL:** `https://driveline.pages.dev` (production from `main`).
   Manual dispatch from a branch publishes a preview at
   `https://<branch>.driveline.pages.dev`.
4. **HTTPS** is on by default — satisfies the only hard production requirement
   (WebCodecs/OffscreenCanvas need a secure context). **No COOP/COEP headers
   needed** (only required for a threaded/`SharedArrayBuffer` WASM build, which
   Driveline doesn't use). No `_headers` file is needed today.
5. **Custom domain (optional):** Pages project → Custom domains → Set up a
   domain. On-Cloudflare DNS is automatic; elsewhere add the CNAME Pages shows.
   Cert is automatic either way.

**Flags:**
- ⚠️ The workflow has `environment: production`. If required reviewers are
  enabled on that GitHub Environment (Settings → Environments → production),
  deploys block on manual approval.
- ✅ `_redirects` (`/*  /index.html  200`) gives correct SPA deep-link behavior.

## Vercel runbook (fallback)

**The obstacle:** the web build imports the generated WASM bundle from
`apps/web/src/wasm/`, which is **gitignored and multi-MB**. Vercel's standard
Node image has **no cargo/rustc**, so a plain `pnpm build` fails at `wasm-pack`.

**Option A — build Rust inside Vercel's install step (cleanest):**
- Framework Preset: Other / Vite · Root Directory: repo root · Node 22
- **Install Command:**
  ```sh
  curl https://sh.rustup.rs -sSf | sh -s -- -y --default-toolchain stable --target wasm32-unknown-unknown && \
  . "$HOME/.cargo/env" && cargo install wasm-pack --version 0.15.0 --locked && \
  pnpm install --frozen-lockfile
  ```
- **Build Command:** `. "$HOME/.cargo/env" && pnpm build`
- **Output Directory:** `apps/web/dist`
- Caveat: `cargo install wasm-pack` adds several minutes per cold build.
  Faster: download the prebuilt `wasm-pack` binary instead of building it.

**Option B — prebuilt artifact:** build WASM in GitHub Actions, publish
`apps/web/src/wasm/` as an artifact/branch, have Vercel's install step fetch it
so Vercel only runs `vite build`. More plumbing; only worth it if Option A's
build time hurts.

**SPA fallback on Vercel:** `_redirects` is Cloudflare-only and ignored by
Vercel. Add `vercel.json` with `{ "rewrites": [{ "source": "/(.*)",
"destination": "/index.html" }] }`, or rely on Vercel's Vite preset — verify
deep-link refresh after first deploy.

A Vercel MCP connector (`deploy_to_vercel`, build-log/project tools) can drive
this programmatically.

## "Before you share it publicly" polish checklist

### P0
- **OG / link-preview meta in `apps/web/index.html`** — ✅ **done** in this
  branch (description + Open Graph + Twitter Card added). Still need a 1200×630
  **`og-image.png`** at `apps/web/public/brand/` so links render with an image
  (build one from the brand wordmark/logo SVGs). Until it exists, link previews
  show text only (not broken).

### P1
- **`robots.txt`** — none under `apps/web/public/`. Add one and decide whether
  the app should be indexed.
- **Web analytics** — none. Cloudflare Web Analytics is a one-snippet,
  cookieless fit for the privacy posture if you want visitor counts.
- **Confirm the public demo asset host is reachable** — the "Try the demo"
  button fetches ~36 MB from `raw.githubusercontent.com/dmagyar-0/driveline/
  demo-assets`. The `demo-assets` branch exists, so it works **while the repo is
  public**. If the repo is private at launch, the demo silently fails — click
  through the deployed site to confirm.

### P2
- **Landing/marketing surface** — first-time visitors drop into the app, but the
  empty state (`src/shell/FirstRun.tsx`) is already strong: drag-drop hint,
  format chips, one-click "Try the demo" comma2k19 drive, load-from-URL, keyboard
  hints. A separate marketing page is optional, not required.
- **WebCodecs gating** handled (`unsupportedSplash.ts`); public Safari/older
  visitors get the unsupported splash by design.

## In-env tool availability (build sanity check)

| Tool | Status |
| --- | --- |
| Node | ✅ v22.22.2 |
| pnpm | ✅ 10.33.0 |
| Rust / cargo | ✅ present (rustup stable) |
| `wasm32-unknown-unknown` | ✅ installed |
| `wasm-pack` | ❌ not installed |

An in-env build needs one step first: `cargo install wasm-pack --version 0.15.0
--locked`, then `pnpm install && pnpm build`.
