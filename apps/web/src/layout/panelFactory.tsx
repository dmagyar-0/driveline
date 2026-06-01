// T6.2 · FlexLayout `factory` function. Each tab's `component` string in
// the layout JSON maps to one React container; the container owns the
// panel-id-keyed lookup into the store's binding maps (per
// `docs/06-ui-and-panels.md:165-167`). Phase 6 added the four new panel
// kinds (scene / map / table / enum). Phase 7 added the click-to-select
// wrapper so any pointerdown inside a panel marks it as the active
// panel for the Panel drawer.

import type { TabNode } from "flexlayout-react";
import { PlotPanel } from "../panels/PlotPanel";
import { VideoPanelContainer } from "../panels/VideoPanelContainer";
import { ScenePanel } from "../panels/ScenePanel";
import { MapPanel } from "../panels/MapPanel";
import { TablePanel } from "../panels/TablePanel";
import { ValuePanel } from "../panels/ValuePanel";
import { EnumPanel } from "../panels/EnumPanel";
import { useSession } from "../state/store";
import {
  PANEL_COMPONENT_ENUM,
  PANEL_COMPONENT_MAP,
  PANEL_COMPONENT_PLOT,
  PANEL_COMPONENT_SCENE,
  PANEL_COMPONENT_TABLE,
  PANEL_COMPONENT_VALUE,
  PANEL_COMPONENT_VIDEO,
} from "./defaultLayout";
import styles from "./panelFactory.module.css";

export function panelFactory(node: TabNode): React.ReactNode {
  const component = node.getComponent();
  const panelId = node.getId();
  return (
    <div
      className={styles.panelBody}
      data-testid={`panel-body-${panelId}`}
      onPointerDown={() => {
        useSession.getState().setSelectedPanelId(panelId);
      }}
    >
      {renderPanel(component, panelId)}
    </div>
  );
}

function renderPanel(
  component: string | undefined,
  panelId: string,
): React.ReactNode {
  switch (component) {
    case PANEL_COMPONENT_VIDEO:
      return <VideoPanelContainer panelId={panelId} />;
    case PANEL_COMPONENT_PLOT:
      return <PlotPanel panelId={panelId} />;
    case PANEL_COMPONENT_SCENE:
      return <ScenePanel panelId={panelId} />;
    case PANEL_COMPONENT_MAP:
      return <MapPanel panelId={panelId} />;
    case PANEL_COMPONENT_TABLE:
      return <TablePanel panelId={panelId} />;
    case PANEL_COMPONENT_VALUE:
      return <ValuePanel panelId={panelId} />;
    case PANEL_COMPONENT_ENUM:
      return <EnumPanel panelId={panelId} />;
    default:
      return (
        <div data-testid="unknown-panel" style={{ padding: "1rem" }}>
          Unknown panel type: {String(component)}
        </div>
      );
  }
}
