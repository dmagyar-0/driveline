//! Central `SourceKind` → reader registry.
//!
//! Historically the format→reader dispatch lived in two places that drifted:
//! the `data-cli` extension match (which silently omitted formats) and the
//! per-format `open_*` endpoints in `wasm-bindings`. This module is the single
//! source of truth for *which formats can be opened from a single in-memory
//! byte blob, and how* — so a format added here is reachable from every
//! consumer that routes through it, and capability cannot silently diverge.
//!
//! ## What lives here vs. what doesn't
//!
//! Only the **single-blob** open path is centralised: a reader that can be
//! constructed from one `&[u8]` with no extra parameters. That covers MCAP,
//! MF4, ROS1 `.bag`, ROS2 `.db3`, OpenDRIVE `.xodr` map geometry, PCD point
//! clouds, and OpenLABEL.
//!
//! Formats that need more than the bytes — `Mp4SidecarReader` (mp4 + sidecar
//! pair), `TabularReader` (format + time basis), `RecipeReader` (a recipe
//! document), the Parquet point-cloud / calibration / trajectory JSON paths
//! (opened by the worker with extra context) — are *not* registered here; their
//! callers pass the extra inputs directly. `wasm-bindings` keeps its
//! concrete-type slabs (the MCAP video cursor, the MF4/MCAP ranged/OPFS path)
//! and calls the concrete `open*` constructors; the registry exists so the set
//! of *single-blob, extension-dispatchable* formats is enumerated exactly once.

use std::path::Path;

use crate::reader::Reader;
use crate::types::SourceKind;

/// A boxed, format-erased reader. Every single-blob format implements the
/// shared [`Reader`] trait, so one trait object covers them all.
pub type BoxedReader = Box<dyn Reader>;

/// One registered single-blob format: its [`SourceKind`], the lowercase file
/// extensions that map to it (no leading dot), and a constructor from bytes.
pub struct FormatEntry {
    /// The source kind this format produces.
    pub kind: SourceKind,
    /// Lowercase extensions (no dot) that dispatch to this format.
    pub extensions: &'static [&'static str],
    /// Construct a boxed reader from a single byte blob.
    open: fn(&[u8]) -> crate::Result<BoxedReader>,
}

impl FormatEntry {
    /// Open this format from `bytes`.
    pub fn open(&self, bytes: &[u8]) -> crate::Result<BoxedReader> {
        (self.open)(bytes)
    }
}

/// Boxing constructor for any `Reader` whose trait `open(&[u8])` is the real
/// single-blob entry point.
fn open_boxed<R: Reader + 'static>(bytes: &[u8]) -> crate::Result<BoxedReader> {
    Ok(Box::new(R::open(bytes)?))
}

/// MF4's documented byte-slice constructor is `open_slice` (the trait `open`
/// also works, but `open_slice` is the canonical name), so it gets its own thunk.
fn open_mf4(bytes: &[u8]) -> crate::Result<BoxedReader> {
    Ok(Box::new(crate::Mf4Reader::open_slice(bytes)?))
}

/// The registry of every single-blob format, in a stable order. Adding a format
/// here makes it reachable from every consumer that routes through the registry
/// (today: the `data-cli` extension dispatcher).
pub const FORMATS: &[FormatEntry] = &[
    FormatEntry {
        kind: SourceKind::Mcap,
        extensions: &["mcap"],
        open: open_boxed::<crate::McapReader>,
    },
    FormatEntry {
        kind: SourceKind::Mf4,
        extensions: &["mf4"],
        open: open_mf4,
    },
    FormatEntry {
        kind: SourceKind::Ros1,
        extensions: &["bag"],
        open: open_boxed::<crate::Ros1BagReader>,
    },
    FormatEntry {
        // ROS2 db3 bags report as `Mcap` (logically an MCAP-like CDR source);
        // see `Ros2Db3Reader`. The extension is what disambiguates the file.
        kind: SourceKind::Mcap,
        extensions: &["db3"],
        open: open_boxed::<crate::Ros2Db3Reader>,
    },
    FormatEntry {
        kind: SourceKind::MapGeometry,
        extensions: &["xodr"],
        open: open_boxed::<crate::MapGeometryReader>,
    },
    FormatEntry {
        kind: SourceKind::Lidar,
        extensions: &["pcd"],
        open: open_boxed::<crate::PointCloudReader>,
    },
    FormatEntry {
        kind: SourceKind::OpenLabel,
        extensions: &["openlabel"],
        open: open_boxed::<crate::OpenLabelReader>,
    },
];

/// Look up the [`FormatEntry`] for a lowercase extension (no leading dot).
pub fn entry_for_extension(ext: &str) -> Option<&'static FormatEntry> {
    FORMATS.iter().find(|e| e.extensions.contains(&ext))
}

/// Open `bytes` with the reader registered for `ext` (a lowercase extension, no
/// dot). Returns `None` if no single-blob format matches the extension — the
/// caller decides how to report an unsupported extension (and may still handle
/// parameterised formats such as tabular/recipe/mp4 itself).
pub fn open_by_extension(ext: &str, bytes: &[u8]) -> Option<crate::Result<BoxedReader>> {
    entry_for_extension(ext).map(|e| e.open(bytes))
}

/// Open the file at `path` from its already-read `bytes`, dispatching on the
/// (lowercased) extension through the registry. `None` means the extension is
/// not a registered single-blob format.
pub fn open_path(path: &Path, bytes: &[u8]) -> Option<crate::Result<BoxedReader>> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    open_by_extension(&ext, bytes)
}

/// All registered extensions, in registry order, for building help/error text
/// (e.g. the CLI's "unsupported extension" message) from one source of truth.
pub fn supported_extensions() -> Vec<&'static str> {
    FORMATS
        .iter()
        .flat_map(|e| e.extensions.iter().copied())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatches_mcap_by_extension() {
        let bytes = crate::fixtures::short_mcap_bytes().unwrap();
        let reader = open_by_extension("mcap", &bytes).unwrap().unwrap();
        assert_eq!(reader.meta().kind, SourceKind::Mcap);
    }

    #[test]
    fn dispatches_mf4_by_extension() {
        let bytes = crate::fixtures::short_mf4_bytes().unwrap();
        let reader = open_by_extension("mf4", &bytes).unwrap().unwrap();
        assert_eq!(reader.meta().kind, SourceKind::Mf4);
    }

    #[test]
    fn unknown_extension_is_none() {
        assert!(open_by_extension("xyz", b"nope").is_none());
        assert!(entry_for_extension("xyz").is_none());
    }

    #[test]
    fn supported_extensions_include_every_format() {
        let exts = supported_extensions();
        for want in ["mcap", "mf4", "bag", "db3", "xodr", "pcd", "openlabel"] {
            assert!(exts.contains(&want), "missing extension {want}");
        }
    }
}
