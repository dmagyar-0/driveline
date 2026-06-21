// Shared multi-channel binding section for the Panel drawer.
//
// `TableBody`, `ValueBody`, and `EnumBody` were byte-for-byte clones apart
// from their binding map, add/remove store actions, testid prefix, the
// "full" tooltip noun, and an optional channel-kind filter. `PlotBody`'s
// channel list is the same shape plus per-channel field controls. This one
// component captures all of them, parameterised by those differences, so a
// fix lands in one place.

import { useRef, useState, type ReactNode } from "react";
import { type Channel, type SourceMeta } from "../../../state/store";
import { channelLabel } from "../../../state/units";
import { colorFor, MAX_PLOT_SERIES } from "../../../panels/palette";
import { ChannelPicker } from "../../../panels/ChannelPicker";
import type { ChannelKind } from "../../../state/store";
import s from "../PanelDrawer.module.css";

interface Props {
  /** The bound channel ids, in binding order. */
  ids: string[];
  /** Resolved channels (binding order, missing ids dropped). */
  bound: Channel[];
  /** All sources, for the picker. */
  sources: SourceMeta[];
  unitOverrides: Record<string, string>;
  /** Add OR remove `channelId` from the binding (toggle from the picker). */
  toggleChannel: (channelId: string) => void;
  /** Remove `channelId` from the binding (× button). */
  removeChannel: (channelId: string) => void;
  /** e.g. "panel-table" — used to derive every `data-testid` in the section
   *  so the values stay byte-identical to the pre-split bodies. */
  testidPrefix: string;
  /** Noun for the "<noun> full" tooltip when at capacity. */
  fullLabel: string;
  /** Optional channel-kind filter passed to the picker (enum bodies). */
  kinds?: readonly ChannelKind[];
  /** Optional per-channel field block rendered under each row (plot only).
   *  When present, the row uses the plot list-item layout. */
  renderRowFields?: (channel: Channel) => ReactNode;
}

export function MultiChannelBindingSection({
  ids,
  bound,
  sources,
  unitOverrides,
  toggleChannel,
  removeChannel,
  testidPrefix,
  fullLabel,
  kinds,
  renderRowFields,
}: Props) {
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  const atCap = ids.length >= MAX_PLOT_SERIES;

  const openPicker = () => {
    if (!addBtnRef.current) return;
    setPickerAnchor(addBtnRef.current.getBoundingClientRect());
  };

  return (
    <section className={s.section}>
      <div className={s.sectionHeader}>
        <h4 className={s.sectionTitle}>Channels in panel</h4>
        <span className={s.countPill} data-testid={`${testidPrefix}-count`}>
          {ids.length} / {MAX_PLOT_SERIES}
        </span>
      </div>
      {bound.length === 0 ? (
        <p className={s.empty}>No channels bound. Add one below.</p>
      ) : (
        <ul className={s.list} data-testid={`${testidPrefix}-list`}>
          {bound.map((c) => {
            const removeBtn = (
              <button
                type="button"
                className={s.removeBtn}
                onClick={() => removeChannel(c.id)}
                aria-label={`Remove ${c.name}`}
                data-testid={`${testidPrefix}-remove-${c.id}`}
              >
                ×
              </button>
            );
            const rowInner = (
              <>
                <span className={s.row}>
                  <span
                    className={s.swatch}
                    style={{ background: colorFor(c.id) }}
                    aria-hidden="true"
                  />
                  <span className={s.name} title={c.name}>
                    {channelLabel(c, unitOverrides)}
                  </span>
                </span>
                {removeBtn}
              </>
            );
            // Plot rows wrap the row + per-channel fields; the simpler bodies
            // make the row item itself the list item. Both keep their exact
            // pre-split DOM.
            return renderRowFields ? (
              <li key={c.id} className={s.plotRowItem}>
                <div className={s.rowItem}>{rowInner}</div>
                <div className={s.channelFields}>{renderRowFields(c)}</div>
              </li>
            ) : (
              <li key={c.id} className={s.rowItem}>
                {rowInner}
              </li>
            );
          })}
        </ul>
      )}
      <button
        ref={addBtnRef}
        type="button"
        className={s.addRow}
        aria-disabled={atCap || undefined}
        title={atCap ? `${fullLabel} full (${MAX_PLOT_SERIES})` : undefined}
        onClick={() => {
          if (atCap) return;
          openPicker();
        }}
        data-testid={`${testidPrefix}-add-channel`}
      >
        + add channel…
      </button>
      {pickerAnchor !== null && (
        <ChannelPicker
          sources={sources}
          selectedIds={ids}
          maxSelected={MAX_PLOT_SERIES}
          anchorRect={pickerAnchor}
          kinds={kinds}
          onToggle={toggleChannel}
          onClose={() => setPickerAnchor(null)}
        />
      )}
    </section>
  );
}
