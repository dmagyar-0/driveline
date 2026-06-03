// Shared HTML5 drag-and-drop contract for dragging a channel from the
// Channels drawer onto a drop-aware panel (currently the Plot panel).
//
// The payload is the channel's globally-unique id, carried under a custom
// MIME type so it never collides with a *file* drop: the shell's file
// loader keys off `dataTransfer.files`, which a custom-typed drag leaves
// empty. That separation lets the shell ignore channel drags entirely
// (see `App.tsx`) while panels opt in.
//
// Note the asymmetry the DnD spec forces on us: during `dragover`/
// `dragenter` the drag data store is in "protected mode" and `getData`
// returns "", but the `types` list is always readable. So a drop target
// decides whether to accept a drop from `hasChannelDrag` (reads `types`)
// and only reads the id itself in the `drop` handler.

export const CHANNEL_DND_MIME = "application/x-driveline-channel-id";

/** Stamp a channel id onto a drag's dataTransfer. Call from `dragstart`. */
export function setChannelDragData(dt: DataTransfer, channelId: string): void {
  dt.setData(CHANNEL_DND_MIME, channelId);
  // A text/plain mirror gives the drag a sensible textual payload for any
  // OS-level drop target; in-app targets read the typed entry above.
  dt.setData("text/plain", channelId);
  dt.effectAllowed = "copy";
}

/** Whether a drag carries a channel id. Safe to call in `dragover`/`drop`. */
export function hasChannelDrag(dt: DataTransfer | null | undefined): boolean {
  const types = dt?.types;
  if (types == null) return false;
  // `types` is a DOMStringList in some engines and a `string[]` in others;
  // `Array.from` normalises both (and a plain array used by tests).
  return Array.from(types).includes(CHANNEL_DND_MIME);
}

/** Read the dragged channel id. Call from `drop`; `null` when absent. */
export function getChannelDragData(
  dt: DataTransfer | null | undefined,
): string | null {
  if (dt == null) return null;
  const id = dt.getData(CHANNEL_DND_MIME);
  return id !== "" ? id : null;
}
