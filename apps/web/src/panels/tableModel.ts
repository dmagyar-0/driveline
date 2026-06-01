// Row model for the raw-time-series TablePanel.
//
// Multiple scalar channels share one time axis (the union of every
// channel's sample timestamps), so the table reads like a spreadsheet:
// one row per distinct timestamp, one column per channel. Each cell
// holds that channel's value at the row's timestamp using sample-and-
// hold — the most recent sample at-or-before the row. A cell is `exact`
// when the channel actually produced a sample at that timestamp (vs.
// carried forward from an earlier one); the panel renders carried values
// muted so the raw sample cadence stays visible.
//
// The merge is a k-way walk over the per-channel sample arrays, so it is
// O(total samples) and runs once per fetch/binding change — never on the
// cursor hot path. `MAX_ROWS` caps the build so a pathological multi-
// million-sample union can't lock the main thread; `truncated` lets the
// panel surface that it stopped early.

import type { PlotSeries } from "./seriesFromArrow";

export interface TableColumnInput {
  channelId: string;
  name: string;
  unit: string | null;
  series: PlotSeries;
}

export interface TableColumn {
  channelId: string;
  name: string;
  unit: string | null;
  values: (number | null)[];
  exact: boolean[];
}

export interface TableModel {
  rowTsNs: bigint[];
  columns: TableColumn[];
  truncated: boolean;
}

export const MAX_ROWS = 500_000;

const EMPTY_MODEL: TableModel = Object.freeze({
  rowTsNs: [],
  columns: [],
  truncated: false,
});

export function buildTableModel(inputs: TableColumnInput[]): TableModel {
  if (inputs.length === 0) return EMPTY_MODEL;

  const cols: TableColumn[] = inputs.map((c) => ({
    channelId: c.channelId,
    name: c.name,
    unit: c.unit,
    values: [],
    exact: [],
  }));

  const ptrs = new Array<number>(inputs.length).fill(0);
  const curVal: (number | null)[] = new Array(inputs.length).fill(null);
  const lens = inputs.map((c) => c.series.rawTsNs.length);
  const rowTsNs: bigint[] = [];
  let truncated = false;

  for (;;) {
    // Min timestamp among channels that still have unconsumed samples.
    let minTs: bigint | null = null;
    for (let i = 0; i < inputs.length; i++) {
      if (ptrs[i] >= lens[i]) continue;
      const ts = inputs[i].series.rawTsNs[ptrs[i]];
      if (minTs === null || ts < minTs) minTs = ts;
    }
    if (minTs === null) break;

    if (rowTsNs.length >= MAX_ROWS) {
      truncated = true;
      break;
    }

    rowTsNs.push(minTs);
    for (let i = 0; i < inputs.length; i++) {
      const series = inputs[i].series;
      let consumed = false;
      // Consume every sample at exactly minTs (duplicates collapse into
      // the same row), keeping the last as the current held value.
      while (ptrs[i] < lens[i] && series.rawTsNs[ptrs[i]] === minTs) {
        curVal[i] = series.ys[ptrs[i]];
        ptrs[i]++;
        consumed = true;
      }
      cols[i].values.push(curVal[i]);
      cols[i].exact.push(consumed);
    }
  }

  return { rowTsNs, columns: cols, truncated };
}

// Index of the last row at-or-before `cursorNs`, or -1 when the cursor
// precedes every row. Binary search over the ascending `rowTsNs`.
export function lastRowAtOrBefore(
  rowTsNs: bigint[],
  cursorNs: bigint,
): number {
  let lo = 0;
  let hi = rowTsNs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (rowTsNs[mid] <= cursorNs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
