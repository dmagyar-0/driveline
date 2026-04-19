// T6.2 · Default FlexLayout model — one 50/50 horizontal split with a
// VideoPanel tab on the left and a PlotPanel tab on the right, matching
// the app-shell diagram in `docs/06-ui-and-panels.md:17-34`. The tab ids
// are stable so the store's binding maps survive a "reset to default".

import type { IJsonModel } from "flexlayout-react";

export const DEFAULT_VIDEO_PANEL_ID = "video-1";
export const DEFAULT_PLOT_PANEL_ID = "plot-1";

export const PANEL_COMPONENT_VIDEO = "video" as const;
export const PANEL_COMPONENT_PLOT = "plot" as const;
export type PanelComponent =
  | typeof PANEL_COMPONENT_VIDEO
  | typeof PANEL_COMPONENT_PLOT;

export const defaultLayoutModel: IJsonModel = {
  global: {
    tabEnableClose: true,
    tabEnableRename: false,
    splitterSize: 4,
    borderEnableAutoHide: true,
  },
  borders: [],
  layout: {
    type: "row",
    weight: 100,
    children: [
      {
        type: "tabset",
        weight: 50,
        children: [
          {
            type: "tab",
            id: DEFAULT_VIDEO_PANEL_ID,
            name: "Video",
            component: PANEL_COMPONENT_VIDEO,
          },
        ],
      },
      {
        type: "tabset",
        weight: 50,
        children: [
          {
            type: "tab",
            id: DEFAULT_PLOT_PANEL_ID,
            name: "Plot",
            component: PANEL_COMPONENT_PLOT,
          },
        ],
      },
    ],
  },
};
