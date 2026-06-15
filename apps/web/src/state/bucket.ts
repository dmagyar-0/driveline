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
 *  point-cloud Parquet (`*.lidar.parquet`), a PCL/ROS `.pcd` file, or a **raw
 *  NVIDIA Alpamayo** LiDAR parquet (Draco-compressed spins, decoded in-browser).
 *  All open into the same 3D scene pipeline but call different wasm entry
 *  points. The raw-Alpamayo case is content-sniffed (`sniffAlpamayoLidar`), not
 *  matched by extension — its files carry a plain `.parquet` name. */
export type LidarFormat = "parquet" | "pcd" | "alpamayo";

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
   * ASAM OpenLABEL JSON drops (3D bounding-box annotations, one row per
   * labelled frame), opened straight into the 3D scene pipeline. A `.json`
   * extension is ambiguous (Ingest Recipes are also JSON), so a file only
   * lands here once its bytes are sniffed for a top-level `"openlabel"` key —
   * see `sniffOpenlabel`. `bucketFiles` is synchronous so it leaves this
   * empty; `openFiles` does the async sniff and re-routes qualifying `.json`
   * files out of `unknown` into here.
   */
  openlabel: File[];
  /**
   * Camera-calibration JSON drops (`driveline.calibration/v1`), opened straight
   * into the point-cloud-on-video overlay. Like OpenLABEL, a `.json` extension
   * is ambiguous, so a file only lands here once its bytes are sniffed for the
   * `driveline.calibration/v1` schema marker (see `sniffCalibration`).
   * `bucketFiles` is synchronous so it leaves this empty; `openFiles` does the
   * async sniff and re-routes qualifying `.json`/`.calib.json` files out of
   * `unknown` into here.
   */
  calibration: File[];
  /**
   * Driveline `*.trajectory.json` drops (predicted ego future trajectories,
   * one row per frame of candidate waypoint polylines), opened straight into
   * the 3D scene pipeline. Like OpenLABEL, a `.json` extension is ambiguous, so
   * a file only lands here once its bytes are sniffed for a top-level
   * `"trajectory"` key — see `sniffTrajectory`. `bucketFiles` is synchronous so
   * it leaves this empty; `openFiles` does the async sniff and re-routes
   * qualifying `.json` files out of `unknown` into here.
   */
  trajectory: File[];
  /**
   * Road-network map-geometry drops, opened straight into the 3D scene
   * pipeline as polylines (lane boundaries, road edges, centerlines, …). Two
   * input shapes: OpenDRIVE `.xodr` (routed by extension in `bucketFiles`) and
   * the simple `drivelineMap` JSON. A `.json` extension is ambiguous (Ingest
   * Recipes, OpenLABEL, and trajectories are JSON too), so a `.json` only lands
   * here once its bytes are sniffed for a top-level `"drivelineMap"` key — see
   * `sniffDrivelineMap`. `bucketFiles` routes `.xodr` directly but leaves the
   * JSON case to `openFiles`, which does the async sniff and re-routes
   * qualifying `.json` files out of `unknown` into here.
   */
  mapGeometry: File[];
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
  const openlabel: File[] = [];
  const calibration: File[] = [];
  const trajectory: File[] = [];
  const mapGeometry: File[] = [];
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
    } else if (lower.endsWith(".xodr")) {
      // OpenDRIVE road network — route straight into the 3D scene pipeline as
      // map geometry. (The `drivelineMap` JSON shape is sniffed in `openFiles`.)
      mapGeometry.push(f);
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
    openlabel,
    calibration,
    trajectory,
    mapGeometry,
    unknown,
    errors,
  };
}

/** Max bytes read when sniffing a `.json` drop for the OpenLABEL marker. A
 *  conformant file opens with `{ "openlabel": { ... } }`, so the key sits in
 *  the first few hundred bytes; cap the read so a giant unrelated `.json`
 *  isn't slurped whole just to classify it. */
const OPENLABEL_SNIFF_BYTES = 64 * 1024;

/**
 * True when `file`'s leading bytes contain a top-level `"openlabel"` JSON key.
 * `.json` is ambiguous in Driveline — Ingest Recipes are JSON too — so the
 * drop path uses this content sniff to tell an ASAM OpenLABEL annotation file
 * apart from a recipe before routing it to the 3D scene pipeline. Reads only
 * the file head (`OPENLABEL_SNIFF_BYTES`); never throws (returns `false` on
 * any read/decode error so the caller falls back to the recipe/unknown flow).
 */
export async function sniffOpenlabel(file: File): Promise<boolean> {
  try {
    const head = file.slice(0, OPENLABEL_SNIFF_BYTES);
    const text = await head.text();
    return /"openlabel"\s*:/i.test(text);
  } catch {
    return false;
  }
}

/**
 * Same OpenLABEL content sniff as `sniffOpenlabel`, over already-decoded
 * bytes rather than a `File`. The dev-hook path constructs `File`s from
 * `{ name, bytes }`, so both paths share the marker test.
 */
export function sniffOpenlabelBytes(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, OPENLABEL_SNIFF_BYTES);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  return /"openlabel"\s*:/i.test(text);
}

/**
 * True when `file`'s leading bytes contain the `driveline.calibration/v1`
 * schema marker. `.json`/`.calib.json` is ambiguous (recipes and OpenLABEL are
 * JSON too), so the drop path uses this content sniff to route a calibration
 * file to the point-cloud-on-video overlay. Reads only the file head; never
 * throws (returns `false` on any read/decode error so the caller falls back).
 */
export async function sniffCalibration(file: File): Promise<boolean> {
  try {
    const head = file.slice(0, OPENLABEL_SNIFF_BYTES);
    const text = await head.text();
    return /driveline\.calibration\/v1/.test(text);
  } catch {
    return false;
  }
}

/** Same calibration content sniff as `sniffCalibration`, over decoded bytes. */
export function sniffCalibrationBytes(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, OPENLABEL_SNIFF_BYTES);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  return /driveline\.calibration\/v1/.test(text);
}

/** Max bytes read when sniffing a `.json` drop for the trajectory marker —
 *  same budget and rationale as `OPENLABEL_SNIFF_BYTES`. */
const TRAJECTORY_SNIFF_BYTES = 64 * 1024;

/**
 * True when `file`'s leading bytes contain a top-level `"trajectory"` JSON key.
 * `.json` is ambiguous in Driveline (Ingest Recipes and OpenLABEL are JSON
 * too), so the drop path uses this content sniff to tell a predicted-trajectory
 * file apart before routing it to the 3D scene pipeline. Reads only the file
 * head (`TRAJECTORY_SNIFF_BYTES`); never throws (returns `false` on any
 * read/decode error so the caller falls back to the recipe/unknown flow).
 */
export async function sniffTrajectory(file: File): Promise<boolean> {
  try {
    const head = file.slice(0, TRAJECTORY_SNIFF_BYTES);
    const text = await head.text();
    return /"trajectory"\s*:/i.test(text);
  } catch {
    return false;
  }
}

/**
 * Same trajectory content sniff as `sniffTrajectory`, over already-decoded
 * bytes rather than a `File`. The dev-hook path constructs `File`s from
 * `{ name, bytes }`, so both paths share the marker test.
 */
export function sniffTrajectoryBytes(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, TRAJECTORY_SNIFF_BYTES);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  return /"trajectory"\s*:/i.test(text);
}

/** Max bytes read when sniffing a `.json` drop for the `drivelineMap` marker —
 *  same budget and rationale as `OPENLABEL_SNIFF_BYTES`. */
const MAP_GEOMETRY_SNIFF_BYTES = 64 * 1024;

/**
 * True when `file`'s leading bytes contain a top-level `"drivelineMap"` JSON
 * key. `.json` is ambiguous in Driveline (Ingest Recipes, OpenLABEL, and
 * trajectories are JSON too), so the drop path uses this content sniff to tell
 * a simple road-network map file apart before routing it to the 3D scene
 * pipeline. Reads only the file head (`MAP_GEOMETRY_SNIFF_BYTES`); never throws
 * (returns `false` on any read/decode error so the caller falls back to the
 * recipe/unknown flow). OpenDRIVE `.xodr` is routed by extension in
 * `bucketFiles` and never reaches this sniff.
 */
export async function sniffDrivelineMap(file: File): Promise<boolean> {
  try {
    const head = file.slice(0, MAP_GEOMETRY_SNIFF_BYTES);
    const text = await head.text();
    return /"drivelineMap"\s*:/i.test(text);
  } catch {
    return false;
  }
}

/**
 * Same `drivelineMap` content sniff as `sniffDrivelineMap`, over already-decoded
 * bytes rather than a `File`. The dev-hook path constructs `File`s from
 * `{ name, bytes }`, so both paths share the marker test.
 */
export function sniffDrivelineMapBytes(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, MAP_GEOMETRY_SNIFF_BYTES);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  return /"drivelineMap"\s*:/i.test(text);
}

/** The raw-Alpamayo-LiDAR signature: the binary column holding each spin's
 *  Draco blob. Present in the parquet footer schema, absent from any converted
 *  Driveline / tabular parquet. */
const ALPAMAYO_LIDAR_COLUMN = "draco_encoded_pointcloud";

/** Find an ASCII `needle` within `haystack` (byte search; no decode). */
function bytesContainAscii(haystack: Uint8Array, needle: string): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Sniff a `.parquet` drop for the **raw NVIDIA Alpamayo LiDAR** schema so it
 * routes to the in-browser Draco decode path instead of the tabular (scalar)
 * import flow. Both share the `.parquet` extension, so `bucketFiles` leaves
 * these in `tabular` and `openFiles` re-routes the ones that match here.
 *
 * Reads only the parquet **footer** (located via the trailing 4-byte length +
 * `PAR1` magic) and looks for the `draco_encoded_pointcloud` column name in the
 * serialized schema — cheap and exact, no full-file read, no parquet parse.
 */
export async function sniffAlpamayoLidar(file: File): Promise<boolean> {
  try {
    if (file.size < 12) return false;
    const tail = new Uint8Array(await file.slice(file.size - 8).arrayBuffer());
    // Trailing magic must be "PAR1".
    if (
      tail[4] !== 0x50 ||
      tail[5] !== 0x41 ||
      tail[6] !== 0x52 ||
      tail[7] !== 0x31
    ) {
      return false;
    }
    const footerLen =
      tail[0] | (tail[1] << 8) | (tail[2] << 16) | (tail[3] << 24);
    if (footerLen <= 0 || footerLen > file.size - 8) return false;
    const footer = new Uint8Array(
      await file.slice(file.size - 8 - footerLen, file.size - 8).arrayBuffer(),
    );
    return sniffAlpamayoLidarBytes(footer);
  } catch {
    return false;
  }
}

/** The column-name scan of [`sniffAlpamayoLidar`], over already-read parquet
 *  footer bytes — shared with the dev-hook path and unit tests. */
export function sniffAlpamayoLidarBytes(footer: Uint8Array): boolean {
  return bytesContainAscii(footer, ALPAMAYO_LIDAR_COLUMN);
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
