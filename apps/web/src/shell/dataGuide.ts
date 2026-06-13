// Static catalogue powering the "What can Driveline load?" overlay
// (`DataGuideOverlay`). Pure data, no store reads — it documents the formats
// the Rust core can read and the agent / API-key surfaces, with a concrete
// example for the formats whose contract isn't obvious from the extension
// alone (sidecar layout, content-sniffed JSON, recipe fields, …).
//
// Keep this in sync with `crates/data-core/src/readers/`, `state/bucket.ts`,
// and docs/11–13 when the supported set changes. It mirrors documentation;
// it intentionally does not exercise any runtime behaviour.

/** One readable input format. */
export interface FormatEntry {
  /** Human label, e.g. "MCAP". */
  name: string;
  /** Extensions / how it's recognised, shown as mono chips. */
  exts: readonly string[];
  /** One-line "what it is". */
  blurb: string;
  /** The non-obvious bit: pairing rules, sniffing, schema, gotchas. */
  note?: string;
  /** Optional concrete sample (rendered in a <pre>). */
  example?: string;
}

/** One agent / API-key capability. */
export interface AgentEntry {
  name: string;
  blurb: string;
  note?: string;
  example?: string;
}

export const FORMATS: readonly FormatEntry[] = [
  {
    name: "MCAP",
    exts: [".mcap"],
    blurb:
      "Foxglove / ROS message container — signals, enums and H.264 video side by side.",
    note: "Channels are inferred from each topic's schema name, so a foxglove.CompressedVideo topic becomes a video source automatically. zstd-compressed files are read lazily; LZ4 chunks aren't supported yet. ROS 2 CDR payloads expand to one channel per numeric leaf.",
  },
  {
    name: "MF4 (ASAM MDF4)",
    exts: [".mf4"],
    blurb: "Automotive measurement files from CAN / DAQ toolchains.",
    note: "Master (time) channels are resolved automatically and never shown as selectable signals. Channels that share a name across record groups are disambiguated by group — e.g. Powertrain/EngineSpeed. Variable-length and compressed (##DZ) blocks aren't read.",
  },
  {
    name: "MP4 + timestamps sidecar",
    exts: [".mp4", ".mp4.timestamps"],
    blurb: "Dashcam / camera video paired with an external per-frame clock.",
    note: "Drop the two files together — drive.mp4 pairs with drive.mp4.timestamps. The sidecar is plain UTF-8 text: one `frameIndex<TAB>timestampNs` line per video frame, in order, and the line count must equal the frame count. An .mp4 dropped without a sidecar can instead borrow the time column of a table you load.",
    example: "0\t1532671467005757531\n1\t1532671467038757531\n2\t1532671467071757531",
  },
  {
    name: "Tables (CSV / Parquet)",
    exts: [".csv", ".parquet", ".pq"],
    blurb: "Numeric time-series columns; each becomes a scalar channel.",
    note: "On import you pick the time column and its unit (ns / µs / ms / s) and whether it's an absolute epoch or relative to file start — Driveline guesses sensible defaults from the magnitude. Non-numeric columns are ignored. Integer time columns stay exact (no float round-trip).",
  },
  {
    name: "ROS 1 bag",
    exts: [".bag"],
    blurb: "rosbag v2.0 logs (chunked or unchunked).",
    note: "Every numeric leaf of a message becomes its own channel — /imu/data.angular_velocity.z, /cmd_vel.linear.x. Image-like topics are skipped; bz2/lz4-compressed bags aren't supported.",
  },
  {
    name: "ROS 2 (rosbag2)",
    exts: [".db3"],
    blurb: "rosbag2 SQLite recordings on the CDR wire format.",
    note: "Same per-leaf channel expansion as ROS 1. Message types are resolved from the bag's embedded message_definitions plus a bundled typestore — no local ROS install needed.",
  },
  {
    name: "LiDAR point clouds",
    exts: [".lidar.parquet", ".pcd"],
    blurb: "3D points rendered in the Scene panel.",
    note: ".lidar.parquet is a Driveline schema — one row per 360° spin with t_ns, a flattened positions list (xyz × N, metres) and per-point intensities; it's matched before generic .parquet. .pcd is a single PCL/ROS cloud and reads ASCII, binary, or binary_compressed payloads.",
  },
  {
    name: "OpenLABEL annotations",
    exts: [".json", "content-sniffed"],
    blurb: "ASAM OpenLABEL 3D bounding boxes over the Scene.",
    note: "Recognised by content, not extension: the file must have a top-level \"openlabel\" key. Cuboids may be 10 numbers (position + size + quaternion) or 9 (Euler XYZ), in ISO-8855 vehicle coordinates. Works as a per-frame sequence or a single static set.",
  },
  {
    name: "Predicted trajectories",
    exts: [".json", "content-sniffed"],
    blurb: "Candidate ego future paths drawn in the Scene panel.",
    note: "Also content-sniffed — a top-level \"trajectory\" key. Each frame holds one or more candidate paths with a confidence and a points polyline. 2D points get z = 0; a numeric timestamp above 1e15 is read as nanoseconds, otherwise as seconds.",
    example:
      '{ "trajectory": { "frames": [\n  { "timestamp": 1532671467005757531,\n    "paths": [ { "confidence": 0.92,\n                 "points": [[0,0,0],[1.4,0,0]] } ] } ] } }',
  },
  {
    name: "Anything else — Ingest Recipe",
    exts: [".driveline-recipe.json", "+ your file"],
    blurb:
      "Proprietary DAQ dumps and fixed-record binary logs, via a declarative recipe (JSON, no code).",
    note: "A recipe describes the byte layout — record size, field offsets, dtypes, scale/offset and the time basis — so the Rust core can decode an otherwise-unknown file safely (every read is bounds-checked). Write one by hand, import a .driveline-recipe.json, or let the Format Agent derive it (see the Agents tab). Saved recipes auto-match future files by extension or magic bytes.",
    example:
      '{ "recipeVersion": 1, "name": "Acme DAQ v3",\n  "container": { "type": "fixed_record",\n                 "headerSkipBytes": 64, "recordSizeBytes": 128 },\n  "time": { "field": "t", "unit": "micros", "mode": "absolute" },\n  "fields": [ { "name": "t", "offset": 0, "dtype": "u64" },\n              { "name": "speed", "offset": 8, "dtype": "f32",\n                "scale": 0.01, "unit": "m/s" } ] }',
  },
];

export const AGENTS: readonly AgentEntry[] = [
  {
    name: "Bring Your Own Agent (window.__drivelineAgent)",
    blurb:
      "Drive Driveline from an external agent, notebook or script — no human clicking required.",
    note: "Discovery is always on: getSkill() returns a full how-to guide, describe() lists every capability with its gating, and version reports the API version. Append ?agent to the URL to unlock the mutating ops — move the cursor, play/pause, create and bind panels, add tagged events. Timestamps cross the boundary as decimal strings, and methods return null / false for bad input instead of throwing, so you can probe without try/catch.",
  },
  {
    name: "Push your own data (inline source)",
    blurb:
      "Feed already-decoded channels straight into a session — no file, no format needed.",
    note: "Hand addDataSource() columns of timestamps (decimal-string ns) and values; it returns the new source and channel ids you can drop onto a panel. Mark agent-authored work with origin so reviewers can tell it from human input.",
    example:
      'const s = agent.addDataSource({\n  name: "my-run",\n  channels: [{ name: "vehicle/speed", unit: "m/s",\n              timestampsNs: ["1000","2000"], values: [12.1, 12.4] }],\n});\nconst p = agent.createPanel("plot");\nagent.bindChannels(p, [s.channels[0].id]);',
  },
  {
    name: "Format Agent (Bring Your Own Key)",
    blurb:
      "Let Claude work out an unknown binary format for you, using your own Anthropic API key.",
    note: "When you drop a file Driveline can't read, the unknown-format dialog can decode it with BYOK. Your key is sent only to api.anthropic.com — never to a Driveline server — and stays in memory unless you tick \"Remember on this device\". It samples slices of the file, proposes an Ingest Recipe, and validates it locally before accepting; the saved recipe then reads matching files for free. Tip: mint a dedicated key with a low spend limit.",
  },
];
