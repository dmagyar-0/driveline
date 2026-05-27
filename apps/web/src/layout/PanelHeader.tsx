// Phase 7+ · Custom tab header injected via FlexLayout's `onRenderTab`.
//
// Replaces the previous inline JSX in `Workspace.tsx` so the chrome can
// own its own behaviour: focus state, inline rename, double-click to
// maximize, accessible icon-only action buttons, and per-kind identity
// affordances (icon + 2-px coloured underline).
//
// The component is rendered into FlexLayout's tab strip via
// `renderValues.content`, so it lives *inside* the same draggable surface
// FlexLayout sets up for the tab — pointerdown on the grip / name area
// flows through to FlexLayout and initiates a drag. The action cluster
// stops pointerdown locally so per-button clicks don't seed a tab drag.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Actions, type Model } from "flexlayout-react";
import { useSession } from "../state/store";
import {
  PANEL_KIND_LABEL,
  PanelTypeIcon,
  panelKindAccentVar,
} from "./PanelTypeIcon";
import { type PanelKind } from "./panelId";
import styles from "./PanelHeader.module.css";

interface PanelHeaderProps {
  model: Model;
  panelId: string;
  tabsetId: string | undefined;
  name: string;
  kind: PanelKind | null;
  isFocused: boolean;
  /**
   * Whether the panel's tabset is currently the maximized one. Drives
   * the maximize/restore-down icon swap and the button's tooltip — the
   * "mystery square" review point was largely about a single static
   * icon that gave no hint of the toggle's current state. Optional so
   * older call sites (and the unit tests) can omit it and get the
   * default "not maximized" behaviour.
   */
  isMaximized?: boolean;
}

export function PanelHeader({
  model,
  panelId,
  tabsetId,
  name,
  kind,
  isFocused,
  isMaximized = false,
}: PanelHeaderProps): React.ReactElement {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the draft synced with the authoritative name when not editing —
  // a peer tab/drawer could rename via the store while this tab is idle.
  useEffect(() => {
    if (!renaming) setDraftName(name);
  }, [name, renaming]);

  // When rename mode opens, focus + select-all so the user can type.
  useLayoutEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const commitRename = useCallback(() => {
    const trimmed = draftName.trim();
    if (trimmed.length > 0 && trimmed !== name) {
      model.doAction(Actions.renameTab(panelId, trimmed));
    } else {
      // Empty input or unchanged — revert to the live name.
      setDraftName(name);
    }
    setRenaming(false);
  }, [draftName, model, name, panelId]);

  const cancelRename = useCallback(() => {
    setDraftName(name);
    setRenaming(false);
  }, [name]);

  // Title double-click toggles maximize unless it landed on the input
  // (which gets its own double-click → select-word behaviour). The
  // user opens rename via the dedicated rename button or the inline
  // input that appears after a single click on a focused tab — see
  // `onTitleDoubleClick` below: when the panel is the *selected* one
  // double-click enters rename, otherwise it maximises. This gives a
  // single gesture for both cases without a hidden mode switch.
  const onTitleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // Prefer rename when the panel is already focused so the gesture
      // is discoverable: click to focus, double-click to rename. From
      // an *un*focused tab the more useful action is maximize.
      if (isFocused) {
        setRenaming(true);
      } else if (tabsetId) {
        model.doAction(Actions.maximizeToggle(tabsetId));
      }
    },
    [isFocused, model, tabsetId],
  );

  const onMaximize = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (tabsetId) model.doAction(Actions.maximizeToggle(tabsetId));
    },
    [model, tabsetId],
  );

  const onClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      model.doAction(Actions.deleteTab(panelId));
    },
    [model, panelId],
  );

  const onSettings = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const st = useSession.getState();
      st.setSelectedPanelId(panelId);
      st.setActiveRailTab("panel");
    },
    [panelId],
  );

  const onRenameStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRenaming(true);
  }, []);

  // A single click anywhere in the header (other than a button) marks
  // this panel as the focused one — same write `panelFactory.tsx` does
  // on pointerdown in the body. Tab strip pointerdown still flows
  // through to FlexLayout so the tab is selected and a drag can start;
  // this just keeps the store-level selection in lockstep with the
  // visual focus state. No-op when the panel is already focused so we
  // don't churn the store on every header re-render.
  const onHeaderPointerDown = useCallback(() => {
    if (isFocused) return;
    useSession.getState().setSelectedPanelId(panelId);
  }, [isFocused, panelId]);

  // The accent underline only appears for known kinds; unknown panels
  // (orphans / legacy ids) get a neutral border. Inline style is
  // appropriate here because the value is a CSS custom property name
  // — layout-driven, not a theme colour pulled into TS.
  const accentStyle: React.CSSProperties | undefined =
    kind !== null
      ? { ["--panel-accent" as never]: panelKindAccentVar(kind) }
      : undefined;

  const kindLabel = kind !== null ? PANEL_KIND_LABEL[kind] : "Panel";

  return (
    <span
      className={`${styles.header} ${isFocused ? styles.focused : ""}`}
      data-panel-id={panelId}
      data-panel-kind={kind ?? "unknown"}
      style={accentStyle}
      onPointerDown={onHeaderPointerDown}
    >
      {kind !== null && (
        <span
          className={styles.kindIcon}
          aria-hidden="true"
          title={`${kindLabel} panel — drag to move`}
        >
          <PanelTypeIcon kind={kind} />
        </span>
      )}
      {/* a11y: the kind glyph is decorative (aria-hidden), so we
       *  surface the same identity to screen readers via a visually
       *  hidden span. Without this, a tab announces only the tab
       *  name — a screen-reader user can't tell a "Speeds" tab from
       *  a "Speeds" Video panel. */}
      {kind !== null && (
        <span className={styles.srOnly}>{kindLabel} panel:</span>
      )}
      {renaming ? (
        <input
          ref={inputRef}
          className={styles.nameInput}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelRename();
            }
          }}
          onPointerDown={stopPointer}
          onClick={(e) => e.stopPropagation()}
          aria-label="Rename panel"
          data-testid="tab-rename-input"
          maxLength={64}
        />
      ) : (
        <span
          className={styles.name}
          title={name}
          onDoubleClick={onTitleDoubleClick}
          data-testid="tab-name"
        >
          {name}
        </span>
      )}
      <span className={styles.actions}>
        <button
          type="button"
          className={styles.actionBtn}
          aria-label="Rename panel"
          title="Rename panel (double-click title)"
          data-testid="tab-rename"
          onPointerDown={stopPointer}
          onClick={onRenameStart}
          tabIndex={renaming ? -1 : 0}
        >
          <RenameIcon />
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          aria-label="Panel settings"
          title="Panel settings"
          data-testid="tab-settings"
          onPointerDown={stopPointer}
          onClick={onSettings}
        >
          <SettingsIcon />
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          aria-label={isMaximized ? "Restore panel" : "Maximize panel"}
          title={isMaximized ? "Restore panel" : "Maximize panel"}
          data-testid="tab-maximize"
          data-maximized={isMaximized ? "true" : "false"}
          aria-pressed={isMaximized}
          onPointerDown={stopPointer}
          onClick={onMaximize}
        >
          {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.actionBtnClose}`}
          aria-label="Close panel"
          title="Close panel"
          data-testid="tab-close"
          onPointerDown={stopPointer}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </span>
    </span>
  );
}

// FlexLayout's default `onPointerDown` on a tab activates / drags it.
// Per-button clicks inside the action cluster should act locally,
// without seeding a drag — stop pointerdown on the button itself.
function stopPointer(e: React.PointerEvent): void {
  e.stopPropagation();
}

/**
 * Standard gear / cog. The previous "settings" glyph was a sun (a
 * dot surrounded by 8 spokes) that the design audit flagged as
 * ambiguous — could read as theme, brightness, or "settings". A gear
 * is the universal control-panel glyph and disambiguates intent.
 */
function SettingsIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Classic Feather-style cog: a single closed path for the
       * eight-toothed outline, plus an inner circle for the hub.
       * 24×24 viewBox so the curves stay crisp at 14 px. The
       * previous sun (dot + 8 spokes) read as theme/brightness; a
       * recognisable gear disambiguates the "settings" intent. */}
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * Classic "maximize" frame: a solid square outline. Distinguishes
 * itself from the close × (two diagonal strokes) and from the restore
 * glyph (two overlapping squares). Tooltip swaps to "Restore" when
 * the tabset is already maximized.
 */
function MaximizeIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
    </svg>
  );
}

/**
 * Standard "restore down" glyph: the front square sits over a
 * peeked-out back square so the icon visibly differs from maximize.
 * Rendered only when `isMaximized` is true so the user can tell the
 * toggle's current state at a glance — no more "what does the square
 * do?" from the iter2 audit.
 */
function RestoreIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Back square (top-right corner peeking) */}
      <path d="M5.5 4.5V3a.5.5 0 01.5-.5h7a.5.5 0 01.5.5v7a.5.5 0 01-.5.5H12" />
      {/* Front square (full) */}
      <rect x="2.5" y="5.5" width="9" height="8" rx="0.5" />
    </svg>
  );
}

/**
 * Close × — heavier stroke and a hair larger viewport scaling via
 * `actionBtnClose` in CSS so it reads as the destructive action
 * even before the danger-tinted hover kicks in.
 */
function CloseIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

function RenameIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 11.5l7.5-7.5 2 2-7.5 7.5H3z" />
      <path d="M9.5 5l2 2" />
    </svg>
  );
}
