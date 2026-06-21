// Phase 4 · Layout drawer.
//
// Replaces the inline `layout` stub in `Drawer.tsx`. Two sections:
//
//   - Saved layouts: rows from the new `namedLayouts` slice. Click =
//     restore. The active row (matching `activeNamedLayoutId`) gets the
//     orange-bordered `.rowActive` style; the `live` meta pill fires
//     when the saved layoutJson stringifies to the same value as the
//     current layoutJson.
//   - Add panel: replaces the legacy `Workspace.tsx` toolbar (`+ Video
//     panel`, `+ Plot panel`, `Reset layout`) and previews the four
//     Phase-6 kinds as disabled rows.
//
// Reads from the store via discrete single-key selectors so the drawer
// only re-renders when the relevant fields change. The save-as inline
// input is local `useState` (no store coupling).

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../state/store";
import type { PanelKind } from "../../layout/panelId";
import { getWorkspaceBridge } from "../../layout/workspaceBridge";
import { PanelKindIcon, panelKindName } from "../../layout/PanelKindIcon";
import drawerStyles from "../Drawer.module.css";
import { DRAWER_REGION_ID } from "../Drawer";
import s from "./LayoutDrawer.module.css";

const HEADING_SAVED_ID = "drawer-layout-saved-h";
const HEADING_ADD_ID = "drawer-layout-add-h";

// Every add-panel kind shown in the drawer, with the testid the e2e specs
// pin. Each row mints through the single `workspaceBridge.createPanel`
// seam — no per-kind callbacks threaded from `App.tsx`.
const ADD_ROWS: readonly { kind: PanelKind; testid: string }[] = [
  { kind: "video", testid: "add-video-panel" },
  { kind: "plot", testid: "add-plot-panel" },
  { kind: "scene", testid: "add-scene-panel" },
  { kind: "map", testid: "add-map-panel" },
  { kind: "table", testid: "add-table-panel" },
  { kind: "value", testid: "add-value-panel" },
  { kind: "enum", testid: "add-enum-panel" },
];

export function LayoutDrawer() {
  const layoutJson = useSession((st) => st.layoutJson);
  const namedLayouts = useSession((st) => st.namedLayouts);
  const activeId = useSession((st) => st.activeNamedLayoutId);

  const [pendingName, setPendingName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Stringify the current layoutJson once per render so the live-pill
  // compare is O(n) per saved row rather than O(n*m).
  const currentJsonStr = useMemo(
    () => JSON.stringify(layoutJson ?? null),
    [layoutJson],
  );

  useEffect(() => {
    if (pendingName !== null) inputRef.current?.focus();
  }, [pendingName]);

  const onStartSave = () => setPendingName("");

  const onCommitSave = () => {
    if (pendingName === null) return;
    const trimmed = pendingName.trim();
    if (trimmed === "") {
      // Empty name: keep the input focused, don't dismiss.
      inputRef.current?.focus();
      return;
    }
    useSession.getState().saveCurrentLayoutAs(trimmed);
    setPendingName(null);
  };

  const onCancelSave = () => setPendingName(null);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onCommitSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancelSave();
    }
  };

  const onRestore = (id: string) =>
    useSession.getState().restoreNamedLayout(id);
  const onRemove = (id: string) => useSession.getState().removeNamedLayout(id);

  return (
    <aside
      id={DRAWER_REGION_ID}
      className={drawerStyles.drawer}
      role="region"
      aria-labelledby={HEADING_SAVED_ID}
      data-testid="drawer-layout"
    >
      <section className={s.section}>
        <div className={drawerStyles.heading}>
          <h3 id={HEADING_SAVED_ID}>Saved layouts</h3>
          <span className={s.pill} data-testid="layouts-count-pill">
            {namedLayouts.length}
          </span>
        </div>

        {namedLayouts.length === 0 ? (
          <p className={s.empty}>No saved layouts</p>
        ) : (
          <ul className={s.list} data-testid="layouts-list">
            {namedLayouts.map((l) => {
              const isActive = activeId === l.id;
              const isLive =
                JSON.stringify(l.layoutJson ?? null) === currentJsonStr;
              return (
                <li key={l.id} className={s.rowItem}>
                  <button
                    type="button"
                    className={`${s.row} ${isActive ? s.rowActive : ""}`}
                    aria-pressed={isActive}
                    onClick={() => onRestore(l.id)}
                    data-testid={`layout-row-${l.id}`}
                  >
                    <span className={s.name} title={l.name}>
                      {l.name}
                    </span>
                    {isLive && (
                      <span className={s.liveTag} data-testid="layout-live">
                        live
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={s.removeBtn}
                    aria-label={`Remove saved layout ${l.name}`}
                    title="Remove"
                    onClick={() => onRemove(l.id)}
                    data-testid={`layout-remove-${l.id}`}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {pendingName === null ? (
          <button
            type="button"
            className={s.addRow}
            onClick={onStartSave}
            data-testid="layout-save-as-btn"
          >
            + save current as…
          </button>
        ) : (
          <div className={s.savePending} data-testid="layout-save-pending">
            <input
              ref={inputRef}
              type="text"
              className={s.nameInput}
              value={pendingName}
              placeholder="layout name"
              aria-label="Saved layout name"
              onChange={(e) => setPendingName(e.target.value)}
              onKeyDown={onInputKeyDown}
              data-testid="layout-save-input"
            />
            <button
              type="button"
              className={s.saveBtn}
              onClick={onCommitSave}
              data-testid="layout-save-confirm"
            >
              Save
            </button>
            <button
              type="button"
              className={s.cancelBtn}
              onClick={onCancelSave}
              aria-label="Cancel saving layout"
            >
              ×
            </button>
          </div>
        )}
      </section>

      <hr className={s.separator} />

      <section className={s.section} aria-labelledby={HEADING_ADD_ID}>
        <div className={drawerStyles.heading}>
          <h3 id={HEADING_ADD_ID}>Add panel</h3>
        </div>

        <ul className={s.addList} data-testid="layout-add-list">
          {ADD_ROWS.map((row) => (
            <li key={row.testid}>
              <button
                type="button"
                className={s.addRow}
                onClick={() => getWorkspaceBridge()?.createPanel(row.kind)}
                data-testid={row.testid}
              >
                <span className={s.addIcon}>
                  <PanelKindIcon kind={row.kind} size={16} />
                </span>
                <span>{panelKindName(row.kind)}</span>
              </button>
            </li>
          ))}
        </ul>

        <button
          type="button"
          className={s.resetRow}
          onClick={() => getWorkspaceBridge()?.resetLayout()}
          data-testid="reset-layout"
        >
          Reset layout
        </button>
      </section>
    </aside>
  );
}
