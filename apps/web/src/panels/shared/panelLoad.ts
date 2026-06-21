// Shared panel load-state model.
//
// Data panels move through the same lifecycle: nothing bound yet (idle), a
// fetch in flight (loading), a decode/fetch failure (error), or decoded data
// ready (ready). MapPanel and ScenePanel already modelled this as a
// discriminated union so their render branches were explicit; the scalar
// panels (Table/Value/Enum) used to infer "loading vs error vs empty" from an
// array length, which couldn't distinguish "still loading" from "no data" and
// silently swallowed dtype mismatches. This is the shared shape they align to.

export type PanelLoad<T> =
  | { status: "idle" } // nothing bound / no range yet
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T };

export const LOAD_IDLE: PanelLoad<never> = { status: "idle" };
export const LOAD_LOADING: PanelLoad<never> = { status: "loading" };

export function loadError(error: string): PanelLoad<never> {
  return { status: "error", error };
}

export function loadReady<T>(data: T): PanelLoad<T> {
  return { status: "ready", data };
}

/** Decoded data when ready, else `null`. */
export function loadData<T>(load: PanelLoad<T>): T | null {
  return load.status === "ready" ? load.data : null;
}
