# Driveline — CV Summary Pack

A self-contained brief on the **Driveline** side project, written for a CV-creator agent.
Pick whichever framing, length, and emphasis fit the target role. Everything below is
factual and verifiable from the project repo and live deployment.

- **Live app:** https://driveline.pages.dev
- **One-line what-it-is:** Browser-first multimodal log viewer for synchronised 4K video
  and high-rate signal data, running entirely client-side.
- **Role:** Sole author / full-stack (design, Rust core, frontend, infra, tests).
- **Status:** Live in production on Cloudflare Pages.

---

## 1. Quick facts (for the agent to draw on)

| Field | Value |
| --- | --- |
| Project name | Driveline |
| Type | Side project / open source |
| Live URL | https://driveline.pages.dev |
| License | MPL-2.0 |
| Frontend | React 19, TypeScript (strict), Vite 6, Zustand, FlexLayout, uPlot, Leaflet |
| Core | Rust (portable, `cargo test`-native), compiled to WebAssembly |
| Bridge | `wasm-bindgen` + Comlink web workers |
| Wire format | Apache Arrow IPC (Rust ↔ JS) |
| Video | WebCodecs (Chromium), 4K |
| Data formats read | MCAP, ASAM MF4, MP4 + timestamp sidecars |
| Hosting / CI-CD | Cloudflare Pages, GitHub Actions (push-to-main ships prod) |
| Testing | Rust unit + contract, JS unit + Arrow contract, Playwright e2e |
| Differentiators | 100% client-side (no backend, data never leaves the tab); nanosecond-precision shared clock; headless agent automation API; <2 MB gzip WASM size budget |

---

## 2. Headline / project title lines

Use one as the entry title or top line.

- **Driveline** — Browser-first multimodal log viewer for synchronised 4K video + high-rate signals (Rust→WASM, React/TS). *Live: driveline.pages.dev*
- **Driveline** — Client-side web app replaying 4K dashcam video alongside vehicle signal data on one nanosecond clock.
- **Driveline** — Open-source, agent-drivable log viewer for automotive/robotics time-series + video, running entirely in the browser.

---

## 3. One-line versions (single bullet)

- *Driveline* — Browser-first multimodal log viewer (Rust→WASM core + React/TS frontend) replaying synchronised 4K video and high-rate vehicle signals from MCAP/MF4 logs entirely client-side, with a headless agent automation API. Live at driveline.pages.dev.
- Built and shipped *Driveline*, a fully client-side web app (Rust compiled to WebAssembly + React 19/TypeScript) that replays 4K video and high-rate signal data on a single synchronised timeline — no backend, data never leaves the browser.
- *Driveline* — Production web app for synchronised 4K-video + signal log replay; portable Rust core in WASM, React/TS UI, Apache Arrow data pipeline, deployed to Cloudflare Pages.

---

## 4. Short version (2–3 bullets)

> **Driveline** — Browser-first multimodal log viewer · *driveline.pages.dev*

- Designed and built a fully client-side web app for replaying 4K dashcam video alongside high-rate vehicle signals (CAN/IMU/GPS) on a single nanosecond-precision timeline — reading industry-standard **MCAP** and **ASAM MF4** logs in-browser with **no backend**, so user data never leaves the tab.
- Implemented a **portable Rust core compiled to WebAssembly** (format parsers + Apache Arrow IPC pipeline) driven from a **React 19 / TypeScript** frontend via Comlink web workers, keeping the UI off the data hot path.
- Shipped to production on **Cloudflare Pages** with CI/CD and full Rust + JS unit, contract, and **Playwright** end-to-end test coverage.

---

## 5. Full version (4–5 bullets)

> **Driveline** — Browser-first multimodal log viewer for synchronised 4K video + high-rate signals · *driveline.pages.dev* · Rust→WASM · React/TS · MPL-2.0

- Architected a **Rust core compiled to WebAssembly** (log-format parsers + Apache Arrow IPC data pipeline) driven from a **React 19 / TypeScript / Vite** frontend through Comlink web workers, keeping all heavy parsing off the UI thread.
- Built first-class readers for **MCAP** and **ASAM MF4** plus paired MP4 video sidecars, presenting video, signal plots, maps, tables, and a 3D scene as dockable panels locked to one **nanosecond-precision** shared clock.
- Engineered for performance under a strict **<2 MB gzip WASM size budget**: lazy, range-based data loading (no full-channel materialisation) and a coalesced cursor/video hot path (≤1 update per animation frame) for smooth scrubbing of 4K **WebCodecs** video.
- Designed the app to be **driven headlessly by agents** — every user capability is mirrored on a stable automation API (`window.__drivelineAgent`), enabling LLM/script "Bring Your Own Agent" workflows such as automatic ODD (Operational Design Domain) tagging via a vision model.
- Shipped as a static SPA with **GitHub Actions → Cloudflare Pages** CI/CD, full Rust + JS unit, contract, and **Playwright** e2e tests, and CI-enforced dependency-license gating.

---

## 6. Prose / paragraph version (portfolio or LinkedIn)

Driveline is a browser-first multimodal log viewer that replays 4K video synchronised
with high-rate signal data (CAN bus, IMU, GPS) on a single nanosecond-precision clock.
It runs entirely client-side: a portable Rust core compiled to WebAssembly parses
industry-standard MCAP and ASAM MF4 logs and streams data to a React 19 / TypeScript
frontend over an Apache Arrow IPC pipeline, all inside Comlink web workers — so files
never leave the browser tab and there is no backend to operate. The app is held to a
strict sub-2 MB gzip WASM budget, uses lazy range-based loading, and keeps the
cursor/video hot path within a one-update-per-frame budget for smooth 4K WebCodecs
playback. Uniquely, every feature is also exposed on a headless automation API so that
LLM agents can drive the app end-to-end — e.g. tagging a drive's Operational Design
Domain from sampled frames. It's live in production on Cloudflare Pages, shipped via
GitHub Actions CI/CD, and covered by Rust, JS, and Playwright test suites. MPL-2.0.

---

## 7. Skills / keywords this project demonstrates

For ATS keyword matching and a "skills" section.

- **Languages:** Rust, TypeScript, JavaScript
- **Frontend:** React 19, Vite, Zustand, CSS Modules, uPlot, Leaflet, FlexLayout
- **Systems / perf:** WebAssembly (wasm-bindgen, wasm-pack), web workers (Comlink),
  WebCodecs, Apache Arrow, performance budgeting, binary format parsing
- **Data formats:** MCAP, ASAM MF4, MP4
- **Infra / tooling:** Cloudflare Pages, GitHub Actions CI/CD, static SPA deployment
- **Testing:** Playwright (e2e), Rust unit/contract tests, contract testing across a
  language boundary
- **Domains:** automotive / robotics time-series, multimodal video+signal sync,
  agent-drivable / LLM-automatable application design
- **Other:** open-source maintenance, license compliance gating, monorepo (pnpm + Cargo)

---

## 8. Role-tailoring notes (for the agent)

Re-weight the bullets depending on the target role:

- **Automotive / ADAS / robotics:** lead with MCAP/MF4 support, CAN/IMU/GPS signal
  sync, the nanosecond clock, and ODD tagging. De-emphasise frontend specifics.
- **Frontend / web:** lead with React 19 / TypeScript, the panel/docking UI, smooth
  4K playback, and the performance budget. Keep Rust/WASM as a supporting highlight.
- **Systems / Rust / WASM:** lead with the portable Rust core, WASM size budget, Arrow
  IPC across the language boundary, and worker architecture.
- **AI / agent / LLM tooling:** lead with the "agent-drivable by default" design, the
  `window.__drivelineAgent` automation surface, and the vision-model ODD-tagging demo.

Keep claims to what's listed here — all of it is verifiable from the repo and the live
deployment at https://driveline.pages.dev.
