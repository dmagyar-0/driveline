// FlexLayout workspace shell. Holds the `flexlayout-react` Model, wires
// user drag-rearrange actions back into `useSession.setLayoutJson` via
// `onModelChange`, and exposes imperative add/reset methods so callers
// (top-bar buttons, dev hooks) don't have to know the Model API.
//
// Layout JSON round-trips through the store; `./persist.ts` fans
// `layoutJson` + binding maps out to `localStorage[driveline.layout.v1]`.
// A mismatched schema falls back to `defaultLayoutModel`.

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
  panelKindOf,
} from "./panelId";
import { PanelHeader } from "./PanelHeader";
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

export const Workspace = forwardRef<WorkspaceHandle>(
  function Workspace(_, ref) {
    const layoutJson = useSession((s) => s.layoutJson);
    const setLayoutJson = useSession((s) => s.setLayoutJson);
    const setVideoBinding = useSession((s) => s.setVideoBinding);
    // Narrow selector — never read the whole store — so a binding
    // change in another panel doesn't re-render every tab header.
    const selectedPanelId = useSession((s) => s.selectedPanelId);

    // Single Model instance for the component lifetime. User actions
    // (drag, close) flow through `doAction` → `onModelChange`. A
    // wholesale layout swap (dev hook, reset) bumps `reloadKey` so the
    // Model is rebuilt from the new JSON.
    const [reloadKey, setReloadKey] = useState(0);
    const ignoreNextChangeRef = useRef(false);
    const model = useMemo(
      () => buildModel(layoutJson),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [reloadKey],
    );

    // Out-of-band `layoutJson` writes (dev hook, reset, other tab)
    // rebuild the Model. We compare against the JSON most recently used
    // to build it, not against the live Model — FlexLayout's
    // `Model.fromJson(X).toJson()` is not the identity, so comparing
    // against `model.toJson()` would re-fire this effect forever.
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
        // Stamp the last-built ref so the layoutJson effect sees the
        // round-trip diff as expected and does NOT rebuild. Without
        // this stamp, FlexLayout's normalisation on tab-select / drag
        // would unmount every panel and wipe local React state. The
        // rebuild path is reserved for out-of-band writes.
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
          // No tabset exists (user closed everything) — dock to CENTER
          // on the root row so FlexLayout creates a fresh tabset.
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

    // Replace FlexLayout's stock tab content with `PanelHeader`. The
    // action cluster is always rendered (no hover/selection predicate)
    // per the frontend skill's "thing disappears when status changes"
    // anti-pattern.
    const onRenderTab = useCallback(
      (node: TabNode, renderValues: ITabRenderValues) => {
        const panelId = node.getId();
        const kind = panelKindOf(panelId);
        const parent = node.getParent();
        const tabsetId = parent?.getId();
        // Suppress FlexLayout's stock per-tab button cluster —
        // `PanelHeader` owns the close button now.
        renderValues.buttons = [];
        // Read the maximized state from the model so PanelHeader can
        // swap the glyph (square → restore-down) and tooltip in sync.
        const isMaximized =
          tabsetId !== undefined &&
          model.getMaximizedTabset()?.getId() === tabsetId;
        renderValues.content = (
          <PanelHeader
            model={model}
            panelId={panelId}
            tabsetId={tabsetId}
            name={node.getName()}
            kind={kind}
            isFocused={panelId === selectedPanelId}
            isMaximized={isMaximized}
          />
        );
      },
      [model, selectedPanelId],
    );

    const onRenderTabSet = useCallback(
      (_node: TabSetNode | BorderNode, _renderValues: ITabSetRenderValues) => {
        // Hook reserved for future tabset-level chrome.
      },
      [],
    );

    // Mirror the store's `selectedPanelId` into FlexLayout's "active
    // tabset" so the tabset picks up `flexlayout__tabset-selected`
    // styling. The store id is the source of truth — `panelFactory.tsx`
    // writes it on body pointerdown, the Panel drawer writes it on
    // pick, this effect mirrors it back. No-op when already in sync so
    // we don't loop with `onModelChange`.
    useEffect(() => {
      if (selectedPanelId === null) return;
      const node = model.getNodeById(selectedPanelId);
      if (!node) return;
      const parent = node.getParent();
      if (!parent || parent.getType() !== "tabset") return;
      const tabsetId = parent.getId();
      if (model.getActiveTabset()?.getId() === tabsetId) return;
      model.doAction(Actions.setActiveTabset(tabsetId));
    }, [model, selectedPanelId]);

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

    // FlexLayout allows an empty root — show an escape hatch.
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
  },
);
