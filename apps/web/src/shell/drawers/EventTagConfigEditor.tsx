// Phase 8 · Event Tag config editor.
//
// Lives at the bottom of the EventsDrawer (collapsed by default). Edits
// the `eventTagConfig` attribute schema — the set of attributes
// (weather, road type, …) that every event can be tagged with — via the
// granular store actions, and supports import / export of the whole
// taxonomy as JSON so a team can share one config.
//
// Per-attribute name + type commit immediately. The `select` option list
// is edited as a comma-separated string held in local draft state and
// committed on blur, so typing a trailing comma/space doesn't fight the
// `options.join(", ")` re-derivation.

import { useRef, useState } from "react";
import { useSession } from "../../state/store";
import {
  parseEventTagConfig,
  serializeEventTagConfig,
  type TagAttributeType,
} from "../../state/persist/eventTagConfig";
import s from "./EventTagConfigEditor.module.css";

function splitOptions(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

export function EventTagConfigEditor() {
  const config = useSession((st) => st.eventTagConfig);

  const [open, setOpen] = useState(false);
  // Per-attribute comma-separated option drafts (id → text). Absent =
  // show the committed `options.join(", ")`.
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const setDraft = (id: string, text: string) =>
    setOptionDrafts((d) => ({ ...d, [id]: text }));

  const commitOptions = (id: string) => {
    const draft = optionDrafts[id];
    if (draft === undefined) return;
    useSession
      .getState()
      .updateTagAttribute(id, { options: splitOptions(draft) });
    setOptionDrafts((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });
  };

  const onAdd = () => {
    setOpen(true);
    useSession.getState().addTagAttribute("New attribute", "select");
  };

  const onExport = () => {
    const text = serializeEventTagConfig(useSession.getState().eventTagConfig);
    if (
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      return;
    }
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "driveline-event-tags.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file) return;
    const text = await file.text();
    const parsed = parseEventTagConfig(text);
    if (!parsed) {
      setImportError("Could not parse that file as an event-tag config.");
      return;
    }
    setImportError(null);
    useSession.getState().setEventTagConfig(parsed);
  };

  return (
    <section className={s.wrap} data-testid="event-tag-config">
      <button
        type="button"
        className={s.header}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="event-tag-config-toggle"
      >
        <span
          className={s.caret}
          data-open={open ? "true" : undefined}
          aria-hidden="true"
        >
          ▸
        </span>
        Tag attributes
        <span className={s.count}>{config.attributes.length}</span>
      </button>

      {open ? (
        <div className={s.body} data-testid="event-tag-config-body">
          {config.attributes.length === 0 ? (
            <p className={s.empty}>No attributes — add one below.</p>
          ) : (
            <ul className={s.attrList}>
              {config.attributes.map((a) => (
                <li
                  key={a.id}
                  className={s.attr}
                  data-testid={`tag-attr-${a.id}`}
                >
                  <div className={s.attrTop}>
                    <input
                      type="text"
                      className={s.nameInput}
                      value={a.name}
                      aria-label="Attribute name"
                      data-testid={`tag-attr-name-${a.id}`}
                      onChange={(e) =>
                        useSession
                          .getState()
                          .updateTagAttribute(a.id, { name: e.target.value })
                      }
                    />
                    <select
                      className={s.typeSelect}
                      value={a.type}
                      aria-label="Attribute type"
                      data-testid={`tag-attr-type-${a.id}`}
                      onChange={(e) =>
                        useSession.getState().updateTagAttribute(a.id, {
                          type: e.target.value as TagAttributeType,
                        })
                      }
                    >
                      <option value="select">Select</option>
                      <option value="text">Text</option>
                    </select>
                    <button
                      type="button"
                      className={s.removeBtn}
                      aria-label={`Remove attribute ${a.name}`}
                      title="Remove attribute"
                      data-testid={`tag-attr-remove-${a.id}`}
                      onClick={() =>
                        useSession.getState().removeTagAttribute(a.id)
                      }
                    >
                      ×
                    </button>
                  </div>
                  {a.type === "select" ? (
                    <input
                      type="text"
                      className={s.optionsInput}
                      placeholder="comma-separated options"
                      aria-label="Options (comma-separated)"
                      data-testid={`tag-attr-options-${a.id}`}
                      value={optionDrafts[a.id] ?? a.options.join(", ")}
                      onChange={(e) => setDraft(a.id, e.target.value)}
                      onBlur={() => commitOptions(a.id)}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className={s.actions}>
            <button
              type="button"
              className={s.addBtn}
              onClick={onAdd}
              data-testid="tag-attr-add"
            >
              + add attribute
            </button>
            <button
              type="button"
              className={s.ioBtn}
              onClick={onExport}
              data-testid="tag-config-export"
            >
              Export
            </button>
            <button
              type="button"
              className={s.ioBtn}
              onClick={() => fileRef.current?.click()}
              data-testid="tag-config-import"
            >
              Import
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className={s.hiddenFile}
              onChange={onImportFile}
              data-testid="tag-config-import-input"
            />
          </div>
          {importError ? (
            <p
              className={s.error}
              role="alert"
              data-testid="tag-config-import-error"
            >
              {importError}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
