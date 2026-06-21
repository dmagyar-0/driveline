// Table / Value / Enum panel settings bodies. All three are multi-channel
// scalar bindings differing only in their store binding map + actions, the
// testid prefix, the "full" tooltip noun, and (enum) the channel-kind
// filter — so they share `MultiChannelBindingSection`.

import { selectChannelsById, useSession } from "../../../state/store";
import { MultiChannelBindingSection } from "./MultiChannelBindingSection";
import { EMPTY, resolveBound, type BodyProps } from "./shared";

export function TableBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const ids = useSession((st) => st.tableBindings[panelId] ?? EMPTY);

  const onToggle = (channelId: string) => {
    const cur = useSession.getState().tableBindings[panelId] ?? [];
    if (cur.includes(channelId)) {
      useSession.getState().removeTableChannel(panelId, channelId);
    } else {
      useSession.getState().addTableChannel(panelId, channelId);
    }
  };
  const onRemove = (channelId: string) =>
    useSession.getState().removeTableChannel(panelId, channelId);

  return (
    <MultiChannelBindingSection
      ids={ids}
      bound={resolveBound(ids, selectChannelsById({ channels }))}
      sources={sources}
      unitOverrides={unitOverrides}
      toggleChannel={onToggle}
      removeChannel={onRemove}
      testidPrefix="panel-table"
      fullLabel="Table"
    />
  );
}

export function ValueBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const ids = useSession((st) => st.valueBindings[panelId] ?? EMPTY);

  const onToggle = (channelId: string) => {
    const cur = useSession.getState().valueBindings[panelId] ?? [];
    if (cur.includes(channelId)) {
      useSession.getState().removeValueChannel(panelId, channelId);
    } else {
      useSession.getState().addValueChannel(panelId, channelId);
    }
  };
  const onRemove = (channelId: string) =>
    useSession.getState().removeValueChannel(panelId, channelId);

  return (
    <MultiChannelBindingSection
      ids={ids}
      bound={resolveBound(ids, selectChannelsById({ channels }))}
      sources={sources}
      unitOverrides={unitOverrides}
      toggleChannel={onToggle}
      removeChannel={onRemove}
      testidPrefix="panel-value"
      fullLabel="Panel"
    />
  );
}

export function EnumBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const ids = useSession((st) => st.enumBindings[panelId] ?? EMPTY);

  const onToggle = (channelId: string) => {
    const cur = useSession.getState().enumBindings[panelId] ?? [];
    if (cur.includes(channelId)) {
      useSession.getState().removeEnumChannel(panelId, channelId);
    } else {
      useSession.getState().addEnumChannel(panelId, channelId);
    }
  };
  const onRemove = (channelId: string) =>
    useSession.getState().removeEnumChannel(panelId, channelId);

  return (
    <MultiChannelBindingSection
      ids={ids}
      bound={resolveBound(ids, selectChannelsById({ channels }))}
      sources={sources}
      unitOverrides={unitOverrides}
      toggleChannel={onToggle}
      removeChannel={onRemove}
      testidPrefix="panel-enum"
      fullLabel="Panel"
      kinds={["scalar", "enum"]}
    />
  );
}
