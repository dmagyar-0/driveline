// T6.2 · FlexLayout `factory` function. Each tab's `component` string in
// the layout JSON maps to one React container; the container owns the
// panel-id-keyed lookup into the store's binding maps (per
// `docs/06-ui-and-panels.md:165-167`).

import type { TabNode } from "flexlayout-react";
import { PlotPanel } from "../panels/PlotPanel";
import { VideoPanelContainer } from "../panels/VideoPanelContainer";
import {
  PANEL_COMPONENT_PLOT,
  PANEL_COMPONENT_VIDEO,
} from "./defaultLayout";

export function panelFactory(node: TabNode): React.ReactNode {
  const component = node.getComponent();
  const panelId = node.getId();
  switch (component) {
    case PANEL_COMPONENT_VIDEO:
      return <VideoPanelContainer panelId={panelId} />;
    case PANEL_COMPONENT_PLOT:
      return <PlotPanel panelId={panelId} />;
    default:
      return (
        <div data-testid="unknown-panel" style={{ padding: "1rem" }}>
          Unknown panel type: {String(component)}
        </div>
      );
  }
}
