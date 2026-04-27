// T6.2 · FlexLayout workspace shell.
//
// Holds the `flexlayout-react` Model, wires user drag-rearrange actions
// back into `useSession.setLayoutJson` via `onModelChange`, and exposes
// imperative `addVideoPanel` / `addPlotPanel` / `resetLayout` methods so
// the top-bar `+` buttons (and dev hooks for future e2e) can add panels
// without having to know the internal `Model` API.
//
// Layout JSON round-trips through the store. The persistence adapter in
// `./persist.ts` then fans `layoutJson` + `videoBindings` + `plotBindings`
// out to `localStorage[driveline.layout.v1]`. A mismatched schema or a
// missing storage bucket falls back to `defaultLayoutModel`.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Actions,
  DockLocation,
  Layout,
  Model,
  type BorderNode,
  type IJsonModel,
  type IJsonTabNode,
  type ITabRenderValues,
  type ITabSetRenderValues,
  type TabNode,
  type TabSetNode,
} from "flexlayout-react";
import "flexlayout-react/style/dark.css";
import { useSession } from "../state/store";
import {
  PANEL_COMPONENT_ENUM,
  PANEL_COMPONENT_MAP,
  PANEL_COMPONENT_PLOT,
  PANEL_COMPONENT_SCENE,
  PANEL_COMPONENT_TABLE,
  PANEL_COMPONENT_VIDEO,
  defaultLayoutModel,
} from "./defaultLayout";
import { panelFactory } from "./panelFactory";
import {
  ENUM_PREFIX,
  MAP_PREFIX,
  PLOT_PREFIX,
  SCENE_PREFIX,
  TABLE_PREFIX,
  VIDEO_PREFIX,
  kindLabel,
  panelKindOf,
} from "./panelId";
import styles from "./Workspace.module.css";

export interface WorkspaceHandle {
  addVideoPanel(channelId?: string): string | undefined;
  addPlotPanel(): string | undefined;
  addScenePanel(): string | undefined;
  addMapPanel(): string | undefined;
  addTablePanel(): string | undefined;
  addEnumPanel(): string | undefined;
  resetLayout(): void;
}

function newPanelId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${rand}`;
}

function buildModel(json: unknown | null): Model {
  const source = (json as IJsonModel | null) ?? defaultLayoutModel;
  try {
    return Model.fromJson(source);
  } catch {
    // Malformed stored layout — fall back to the default so the app still
    // boots. Persistence will rewrite on the next mutation.
    return Model.fromJson(defaultLayoutModel);
  }
}

export const Workspace = forwardRef<WorkspaceHandle>(function Workspace(_, ref) {
  const layoutJson = useSession((s) => s.layoutJson);
  const setLayoutJson = useSession((s) => s.setLayoutJson);
  const setVideoBinding = useSession((s) => s.setVideoBinding);

  // We keep a single Model instance for the component lifetime. Normal
  // user actions (drag, close) flow through `doAction` and fire
  // `onModelChange`. A dev-hook / reset that swaps `layoutJson` wholesale
  // bumps `reloadKey` so we rebuild the Model from the new JSON.
  const [reloadKey, setReloadKey] = useState(0);
  const ignoreNextChangeRef = useRef(false);
  const model = useMemo(
    () => buildModel(layoutJson),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reloadKey],
  );

  // If the store's `layoutJson` changes out from under us (dev hook,
  // reset button, another tab) and does not match the JSON we most
  // recently used to (re)build the Model, rebuild. Depending only on the
  // stringified layoutJson avoids a render loop: FlexLayout's
  // `Model.fromJson(X).toJson()` is not an identity, so comparing to the
  // live model's JSON can re-fire this effect indefinitely.
  const lastBuiltJsonRef = useRef<string>(
    JSON.stringify(layoutJson ?? defaultLayoutModel),
  );
  useEffect(() => {
    const next = JSON.stringify(layoutJson ?? defaultLayoutModel);
    if (next === lastBuiltJsonRef.current) return;
    lastBuiltJsonRef.current = next;
    ignoreNextChangeRef.current = true;
    setReloadKey((k) => k + 1);
  }, [layoutJson]);

  const onModelChange = useCallback(
    (m: Model) => {
      if (ignoreNextChangeRef.current) {
        ignoreNextChangeRef.current = false;
        return;
      }
      const json = m.toJson();
      // Stamp the last-built ref with the exact payload we're about to push
      // into the store. Otherwise the layoutJson effect sees the round-trip
      // diff (FlexLayout normalises on tab-select / drag) and rebuilds the
      // Model — which unmounts every panel and wipes their local React
      // state (hudOn, scroll offsets, …). The rebuild path is only for
      // out-of-band writes (dev hook, reset button, another tab).
      lastBuiltJsonRef.current = JSON.stringify(json);
      setLayoutJson(json);
    },
    [setLayoutJson],
  );

  const addTab = useCallback(
    (tab: IJsonTabNode): string | undefined => {
      const active = model.getActiveTabset();
      const targetId = active?.getId() ?? model.getFirstTabSet()?.getId();
      if (!targetId) {
        // No tabset exists (user closed everything). Drop the tab into a
        // fresh tabset at the root by docking to CENTER on the root row.
        const rootId = model.getRoot().getId();
        model.doAction(
          Actions.addNode(tab, rootId, DockLocation.CENTER, -1, true),
        );
      } else {
        model.doAction(
          Actions.addNode(tab, targetId, DockLocation.CENTER, -1, true),
        );
      }
      setLayoutJson(model.toJson());
      return tab.id;
    },
    [model, setLayoutJson],
  );

  const addVideoPanel = useCallback(
    (channelId?: string) => {
      const id = newPanelId(VIDEO_PREFIX);
      if (channelId) setVideoBinding(id, channelId);
      return addTab({
        type: "tab",
        id,
        name: "Video",
        component: PANEL_COMPONENT_VIDEO,
      });
    },
    [addTab, setVideoBinding],
  );

  const addPlotPanel = useCallback(() => {
    const id = newPanelId(PLOT_PREFIX);
    return addTab({
      type: "tab",
      id,
      name: "Plot",
      component: PANEL_COMPONENT_PLOT,
    });
  }, [addTab]);

  const addScenePanel = useCallback(() => {
    const id = newPanelId(SCENE_PREFIX);
    return addTab({
      type: "tab",
      id,
      name: "Scene",
      component: PANEL_COMPONENT_SCENE,
    });
  }, [addTab]);

  const addMapPanel = useCallback(() => {
    const id = newPanelId(MAP_PREFIX);
    return addTab({
      type: "tab",
      id,
      name: "Map",
      component: PANEL_COMPONENT_MAP,
    });
  }, [addTab]);

  const addTablePanel = useCallback(() => {
    const id = newPanelId(TABLE_PREFIX);
    return addTab({
      type: "tab",
      id,
      name: "Table",
      component: PANEL_COMPONENT_TABLE,
    });
  }, [addTab]);

  const addEnumPanel = useCallback(() => {
    const id = newPanelId(ENUM_PREFIX);
    return addTab({
      type: "tab",
      id,
      name: "Enum",
      component: PANEL_COMPONENT_ENUM,
    });
  }, [addTab]);

  const resetLayout = useCallback(() => {
    setLayoutJson(null);
  }, [setLayoutJson]);

  // Phase 7 · Custom tab chrome. Replace FlexLayout's stock tab content
  // with grip + name + kind badge + four-icon cluster (settings,
  // collapse [disabled], maximize, close). The cluster is **always**
  // rendered (no hover/selection predicate) per the wireframe and the
  // frontend skill's "thing disappears when status changes" trap.
  // Settings click flips the rail to the Panel drawer for the clicked
  // tab; maximize/close dispatch stock FlexLayout actions.
  const onRenderTab = useCallback(
    (node: TabNode, renderValues: ITabRenderValues) => {
      const panelId = node.getId();
      const kind = panelKindOf(panelId);
      const tabsetId = node.getParent()?.getId();
      renderValues.buttons = [];
      renderValues.content = (
        <span className={styles.tab}>
          <span className={styles.tabGrip} aria-hidden="true">
            <GripIcon />
          </span>
          <span className={styles.tabName} title={node.getName()}>
            {node.getName()}
          </span>
          {kind !== null && (
            <span
              className={styles.tabKind}
              data-testid="tab-kind-badge"
            >
              {kindLabel(kind)}
            </span>
          )}
          <span className={styles.tabActions}>
            <button
              type="button"
              className={styles.tabActionBtn}
              aria-label="Configure panel"
              data-testid="tab-settings"
              onPointerDown={stopPointer}
              onClick={(e) => {
                e.stopPropagation();
                const st = useSession.getState();
                st.setSelectedPanelId(panelId);
                st.setActiveRailTab("panel");
              }}
            >
              <SettingsIcon />
            </button>
            <button
              type="button"
              className={`${styles.tabActionBtn} ${styles.tabActionDisabled}`}
              aria-label="Collapse panel — coming soon"
              aria-disabled="true"
              tabIndex={-1}
              title="Collapse — coming in a later phase"
              data-testid="tab-collapse"
              onPointerDown={stopPointer}
              onClick={(e) => e.stopPropagation()}
            >
              <CollapseIcon />
            </button>
            <button
              type="button"
              className={styles.tabActionBtn}
              aria-label="Maximize panel"
              data-testid="tab-maximize"
              onPointerDown={stopPointer}
              onClick={(e) => {
                e.stopPropagation();
                if (!tabsetId) return;
                model.doAction(Actions.maximizeToggle(tabsetId));
              }}
            >
              <MaximizeIcon />
            </button>
            <button
              type="button"
              className={styles.tabActionBtn}
              aria-label="Close panel"
              data-testid="tab-close"
              onPointerDown={stopPointer}
              onClick={(e) => {
                e.stopPropagation();
                model.doAction(Actions.deleteTab(panelId));
              }}
            >
              <CloseIcon />
            </button>
          </span>
        </span>
      );
    },
    [model],
  );

  const onRenderTabSet = useCallback(
    (_node: TabSetNode | BorderNode, _renderValues: ITabSetRenderValues) => {
      // Single-tab tabsets already match the wireframe — leave the
      // tabset action cluster (the maximize/restore button on the right
      // edge) alone for now. Hook reserved for later phases.
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      addVideoPanel,
      addPlotPanel,
      addScenePanel,
      addMapPanel,
      addTablePanel,
      addEnumPanel,
      resetLayout,
    }),
    [
      addVideoPanel,
      addPlotPanel,
      addScenePanel,
      addMapPanel,
      addTablePanel,
      addEnumPanel,
      resetLayout,
    ],
  );

  // If the user has somehow closed every tab (FlexLayout does allow an
  // empty tabset), show an escape hatch.
  const rootEmpty = model.getRoot().getChildren().length === 0;

  return (
    <section className={styles.workspace} data-testid="workspace">
      <div className={styles.flexContainer}>
        {rootEmpty ? (
          <div className={styles.emptyShell} data-testid="workspace-empty">
            <p>No panels open.</p>
            <button
              type="button"
              className={styles.restoreBtn}
              onClick={resetLayout}
            >
              Restore default layout
            </button>
          </div>
        ) : (
          <Layout
            key={reloadKey}
            model={model}
            factory={panelFactory}
            onModelChange={onModelChange}
            onRenderTab={onRenderTab}
            onRenderTabSet={onRenderTabSet}
          />
        )}
      </div>
    </section>
  );
});

// FlexLayout's default `onPointerDown` on a tab activates / drags it.
// We want the per-button clicks inside the tab chrome to act locally
// without also seeding a drag, so block pointerdown bubbling on every
// icon button.
function stopPointer(e: React.PointerEvent) {
  e.stopPropagation();
}

function GripIcon() {
  return (
    <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
      <circle cx="2" cy="3" r="1" />
      <circle cx="6" cy="3" r="1" />
      <circle cx="2" cy="7" r="1" />
      <circle cx="6" cy="7" r="1" />
      <circle cx="2" cy="11" r="1" />
      <circle cx="6" cy="11" r="1" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6l5-3 5 3" />
      <path d="M3 13h10" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3h4M3 3v4M13 3h-4M13 3v4M3 13h4M3 13v-4M13 13h-4M13 13v-4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}
