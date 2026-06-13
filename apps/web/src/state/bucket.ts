// Pure file-bucketing helper for T2.4. Takes a flat `File[]` (from either a
// real `DataTransfer` drop or the Playwright dev-hook) and returns the inputs
// grouped by reader format. mp4 + `.mp4.timestamps` pairing follows the naming
// convention in `docs/05-video-pipeline.md` (see the "Sidecar format" section):
// `foo.mp4` pairs with `foo.mp4.timestamps` in the same drop batch.

export interface Mp4Pair {
  mp4: File;
  ts: File;
}

export interface BucketError {
  name: string;
  reason: string;
}

/** Tabular formats (CSV / Parquet) need a user-chosen time basis before they
 *  can open, so they're carried with their detected `format` string (the value
 *  the wasm `tabular_*` endpoints expect) rather than opened eagerly. */
export type TabularFormat = "csv" | "parquet";

export interface TabularInput {
  file: File;
  format: TabularFormat;
}

/** Point-cloud (LiDAR) drops carry which reader opens them: a Driveline
 *  point-cloud Parquet (`*.lidar.parquet`) or a PCL/ROS `.pcd` file. Both open
 *  into the same 3D scene pipeline but call different wasm entry points. */
export type LidarFormat = "parquet" | "pcd";

export interface LidarInput {
  file: File;
  format: LidarFormat;
}

export interface Buckets {
  mcap: File[];
  mf4: File[];
  /** ROS 1 bag (`.bag`, rosbag v2.0) drops — opened whole-file in memory. */
  ros1: File[];
  /** ROS 2 rosbag2 SQLite (`.db3`) drops — opened whole-file in memory. */
  ros2db3: File[];
  mp4Pairs: Mp4Pair[];
  /**
   * `.mp4` drops with NO matching `.mp4.timestamps` sidecar in the same batch.
   * These are no longer a hard error: their per-frame timestamps can be
   * derived from an opened tabular source's time column (the Alpamayo camera
   * case). `openFiles` reads each one's header bytes and queues a pending
   * video-timestamp binding the `VideoTimestampDialog` resolves on confirm.
   */
  videoNeedsTimestamps: File[];
  /** CSV / Parquet drops — deferred behind the import-config dialog. */
  tabular: TabularInput[];
  /**
   * Point-cloud (LiDAR) drops opened straight into the 3D scene pipeline:
   * Driveline point-cloud Parquet (`*.lidar.parquet`, one row per spin) and
   * PCL/ROS `.pcd` files (a single cloud). The `.lidar.parquet` suffix is
   * checked before the generic `.parquet` branch so a plain `.parquet` still
   * routes to the tabular (scalar) import flow.
   */
  lidar: LidarInput[];
  /**
   * Drops with an extension Driveline doesn't recognise. No longer a hard
   * error: each is routed to the Format Agent flow — `openFiles` first tries
   * the Format Registry for a matching Ingest Recipe (extension / magic bytes),
   * and otherwise queues a pending unknown import the `UnknownFormatDialog`
   * resolves (import a recipe JSON, or derive one with Claude). See
   * `docs/12-format-agent.md`.
   */
  unknown: File[];
  errors: BucketError[];
}

const SIDECAR_SUFFIX = ".mp4.timestamps";
const LIDAR_SUFFIX = ".lidar.parquet";

export function bucketFiles(files: File[]): Buckets {
  const mcap: File[] = [];
  const mf4: File[] = [];
  const ros1: File[] = [];
  const ros2db3: File[] = [];
  const sidecars = new Map<string, File>(); // mp4 filename -> sidecar file
  const mp4s: File[] = [];
  const tabular: TabularInput[] = [];
  const lidar: LidarInput[] = [];
  const unknown: File[] = [];
  const errors: BucketError[] = [];

  for (const f of files) {
    const name = f.name;
    const lower = name.toLowerCase();
    if (lower.endsWith(SIDECAR_SUFFIX)) {
      // "drive.mp4.timestamps" -> "drive.mp4". Preserve the original (unlowered)
      // casing of the mp4 name so equality matching stays strict.
      const mp4Name = name.slice(0, -".timestamps".length);
      sidecars.set(mp4Name, f);
    } else if (lower.endsWith(".mp4")) {
      mp4s.push(f);
    } else if (lower.endsWith(".mcap")) {
      mcap.push(f);
    } else if (lower.endsWith(".mf4")) {
      mf4.push(f);
    } else if (lower.endsWith(".bag")) {
      ros1.push(f);
    } else if (lower.endsWith(".db3")) {
      ros2db3.push(f);
    } else if (lower.endsWith(LIDAR_SUFFIX)) {
      // Point-cloud Parquet — checked before the generic `.parquet` branch so
      // a `*.lidar.parquet` routes to the 3D scene pipeline, not tabular.
      lidar.push({ file: f, format: "parquet" });
    } else if (lower.endsWith(".pcd")) {
      // PCL/ROS Point Cloud Data — a single LiDAR cloud per file.
      lidar.push({ file: f, format: "pcd" });
    } else if (lower.endsWith(".csv")) {
      tabular.push({ file: f, format: "csv" });
    } else if (lower.endsWith(".parquet") || lower.endsWith(".pq")) {
      // `.pq` is a common short alias for Parquet.
      tabular.push({ file: f, format: "parquet" });
    } else {
      // Unrecognised extension: hand to the Format Agent flow rather than
      // failing the drop outright.
      unknown.push(f);
    }
  }

  const mp4Pairs: Mp4Pair[] = [];
  const videoNeedsTimestamps: File[] = [];
  for (const mp4 of mp4s) {
    const ts = sidecars.get(mp4.name);
    if (ts) {
      // Strict pairing is unchanged when a sidecar IS present.
      mp4Pairs.push({ mp4, ts });
      sidecars.delete(mp4.name);
    } else {
      // No sidecar in this batch: not an error any more. Defer it to the
      // video-timestamp binding flow, where the user picks a tabular source
      // whose time column supplies the per-frame timestamps.
      videoNeedsTimestamps.push(mp4);
    }
  }

  // Any sidecar left over has no matching mp4 in this drop — still an error.
  for (const [mp4Name, ts] of sidecars) {
    errors.push({
      name: ts.name,
      reason: `orphan sidecar; no ${mp4Name} in drop`,
    });
  }

  return {
    mcap,
    mf4,
    ros1,
    ros2db3,
    mp4Pairs,
    videoNeedsTimestamps,
    tabular,
    lidar,
    unknown,
    errors,
  };
}

/** A URL input classified by the reader that can open it. */
export interface UrlClassification {
  kind: "mcap" | "mf4";
  /** Display name derived from the URL's last path segment. */
  name: string;
}

/**
 * Derive a human-friendly source name from a URL — its last path segment,
 * percent-decoded (e.g. `…/drives/2018-08-02.mf4?token=x` → `2018-08-02.mf4`).
 * Falls back to the host, then the raw string, for URLs without a path.
 */
export function urlBasename(raw: string): string {
  try {
    const u = new URL(raw);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg);
    return u.hostname || raw;
  } catch {
    return raw;
  }
}

/**
 * Classify a URL by file extension into the reader that can open it. Mirrors
 * `bucketFiles` for the drag/drop path: only `.mcap` and `.mf4` are
 * loadable from a URL. (`.mp4` needs its `.mp4.timestamps` sidecar, which
 * has no single-URL form, so it's rejected here.) Throws with a
 * user-facing reason on anything unsupported.
 */
export function classifyUrl(raw: string): UrlClassification {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("URL must start with http:// or https://");
  }
  const name = urlBasename(url);
  const lower = name.toLowerCase();
  if (lower.endsWith(".mcap")) return { kind: "mcap", name };
  if (lower.endsWith(".mf4")) return { kind: "mf4", name };
  throw new Error("URL must point at a .mcap or .mf4 file");
}
