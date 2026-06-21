// Shared abortable range-fetch hook for the multi-channel data panels.
//
// ValuePanel, TablePanel, EnumPanel and MapPanel each re-implemented the same
// fetch dance: on a binding/range change, fire one `fetchChannelRange` per
// bound channel in parallel, guard the result behind an `aborted` flag so a
// superseded fetch can't write stale data, and surface failures. The store
// already dedups concurrent identical fetches, so this hook is purely the
// effect discipline — it adds no caching.
//
// It returns a `PanelLoad<Uint8Array[]>`: `idle` when nothing's bound / no
// range, `loading` while in flight, `error` on the first failed fetch, and
// `ready` with one Arrow IPC batch per channel in binding order. Decoding is
// left to the caller (so a panel can choose `decodeSeries` and branch on a
// per-channel dtype error itself).
//
// Hot-path note: the effect keys on the bound channel id list and the range's
// `startNs`/`endNs` bigint *values*, not the `range` object identity — a new
// `globalRange` object with the same window won't trigger a redundant refetch.

import { useEffect, useState } from "react";
import { useSession } from "../../state/store";
import type { Channel, TimeRange } from "../../state/store";
import {
  LOAD_IDLE,
  LOAD_LOADING,
  loadError,
  loadReady,
  type PanelLoad,
} from "./panelLoad";

export function useChannelRanges(
  channels: Channel[],
  range: TimeRange | null,
  label: string,
): PanelLoad<Uint8Array[]> {
  const [load, setLoad] = useState<PanelLoad<Uint8Array[]>>(LOAD_IDLE);

  // Stable scalar deps so an unrelated render (or a fresh `range` object with
  // the same window) doesn't refetch. ids fold to a `|`-joined key.
  const idsKey = channels.map((c) => c.id).join("|");
  const startNs = range?.startNs ?? null;
  const endNs = range?.endNs ?? null;

  useEffect(() => {
    if (startNs === null || endNs === null || channels.length === 0) {
      setLoad(LOAD_IDLE);
      return;
    }
    let aborted = false;
    setLoad(LOAD_LOADING);
    void (async () => {
      try {
        const store = useSession.getState();
        const batches = await Promise.all(
          channels.map((c) =>
            store.fetchChannelRange(c.id, startNs, endNs, false),
          ),
        );
        if (aborted) return;
        setLoad(loadReady(batches));
      } catch (err) {
        if (aborted) return;
        console.error(`${label} fetch failed`, err);
        setLoad(
          loadError(
            err instanceof Error ? err.message : "Failed to load channel data.",
          ),
        );
      }
    })();
    return () => {
      aborted = true;
    };
    // `channels` identity changes whenever `idsKey` does; depending on the
    // stable key + range values avoids refetching on unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, startNs, endNs, label]);

  return load;
}
