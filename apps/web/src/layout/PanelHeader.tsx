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
}

export function PanelHeader({
  model,
  panelId,
  tabsetId,
  name,
  kind,
  isFocused,
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
          title="Rename panel"
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
          aria-label="Configure panel"
          title="Configure panel"
          data-testid="tab-settings"
          onPointerDown={stopPointer}
          onClick={onSettings}
        >
          <SettingsIcon />
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          aria-label="Maximize panel"
          title="Maximize panel"
          data-testid="tab-maximize"
          onPointerDown={stopPointer}
          onClick={onMaximize}
        >
          <MaximizeIcon />
        </button>
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
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
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
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
      <path d="M3 3h4M3 3v4M13 3h-4M13 3v4M3 13h4M3 13v-4M13 13h-4M13 13v-4" />
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
      strokeWidth="1.6"
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
