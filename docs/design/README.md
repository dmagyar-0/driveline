# Driveline design

This folder holds the shell redesign source-of-truth and the migration plan
that breaks it down into shippable phases.

## Layout

```
docs/design/
├── README.md                       (this file)
├── v1-shell-integration.md         migration plan — read this to implement
└── wireframe-bundle/               raw bundle exported from claude.ai/design
    ├── README.md                   (the design tool's own "READ THIS FIRST")
    ├── chats/chat1.md              full design conversation — captures intent
    └── project/                    HTML prototype + CSS + JSX components
        ├── Driveline Wireframes.html
        ├── tokens.css              canonical design tokens (1:1 with the
        │                            existing dark theme — single source of
        │                            truth going forward)
        ├── wireframes.css          wireframe styling for the prototype
        ├── wf-app.jsx              prototype root (renders V1 only)
        ├── wf-parts.jsx            building blocks: Rail, Drawer, TopBar,
        │                            Panel, panel-content stubs, Transport
        ├── wf-variants.jsx         the V1 layout
        ├── design-canvas.jsx       claude.ai/design canvas wrapper (not
        │                            relevant to production)
        ├── tweaks-panel.jsx        prototype-only live tweaks panel
        ├── assets/                 production-ready SVG marks
        │   ├── logo.svg            mirrored to apps/web/public/brand/logo.svg
        │   ├── wordmark.svg        mirrored to apps/web/public/brand/wordmark.svg
        │   └── favicon.svg         mirrored to apps/web/public/brand/favicon.svg
        └── uploads/                user's original sketch input
```

## How to consume the bundle

1. Start with `wireframe-bundle/chats/chat1.md` — the user iterated through
   four variants and landed on **V1 (VS Code-style left rail)** with explicit
   tweaks (neutral hover-gray selected-panel border, official rounded-tile
   logo). The chat is where intent lives.
2. Then read `wireframe-bundle/project/Driveline Wireframes.html` and follow
   its imports to understand the shell composition.
3. Then read `v1-shell-integration.md` for the phased migration plan into
   `apps/web/`.

The bundle's own README (`wireframe-bundle/README.md`) is preserved verbatim
because it contains useful framing from the design assistant ("the chat is
where the intent lives, the HTML is the output"). Its instruction to read the
chat first still applies.

## What's already in the repo

- **`apps/web/public/brand/{logo,wordmark,favicon}.svg`** — the production
  copies of the brand marks. Not yet referenced from `apps/web/index.html` or
  any component; that wiring is part of Phase 0 of the migration plan.
- **This folder** — design reference and plan.

## What's NOT yet in the repo

The actual shell rewrite (rail, drawers, panel chrome via `onRenderTab`,
bookmarks, named layouts, new panel kinds). Each phase in
`v1-shell-integration.md` describes one shippable slice.
