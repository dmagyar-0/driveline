// Shared binding-resolution hook for the multi-channel data panels.
//
// ValuePanel, TablePanel and EnumPanel each re-implemented the same three
// steps: read the panel's persisted binding ids, resolve them to live
// `Channel` records (dropping any that no longer exist), and — once at least
// one source is loaded — cull bindings that no longer map to an acceptable
// channel kind, writing the trimmed list back to the store. The cull is gated
// on `sources.length > 0` so a fresh hydrate (channels list still empty)
// doesn't wipe a persisted binding before the user has dropped a file.
//
// This hook centralises exactly that behaviour. It does NOT fetch data — the
// abortable range fetch lives in `useChannelRanges` — so panels compose the
// two: resolve bindings here, fetch ranges there.

import { useEffect, useMemo } from "react";
import { useSession } from "../../state/store";
import type { Channel } from "../../state/store";
import { findChannel } from "./channels";

const EMPTY: readonly string[] = Object.freeze([]);

interface UsePanelChannelsArgs {
  panelId: string;
  /** Selector for this panel's persisted binding id list. */
  bindings: string[] | undefined;
  /** Whether a resolved channel is still acceptable for this panel kind. */
  isValid: (channel: Channel) => boolean;
  /** Persist the culled binding list back to the store. */
  setBindings: (panelId: string, ids: string[]) => void;
}

interface UsePanelChannelsResult {
  /** Binding ids in stored order (stable `EMPTY` when unset). */
  boundIds: readonly string[];
  /** Live channels for the bindings, in order, stale ids dropped. */
  boundChannels: Channel[];
}

export function usePanelChannels({
  panelId,
  bindings,
  isValid,
  setBindings,
}: UsePanelChannelsArgs): UsePanelChannelsResult {
  const sources = useSession((s) => s.sources);

  const boundIds = useMemo(() => bindings ?? EMPTY, [bindings]);

  const boundChannels = useMemo(
    () =>
      boundIds
        .map((id) => findChannel(sources, id))
        .filter((c): c is Channel => c !== null),
    [boundIds, sources],
  );

  // Drop stale / wrong-kind bindings once a source exists. Skip the cull until
  // at least one source is loaded so a fresh hydrate doesn't wipe persisted
  // bindings before the user has dropped a file.
  useEffect(() => {
    if (sources.length === 0) return;
    const filtered = boundIds.filter((id) => {
      const c = findChannel(sources, id);
      return c !== null && isValid(c);
    });
    if (filtered.length !== boundIds.length) {
      setBindings(panelId, filtered);
    }
    // `isValid` is a stable predicate per call site; depending on it would
    // require every caller to memoize it. The cull only needs to re-run when
    // the bindings or the source set change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundIds, sources, panelId, setBindings]);

  return { boundIds, boundChannels };
}
