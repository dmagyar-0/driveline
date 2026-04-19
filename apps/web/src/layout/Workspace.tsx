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
  type IJsonModel,
  type IJsonTabNode,
} from "flexlayout-react";
import "flexlayout-react/style/dark.css";
import { useSession } from "../state/store";
import {
  PANEL_COMPONENT_PLOT,
  PANEL_COMPONENT_VIDEO,
  defaultLayoutModel,
} from "./defaultLayout";
import { panelFactory } from "./panelFactory";
import styles from "./Workspace.module.css";

export interface WorkspaceHandle {
  addVideoPanel(channelId?: string): string | undefined;
  addPlotPanel(): string | undefined;
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
      setLayoutJson(m.toJson());
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
      const id = newPanelId("video");
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
    const id = newPanelId("plot");
    return addTab({
      type: "tab",
      id,
      name: "Plot",
      component: PANEL_COMPONENT_PLOT,
    });
  }, [addTab]);

  const resetLayout = useCallback(() => {
    setLayoutJson(null);
  }, [setLayoutJson]);

  useImperativeHandle(
    ref,
    () => ({ addVideoPanel, addPlotPanel, resetLayout }),
    [addVideoPanel, addPlotPanel, resetLayout],
  );

  // If the user has somehow closed every tab (FlexLayout does allow an
  // empty tabset), show an escape hatch.
  const rootEmpty = model.getRoot().getChildren().length === 0;

  return (
    <section className={styles.workspace} data-testid="workspace">
      <div className={styles.toolbar} data-testid="workspace-toolbar">
        <button
          type="button"
          className={styles.toolbarBtn}
          onClick={() => addVideoPanel()}
          data-testid="add-video-panel"
        >
          + Video panel
        </button>
        <button
          type="button"
          className={styles.toolbarBtn}
          onClick={() => addPlotPanel()}
          data-testid="add-plot-panel"
        >
          + Plot panel
        </button>
        <button
          type="button"
          className={styles.toolbarBtnSecondary}
          onClick={resetLayout}
          data-testid="reset-layout"
          title="Reset to the default video+plot split"
        >
          Reset layout
        </button>
      </div>
      <div className={styles.flexContainer}>
        {rootEmpty ? (
          <div className={styles.emptyShell} data-testid="workspace-empty">
            <p>No panels open.</p>
            <button
              type="button"
              className={styles.toolbarBtn}
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
          />
        )}
      </div>
    </section>
  );
});
