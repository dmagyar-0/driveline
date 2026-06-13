// Phase 4 · Format Registry drawer (docs/12-format-agent.md §3.4, §9).
//
// Lists the saved Ingest Recipes (the Format Registry) and the low-confidence
// DRAFTS captured from non-converging / gate-failing agent runs. Each recipe
// supports rename, delete, export (download `<name>.driveline-recipe.json`),
// and "Re-derive with agent" (pick a representative file → opens the Format
// Agent dialog in re-derive mode, replacing the old recipe on success). Drafts
// support promote (→ real registry) and delete; opening a draft happens through
// the normal recipe path and the source carries a "low-confidence decode"
// banner (surfaced in the Sources drawer).
//
// The registry + drafts live in `localStorage` (formatRegistry.ts), not the
// Zustand store, so this drawer reads them through the shard helpers and bumps a
// local version counter to re-render after a mutation. Re-derive goes through
// the store (`reDeriveRecipe`) because it must queue an unknown import.

import { useId, useRef, useState } from "react";
import { useSession } from "../../state/store";
import {
  loadRecipes,
  loadDrafts,
  loadDerivationCosts,
  renameRecipe,
  removeRecipe,
  removeDraft,
  promoteDraft,
  exportRecipeBlob,
  formatDerivationCost,
  type RecipeDraft,
} from "../../state/formatRegistry";
import type { Recipe } from "../../state/recipe";
import drawerStyles from "../Drawer.module.css";
import { DRAWER_REGION_ID } from "../Drawer";
import s from "./FormatsDrawer.module.css";

const HEADING_ID = "drawer-formats-h";

/** Trigger a browser download of a recipe export blob. */
function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has surely started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function channelCount(r: Recipe): number {
  return Array.isArray(r.channels) ? r.channels.length : 0;
}

export function FormatsDrawer() {
  const reDeriveRecipe = useSession((st) => st.reDeriveRecipe);
  // The registry/drafts are in localStorage; bump this to re-read after a
  // rename/delete/promote so the list reflects the change.
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  // `version` is read so the lint/deps are honest and the lists recompute.
  void version;
  const recipes = loadRecipes();
  const drafts = loadDrafts();
  const costs = loadDerivationCosts();

  // Re-derive needs a representative file; the per-recipe button stashes the
  // recipe name, then this shared hidden input picks the file.
  const reDeriveNameRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onReDeriveClick = (name: string) => {
    reDeriveNameRef.current = name;
    fileInputRef.current?.click();
  };
  const onReDeriveFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    const name = reDeriveNameRef.current;
    e.target.value = "";
    reDeriveNameRef.current = null;
    if (f && name) reDeriveRecipe(name, f);
  };

  return (
    <aside
      id={DRAWER_REGION_ID}
      className={drawerStyles.drawer}
      role="region"
      aria-labelledby={HEADING_ID}
      data-testid="drawer-formats"
    >
      <div className={drawerStyles.heading}>
        <h3 id={HEADING_ID}>Formats</h3>
        <span className={s.pill} data-testid="formats-count-pill">
          {recipes.length}
        </span>
      </div>

      <p className={s.blurb}>
        Saved Ingest Recipes auto-match future drops of the same format offline
        — no key, no network. Export one to share it with your team.
      </p>

      {recipes.length === 0 ? (
        <p className={s.empty} data-testid="formats-empty">
          No saved recipes yet. Drop an unrecognised file and derive (or import)
          a recipe to populate this list.
        </p>
      ) : (
        <ul className={s.list} data-testid="formats-list">
          {recipes.map((r) => (
            <RecipeRow
              key={r.name ?? ""}
              recipe={r}
              costLine={
                r.name && costs[r.name]
                  ? formatDerivationCost(costs[r.name])
                  : null
              }
              existingNames={recipes.map((x) => x.name ?? "")}
              onChanged={refresh}
              onReDerive={() => onReDeriveClick(r.name ?? "")}
            />
          ))}
        </ul>
      )}

      {drafts.length > 0 ? (
        <section className={s.draftsSection} data-testid="formats-drafts">
          <h3 className={s.draftsHeading}>
            Drafts
            <span className={s.draftPill}>{drafts.length}</span>
          </h3>
          <p className={s.blurb}>
            Low-confidence best attempts from runs that didn&rsquo;t converge.
            They never auto-match a drop and open with a warning banner.
          </p>
          <ul className={s.list} data-testid="formats-drafts-list">
            {drafts.map((d) => (
              <DraftRow
                key={d.recipe.name ?? ""}
                draft={d}
                onChanged={refresh}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        className={s.hiddenInput}
        onChange={onReDeriveFile}
        aria-hidden="true"
        tabIndex={-1}
        data-testid="formats-rederive-file"
      />
    </aside>
  );
}

function RecipeRow({
  recipe,
  costLine,
  existingNames,
  onChanged,
  onReDerive,
}: {
  recipe: Recipe;
  costLine: string | null;
  existingNames: string[];
  onChanged: () => void;
  onReDerive: () => void;
}) {
  const name = recipe.name ?? "";
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const nameInputId = useId();

  const provenance = recipe.provenance;
  const by = provenance?.createdBy ?? "user";
  const model = provenance?.model;

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (trimmed.length === 0 || trimmed === name) {
      setRenaming(false);
      setDraftName(name);
      return;
    }
    if (existingNames.includes(trimmed) && trimmed !== name) {
      // Collision — snap back rather than silently overwrite.
      setDraftName(name);
      setRenaming(false);
      return;
    }
    renameRecipe(name, trimmed);
    setRenaming(false);
    onChanged();
  };

  const onDelete = () => {
    removeRecipe(name);
    onChanged();
  };

  const onExport = () => {
    const { filename, text } = exportRecipeBlob(recipe);
    downloadText(filename, text);
  };

  return (
    <li className={s.row} data-testid={`format-row-${name}`}>
      <div className={s.rowMain}>
        {renaming ? (
          <input
            id={nameInputId}
            className={s.renameInput}
            value={draftName}
            autoFocus
            aria-label={`Rename ${name}`}
            spellCheck={false}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraftName(name);
                setRenaming(false);
              }
            }}
            data-testid={`format-rename-input-${name}`}
          />
        ) : (
          <span className={s.name} title={name}>
            {name || "(unnamed)"}
          </span>
        )}
        {recipe.description ? (
          <span className={s.desc} title={recipe.description}>
            {recipe.description}
          </span>
        ) : null}
        <span className={s.meta}>
          {channelCount(recipe)} channel
          {channelCount(recipe) === 1 ? "" : "s"} · {by}
          {model ? ` · ${model}` : ""}
        </span>
        {costLine ? (
          <span className={s.cost} data-testid={`format-cost-${name}`}>
            last derivation: {costLine}
          </span>
        ) : null}
      </div>
      <div className={s.actions}>
        <button
          type="button"
          className={s.action}
          onClick={() => {
            setDraftName(name);
            setRenaming(true);
          }}
          data-testid={`format-rename-${name}`}
        >
          Rename
        </button>
        <button
          type="button"
          className={s.action}
          onClick={onExport}
          data-testid={`format-export-${name}`}
        >
          Export
        </button>
        <button
          type="button"
          className={s.action}
          onClick={onReDerive}
          data-testid={`format-rederive-${name}`}
        >
          Re-derive
        </button>
        <button
          type="button"
          className={s.actionDanger}
          onClick={onDelete}
          data-testid={`format-delete-${name}`}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function DraftRow({
  draft,
  onChanged,
}: {
  draft: RecipeDraft;
  onChanged: () => void;
}) {
  const name = draft.recipe.name ?? "";
  const coveragePct =
    draft.coverage !== undefined ? (draft.coverage * 100).toFixed(1) : null;

  const onPromote = () => {
    promoteDraft(name);
    onChanged();
  };
  const onDelete = () => {
    removeDraft(name);
    onChanged();
  };

  return (
    <li className={`${s.row} ${s.draftRow}`} data-testid={`draft-row-${name}`}>
      <div className={s.rowMain}>
        <span className={s.name} title={name}>
          {name || "(unnamed)"}
        </span>
        <span className={s.draftBadge}>draft</span>
        <span className={s.meta} title={draft.reason}>
          {draft.reason}
          {coveragePct ? ` · best coverage ${coveragePct}%` : ""}
        </span>
      </div>
      <div className={s.actions}>
        <button
          type="button"
          className={s.action}
          onClick={onPromote}
          data-testid={`draft-promote-${name}`}
        >
          Promote
        </button>
        <button
          type="button"
          className={s.actionDanger}
          onClick={onDelete}
          data-testid={`draft-delete-${name}`}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
