// Module-scoped bridge to the live FlexLayout workspace, mirroring
// `panels/videoCanvasRegistry.ts`: the `Workspace` component registers its
// imperative handle on mount and clears it on unmount, so non-React callers
// (the `?agent` write ops in `agent/agentApi.ts`, and — sharing the same
// seam — the dev hooks in `App.tsx`) can create/close panels against the
// FlexLayout `Model` without a React Context provider (CLAUDE.md forbids
// adding one) and without reaching into the model directly.
//
// The bridge intentionally exposes only what panel mutation needs: mint a
// panel of a given kind (returning the freshly-minted panel id), close a
// panel by id, and reset the layout. Channel/binding mutation stays on the
// Zustand store actions — the bridge is the *layout* seam only.

import type { PanelKind } from "./panelId";

export interface WorkspaceBridge {
  /** Mint a panel of `kind`, returning its freshly-minted panel id (or
   *  `undefined` if no tabset could host it). `video` accepts an optional
   *  channel id to pre-bind, matching `WorkspaceHandle.addVideoPanel`. */
  createPanel(kind: PanelKind, channelId?: string): string | undefined;
  /** Delete the tab with `panelId` from the model. Returns `true` if the
   *  tab existed and was removed, `false` otherwise. */
  closePanel(panelId: string): boolean;
  /** Reset the FlexLayout model to the default split. */
  resetLayout(): void;
}

let bridge: WorkspaceBridge | null = null;

/** `Workspace` registers its handle on mount; the returned cleanup clears
 *  it on unmount (only if it is still the active bridge). */
export function setWorkspaceBridge(next: WorkspaceBridge): () => void {
  bridge = next;
  return () => {
    if (bridge === next) bridge = null;
  };
}

/** The live bridge, or `null` before the `Workspace` has mounted. */
export function getWorkspaceBridge(): WorkspaceBridge | null {
  return bridge;
}
