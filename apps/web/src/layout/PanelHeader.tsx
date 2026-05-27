// Custom tab header injected via FlexLayout's `onRenderTab`.
// Layout: [drag-handle] [kind icon] [name/rename input] [settings]
//         [maximize] [hairline divider] [close]
// The whole row is rendered into FlexLayout's tab strip, so pointerdown
// on the grip/name area flows through to FlexLayout and initiates a
// drag. The action cluster stops pointerdown locally so per-button
// clicks don't seed a tab drag.

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
   * the maximize/restore-down icon swap and the tooltip. Optional so
   * older call sites and unit tests can omit it.
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

  // Title double-click: rename when the panel is already focused
  // (click-to-focus, double-click-to-rename), maximize otherwise.
  const onTitleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
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

  // Pointerdown on the header (other than a button) marks this panel
  // as focused — same write `panelFactory.tsx` does on body pointerdown.
  // FlexLayout still receives the event for tab selection / drag start.
  const onHeaderPointerDown = useCallback(() => {
    if (isFocused) return;
    useSession.getState().setSelectedPanelId(panelId);
  }, [isFocused, panelId]);

  // Unknown panels (orphans / legacy ids) get the neutral border;
  // the inline style passes the CSS variable name through to the module.
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
      data-focused={isFocused ? "true" : "false"}
      style={accentStyle}
      onPointerDown={onHeaderPointerDown}
    >
      {/* Six-dot drag glyph — visual cue only. The actual drag flows
       * through the surrounding FlexLayout tab button. */}
      <span
        className={styles.dragHandle}
        aria-hidden="true"
        title="Drag to move panel"
        data-testid="tab-drag-handle"
      >
        <DragHandleIcon />
      </span>
      {kind !== null && (
        <span
          className={styles.kindIcon}
          aria-hidden="true"
          title={`${kindLabel} panel — drag to move`}
        >
          <PanelTypeIcon kind={kind} />
        </span>
      )}
      {/* The kind glyph is decorative (aria-hidden); surface the kind
       * to screen readers via this sibling span so a "Speeds" Video
       * tab is distinguishable from a "Speeds" Plot tab. */}
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
        {/* Cluster: settings, maximize, (divider), close. Rename is a
         * subset of settings — invoked by double-clicking the focused
         * title rather than a dedicated pencil button. */}
        <button
          type="button"
          className={styles.actionBtn}
          aria-label="Panel settings"
          title="Panel settings (double-click title to rename)"
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
        {/* Hairline separator keeps the destructive close action a Fitts
         * threshold away from maximize. */}
        <span
          className={styles.actionDivider}
          aria-hidden="true"
          data-testid="tab-action-divider"
        />
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

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

/** Restore-down: peeked-out back square + full front square. */
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
      <path d="M5.5 4.5V3a.5.5 0 01.5-.5h7a.5.5 0 01.5.5v7a.5.5 0 01-.5.5H12" />
      <rect x="2.5" y="5.5" width="9" height="8" rx="0.5" />
    </svg>
  );
}

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

function DragHandleIcon(): React.ReactElement {
  return (
    <svg
      width="10"
      height="14"
      viewBox="0 0 10 14"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="3" cy="3" r="1" />
      <circle cx="7" cy="3" r="1" />
      <circle cx="3" cy="7" r="1" />
      <circle cx="7" cy="7" r="1" />
      <circle cx="3" cy="11" r="1" />
      <circle cx="7" cy="11" r="1" />
    </svg>
  );
}

