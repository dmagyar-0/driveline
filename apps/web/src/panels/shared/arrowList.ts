// Shared Arrow `List<T>` column access for the `*FromArrow` decoder family.
//
// Every scene/overlay decoder reads numeric or string slices out of a
// single-chunk Arrow `List<T>` column the same way; this used to be a verbatim
// copy in boxesFromArrow.ts, trajectoriesFromArrow.ts, pointCloudFromArrow.ts,
// mapGeometryFromArrow.ts (the `listRowF32`/`listRowI32`/`listRowUtf8` helpers
// and `ListCol`/`ListData` interfaces) and the generic `listRow<T>` in
// calibrationFromArrow.ts. One copy lives here now.
//
// The last-row `ts` extraction (`lastRowTsNs`) was likewise duplicated across
// boxes/trajectories/pointCloud/mapGeometry; it preserves the BigInt64Array
// guard so nanosecond timestamps stay `bigint` and never narrow to `Number`.

import type { Table } from "apache-arrow";

// Minimal structural view of an Arrow `List<T>` column's backing data — a
// single chunk with i32 value offsets and a numeric child values buffer.
export interface ListData {
  offset: number;
  valueOffsets: ArrayLike<number>;
  children: ReadonlyArray<{ values: ArrayLike<number> }>;
}
export interface ListCol {
  data: ReadonlyArray<ListData>;
}

// Pull row `r`'s numeric slice out of a single-chunk List<Float32|Int32>
// column as the requested typed-array class. Returns null if the structure
// isn't the expected single chunk of the expected typed-array class.
export function listRow<T extends ArrayLike<number>>(
  col: ListCol,
  r: number,
  Ctor: { new (): T } & Function,
): T | null {
  if (col.data.length !== 1) return null;
  const d = col.data[0];
  const child = d.children?.[0]?.values;
  const offsets = d.valueOffsets;
  if (!child || !offsets) return null;
  const base = d.offset ?? 0;
  const start = Number(offsets[base + r]);
  const end = Number(offsets[base + r + 1]);
  if (!(child instanceof Ctor)) return null;
  return (child as unknown as { subarray(s: number, e: number): T }).subarray(
    start,
    end,
  );
}

// Pull row `r`'s Float32 slice out of a single-chunk List<Float32> column.
export function listRowF32(col: ListCol, r: number): Float32Array | null {
  return listRow(col, r, Float32Array);
}

// Pull row `r`'s Int32 slice out of a single-chunk List<Int32> column.
export function listRowI32(col: ListCol, r: number): Int32Array | null {
  return listRow(col, r, Int32Array);
}

// Read row `r`'s list of strings out of a single-chunk List<Utf8> column. The
// outer list offsets pick the [start,end) range of element indices; the inner
// Utf8 child is decoded element-by-element via its own value offsets + a UTF-8
// byte buffer. Returns null if the structure isn't the expected single chunk.
export function listRowUtf8(
  col: {
    data: ReadonlyArray<{
      offset?: number;
      valueOffsets: ArrayLike<number>;
      children: ReadonlyArray<{
        valueOffsets: ArrayLike<number>;
        values: ArrayLike<number> | Uint8Array;
      }>;
    }>;
  },
  r: number,
): string[] | null {
  if (col.data.length !== 1) return null;
  const d = col.data[0];
  const child = d.children?.[0];
  const outer = d.valueOffsets;
  if (!child || !outer) return null;
  const base = d.offset ?? 0;
  const start = Number(outer[base + r]);
  const end = Number(outer[base + r + 1]);
  const innerOffsets = child.valueOffsets;
  const bytes = child.values;
  if (!innerOffsets || !(bytes instanceof Uint8Array)) return null;
  const dec = new TextDecoder("utf-8");
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const s = Number(innerOffsets[i]);
    const e = Number(innerOffsets[i + 1]);
    out.push(dec.decode(bytes.subarray(s, e)));
  }
  return out;
}

// Read row `r`'s nanosecond timestamp out of the `ts` column, or null when the
// column is absent / not the expected single-chunk Timestamp(ns) backing. The
// BigInt64Array guard keeps the value a `bigint` — it must NOT narrow to Number
// (project-wide BigInt-ns discipline).
export function lastRowTsNs(table: Table, r: number): bigint | null {
  const tsCol = table.getChild("ts") as {
    data: ReadonlyArray<{ values: ArrayLike<bigint> | BigInt64Array }>;
  } | null;
  if (tsCol && tsCol.data.length === 1) {
    const tsVals = tsCol.data[0].values;
    if (tsVals instanceof BigInt64Array && tsVals.length > r) {
      return tsVals[r];
    }
  }
  return null;
}
