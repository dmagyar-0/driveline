# Driveline — Launch Automation Matrix

> What an agent with live **GitHub, Vercel, Supabase, Gmail, Google Calendar,
> Google Drive** connectors can do for the launch. **[AUTO]** = end-to-end now ·
> **[DRAFT]** = agent prepares, human clicks publish/send/approve ·
> **[BLOCKED]** = needs credentials/access/human the agent lacks.

Three facts drive the classifications:
1. The app is static at runtime but **can't be built without Rust + wasm-pack**
   (`pnpm build` runs `wasm:build` first; the `.wasm` is gitignored, multi-MB).
   Any host that builds from source needs Rust in its build image.
2. CI deploy is gated on two **Cloudflare secrets** only a human with the
   Cloudflare account can mint — no connector can create them.
3. The product is **agent-first** — itself a marketing angle to lead with.

## Matrix

| Connector | Action | Class | Notes |
|---|---|---|---|
| GitHub | Repo description + topics | **AUTO** | Reversible metadata. |
| GitHub | README polish / templates | **DRAFT** | Via PR; CLAUDE.md says never commit to `main` — human merges. |
| GitHub | Tagged release + notes | **DRAFT** | Agent drafts notes from commits; human publishes. |
| GitHub | `good first issue` labels + starter issues | **DRAFT** | Label creation is AUTO; which work is beginner-friendly wants review. |
| GitHub | Enable Discussions / Pages / social-preview image / pin | **BLOCKED** | Settings toggles + image upload not in the MCP toolset; human flips them. |
| GitHub Pages | Host the app | **BLOCKED** | Pages won't run the Rust build; committing a prebuilt multi-MB `.wasm` is forbidden by project rules. Use Cloudflare/Vercel. |
| GitHub | CI deploy secrets (`CLOUDFLARE_*`) | **BLOCKED** | Can't write Actions secrets; values don't exist until a human mints them. |
| Vercel | Deploy to preview/prod URL | **AUTO\*** | Only succeeds once the build command bootstraps Rust + wasm-pack (or is fed a prebuilt `dist/`). Out-of-the-box it's BLOCKED on build env. |
| Vercel | Project settings (build/install/env) | **AUTO** | Where the Rust bootstrap gets wired. |
| Vercel | Custom-domain availability + price | **AUTO** | `check_domain_availability_and_price`. |
| Vercel | Purchase domain + assign | **BLOCKED** | Needs billing auth; agent reports price, human buys. |
| Vercel | Read build/runtime logs | **AUTO** | Agent self-diagnoses the WASM build failure and iterates. |
| Supabase | Create project | **DRAFT** | `create_project` runs through a cost-confirm spend gate. |
| Supabase | Waitlist + feedback + analytics schema | **AUTO** | Once a project exists: `apply_migration` + `deploy_edge_function`. Schema below. |
| Supabase | Wire frontend | **DRAFT** | Code change via PR; also a **scope decision** — contradicts the "no server, files never leave the tab" tenet. |
| Gmail | Outreach drafts (ROS Discourse, Foxglove/Rerun communities, newsletters, press, users) | **DRAFT** | `create_draft` only — sending is human. |
| Gmail | Send anything | **BLOCKED-by-design** | No send tool; correct posture for cold outreach. |
| Calendar | Schedule launch day, Show HN slot, PH day, content cadence, reminders | **AUTO** | `create_event` / `suggest_time`. |
| Drive | Press-kit folder, upload logo/GIFs/screenshots, one-pager, share links | **AUTO** | Flag: nuScenes fusion GIF is **CC BY-NC-SA non-commercial** — keep the BYOA GIF as the safer hero asset. |
| Drive | Produce the demo GIF/video | **BLOCKED** | That's the `demo-video`/`byoa-video` Playwright+ffmpeg skill pipeline, not a Drive op. |

\* The single most important realism flag: **Vercel-via-MCP can deploy, but only
if the build env installs Rust + wasm-pack, or is fed a prebuilt `dist/`.**

## Minimal Supabase backend sketch (only if you choose to add one)

```sql
create table waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  source text,                      -- 'hn' | 'producthunt' | 'readme' | ...
  created_at timestamptz default now()
);
create table feedback (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  email text, url text, user_agent text,
  origin text default 'human',      -- mirror the project's agent/human provenance
  created_at timestamptz default now()
);
create table events (
  id bigint generated always as identity primary key,
  name text not null,               -- 'pageview' | 'file_open' | 'panel_add'
  path text, ts timestamptz default now(),
  day_hash text                     -- salted hash for rough unique/day; no IP
);
```
RLS on all three; anon role gets `insert` only (write but not read). Reads via
service-role edge function or dashboard. Edge functions: `track` (sanitize +
insert, strip IP, compute `day_hash` server-side), optional `subscribe`
(waitlist insert + rate limit). **Scope flag:** any backend contradicts the
"no server" design tenet — surface it as a decision, don't silently bolt it on.

## Day-1 autonomous launch sequence (on "go")

1. **[AUTO]** GitHub: set repo description + topics.
2. **[AUTO]** create labels (`good first issue`, `help wanted`); **[DRAFT]** file
   3–5 curated starter issues.
3. **[DRAFT]** open PR with README launch polish + issue/PR/discussion templates.
   → human merge.
4. **[AUTO]** Vercel: configure Rust-bootstrapping build, trigger preview deploy,
   read logs, iterate to green → shareable preview URL.
5. **[AUTO]** Vercel: check custom-domain availability + price → human purchase.
6. **[DRAFT]** Supabase: scaffold waitlist/feedback/analytics, stop at cost
   confirm → human spend gate; frontend wiring as PR.
7. **[AUTO]** Drive: build press-kit folder + public share links.
8. **[AUTO]** Calendar: schedule Show HN slot, PH day, 2-week content cadence.
9. **[DRAFT]** Gmail: draft tailored outreach → human send.
10. **[DRAFT]** GitHub: draft `v0.1.0` release notes → human publish.

**Human approval gates:** merge the PR (3), buy the domain (5), confirm Supabase
spend + merge backend PR (6), send outreach (9), publish release (10).

## Irreducibly human

- **Cloudflare:** mint the API token + read the account id, add
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` as Actions secrets (or pick
  Vercel and skip Cloudflare).
- **GitHub Settings toggles** the MCP can't reach: enable Discussions/Pages,
  upload the social-preview image, pin the repo/issues.
- **Buy the domain** (payment auth).
- **Confirm paid Supabase creation** and **own the scope call** of adding a
  backend at all.
- **Click send** on outreach, **publish** the release.
- **Record new demo media** (Playwright+ffmpeg skill pipeline; respect that the
  nuScenes asset is CC BY-NC-SA non-commercial).
- **Merge every PR** (never commit to `main`).

**Bottom line:** roughly half the launch is genuinely hands-off (repo metadata,
labels, calendar, Drive press kit, Vercel preview deploy once the Rust build is
set, Supabase schema against an existing project). The persuasive/spending/
credential steps stay DRAFT or BLOCKED behind a human. The biggest hidden trap:
assuming a static-host deploy "just works" — Driveline's Rust/wasm build step
means a naive deploy fails unless the build env is bootstrapped.
