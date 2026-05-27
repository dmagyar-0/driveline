// Layout drawer · two sections:
//   - Saved layouts: rows from the `namedLayouts` slice. Click = restore.
//     The `live` meta pill fires when the saved layoutJson stringifies
//     to the same value as the current layoutJson.
//   - Add panel: mints a new panel of the chosen kind.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../state/store";
import drawerStyles from "../Drawer.module.css";
import { DRAWER_REGION_ID } from "../Drawer";
import s from "./LayoutDrawer.module.css";

const HEADING_SAVED_ID = "drawer-layout-saved-h";
const HEADING_ADD_ID = "drawer-layout-add-h";

interface Props {
  /** Forwarded from App via Shell → Drawer because the FlexLayout
   *  `WorkspaceHandle` lives on App's ref. */
  addVideoPanel: () => void;
  addPlotPanel: () => void;
  addScenePanel: () => void;
  addMapPanel: () => void;
  addTablePanel: () => void;
  addEnumPanel: () => void;
  /** Resets the FlexLayout model to the default split. */
  resetLayout: () => void;
}

interface AddRow {
  label: string;
  testid: string;
  onClick: () => void;
}

export function LayoutDrawer({
  addVideoPanel,
  addPlotPanel,
  addScenePanel,
  addMapPanel,
  addTablePanel,
  addEnumPanel,
  resetLayout,
}: Props) {
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

  const onRestore = (id: string) => useSession.getState().restoreNamedLayout(id);
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
              const isLive = JSON.stringify(l.layoutJson ?? null) === currentJsonStr;
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
          {(
            [
              { label: "+ video", testid: "add-video-panel", onClick: addVideoPanel },
              { label: "+ plot", testid: "add-plot-panel", onClick: addPlotPanel },
              { label: "+ 3D scene", testid: "add-scene-panel", onClick: addScenePanel },
              { label: "+ map", testid: "add-map-panel", onClick: addMapPanel },
              { label: "+ table", testid: "add-table-panel", onClick: addTablePanel },
              { label: "+ enum", testid: "add-enum-panel", onClick: addEnumPanel },
            ] as readonly AddRow[]
          ).map((row) => (
            <li key={row.testid}>
              <button
                type="button"
                className={s.addRow}
                onClick={row.onClick}
                data-testid={row.testid}
              >
                {row.label}
              </button>
            </li>
          ))}
        </ul>

        <button
          type="button"
          className={s.resetRow}
          onClick={resetLayout}
          data-testid="reset-layout"
        >
          Reset layout
        </button>
      </section>
    </aside>
  );
}
