//! Dynamic ROS1 / ROS2 message decoder (pure, portable, wasm-safe).
//!
//! This module turns a ROS message-definition (the concatenated text shipped in
//! ROS1 bags and in ROS2 MCAP `ros2msg` schemas) into a [`MessageRegistry`],
//! then walks an encoded payload to pull a single numeric signal (or a small
//! numeric vector) out of it by dot-separated field path.
//!
//! Two wire formats are supported:
//!
//! - [`Wire::Cdr`] — ROS2 OMG-CDR (see [`cdr`]): 4-byte encapsulation header,
//!   self-describing endianness, alignment relative to the body start.
//! - [`Wire::Ros1`] — ROS1 rosbag (see [`ros1`]): little-endian, packed, no
//!   header, no alignment padding.
//!
//! Nothing here uses the filesystem, threads, `web-sys`, or C deps, so it
//! compiles for `wasm32-unknown-unknown`. [`RosDecodeError`] is intentionally
//! standalone (not wired into the crate-wide `Error`) so a later integration
//! pass can add the conversion.

pub mod cdr;
pub mod error;
pub mod msgdef;
pub mod ros1;

pub use error::RosDecodeError;
pub use msgdef::{
    ArrayKind, ConstDef, FieldDef, FieldType, MessageRegistry, PrimType,
};

use cdr::{CdrCursor, Scalar};
use ros1::Ros1Cursor;

/// Which wire format a payload is encoded in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    /// ROS2 OMG-CDR (encapsulated, aligned).
    Cdr,
    /// ROS1 rosbag (packed little-endian).
    Ros1,
}

/// The value pulled out of a message at a field path.
#[derive(Debug, Clone, PartialEq)]
pub enum Extracted {
    /// A single numeric leaf (any float/int primitive, widened to f64).
    Scalar(f64),
    /// A complex leaf that is an all-numeric fixed-width struct or a numeric
    /// array (e.g. `geometry_msgs/Vector3` -> 3 values).
    Vector(Vec<f64>),
    /// An integer leaf preserved exactly (e.g. an enum / status code).
    Enum(i64),
}

/// Describes a numeric leaf path discovered by [`numeric_leaves`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafInfo {
    /// Dot-separated path from the root message to this leaf.
    pub path: String,
    /// The primitive type of the leaf.
    pub prim: PrimType,
    /// 1 for a scalar leaf; N for a fixed-width numeric vector leaf.
    pub dims: usize,
}

// ---------------------------------------------------------------------------
// Shared cursor abstraction
// ---------------------------------------------------------------------------

/// Operations the field walker needs from a wire cursor. Implemented by the
/// CDR and ROS1 cursors so the walk logic is written once.
trait WireCursor<'a> {
    /// Read one numeric primitive scalar (errors on string types).
    fn w_read_numeric(&mut self, p: PrimType) -> Result<Scalar, RosDecodeError>;
    /// Read the `u32` count prefix of a dynamic array/sequence.
    fn w_read_count(&mut self) -> Result<usize, RosDecodeError>;
    /// Structurally skip a whole field (any array kind), advancing the cursor.
    fn w_skip_field(
        &mut self,
        reg: &MessageRegistry,
        ty: &FieldType,
        array: ArrayKind,
    ) -> Result<(), RosDecodeError>;
}

impl<'a> WireCursor<'a> for CdrCursor<'a> {
    fn w_read_numeric(&mut self, p: PrimType) -> Result<Scalar, RosDecodeError> {
        self.read_numeric(p)
    }
    fn w_read_count(&mut self) -> Result<usize, RosDecodeError> {
        // CDR sequence length is a u32 aligned to 4.
        self.read_count_u32()
    }
    fn w_skip_field(
        &mut self,
        reg: &MessageRegistry,
        ty: &FieldType,
        array: ArrayKind,
    ) -> Result<(), RosDecodeError> {
        cdr::skip_field(self, reg, ty, array)
    }
}

impl<'a> WireCursor<'a> for Ros1Cursor<'a> {
    fn w_read_numeric(&mut self, p: PrimType) -> Result<Scalar, RosDecodeError> {
        self.read_numeric(p)
    }
    fn w_read_count(&mut self) -> Result<usize, RosDecodeError> {
        self.read_count()
    }
    fn w_skip_field(
        &mut self,
        reg: &MessageRegistry,
        ty: &FieldType,
        array: ArrayKind,
    ) -> Result<(), RosDecodeError> {
        ros1::skip_field(self, reg, ty, array)
    }
}

// ---------------------------------------------------------------------------
// Public extraction API
// ---------------------------------------------------------------------------

/// Walk `payload` per `registry` (starting at its root type) and return the
/// value at `path` (dot-separated, e.g. `"linear.x"` or `"data"`).
///
/// - A numeric primitive leaf yields [`Extracted::Scalar`] (floats) or
///   [`Extracted::Enum`] (integer leaves preserved exactly).
/// - A complex leaf whose fields are all numeric scalars of fixed width N
///   (e.g. `geometry_msgs/Vector3`), or a numeric array leaf, yields
///   [`Extracted::Vector`].
///
/// The walk only deserialises as far as the target requires: preceding fields
/// are skipped structurally (which is unavoidable since CDR/ROS1 are not
/// random-access), but no value collection happens off-path.
pub fn extract(
    registry: &MessageRegistry,
    payload: &[u8],
    wire: Wire,
    path: &str,
) -> Result<Extracted, RosDecodeError> {
    let segments: Vec<&str> = path.split('.').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err(RosDecodeError::PathNotFound(path.to_string()));
    }
    let root = registry.root().to_string();
    match wire {
        Wire::Cdr => {
            let mut cur = CdrCursor::new(payload)?;
            walk(&mut cur, registry, &root, &segments)
        }
        Wire::Ros1 => {
            let mut cur = Ros1Cursor::new(payload);
            walk(&mut cur, registry, &root, &segments)
        }
    }
}

/// Recursively walk `type_name`'s fields, skipping fields before the one named
/// `segments[0]`, then either descending (more segments) or extracting (leaf).
fn walk<'a, C: WireCursor<'a>>(
    cur: &mut C,
    reg: &MessageRegistry,
    type_name: &str,
    segments: &[&str],
) -> Result<Extracted, RosDecodeError> {
    let target = segments[0];
    let fields = reg
        .fields(type_name)
        .ok_or_else(|| RosDecodeError::UnknownType(type_name.to_string()))?;

    for f in fields {
        if f.name != target {
            // Skip this whole field (any array kind), then continue.
            cur.w_skip_field(reg, &f.ty, f.array)?;
            continue;
        }

        // Found the named field. Decide what to do based on remaining path.
        let is_leaf = segments.len() == 1;

        if is_leaf {
            return extract_leaf(cur, reg, f);
        }

        // Descend into a complex single field.
        match (&f.ty, f.array) {
            (FieldType::Complex(name), ArrayKind::Single) => {
                return walk(cur, reg, name, &segments[1..]);
            }
            // Descending into arrays by path is not supported (no index syntax).
            _ => {
                return Err(RosDecodeError::PathNotFound(format!(
                    "cannot descend into `{target}` (not a single complex field)"
                )));
            }
        }
    }

    Err(RosDecodeError::PathNotFound(target.to_string()))
}

/// Extract the value of a leaf field (`f`) at the current cursor position.
fn extract_leaf<'a, C: WireCursor<'a>>(
    cur: &mut C,
    reg: &MessageRegistry,
    f: &FieldDef,
) -> Result<Extracted, RosDecodeError> {
    match (&f.ty, f.array) {
        // Scalar numeric primitive.
        (FieldType::Primitive(p), ArrayKind::Single) => {
            if matches!(p, PrimType::String | PrimType::Wstring) {
                return Err(RosDecodeError::NotNumeric(f.name.clone()));
            }
            Ok(scalar_to_extracted(*p, cur.w_read_numeric(*p)?))
        }
        // Numeric primitive array (fixed or dynamic) -> Vector.
        (FieldType::Primitive(p), array) => {
            if matches!(p, PrimType::String | PrimType::Wstring) {
                return Err(RosDecodeError::NotNumeric(f.name.clone()));
            }
            let count = match array {
                ArrayKind::Fixed(n) => n,
                ArrayKind::Dynamic => cur.w_read_count()?,
                ArrayKind::Single => unreachable!(),
            };
            let mut out = Vec::with_capacity(count);
            for _ in 0..count {
                out.push(cur.w_read_numeric(*p)?.as_f64());
            }
            Ok(Extracted::Vector(out))
        }
        // A complex single leaf: if it is an all-numeric fixed-width struct,
        // flatten it into a Vector (e.g. Vector3 -> [x,y,z]).
        (FieldType::Complex(name), ArrayKind::Single) => {
            let mut out = Vec::new();
            collect_numeric_struct(cur, reg, name, &mut out)?;
            Ok(Extracted::Vector(out))
        }
        // Complex array leaf is not a single plottable signal.
        (FieldType::Complex(_), _) => Err(RosDecodeError::NotNumeric(f.name.clone())),
    }
}

/// Collect all numeric scalar leaves of a complex type into `out` in field
/// order. Errors if the struct contains a non-numeric field (string) or a
/// nested array — i.e. it must be a flat fixed-width numeric record.
fn collect_numeric_struct<'a, C: WireCursor<'a>>(
    cur: &mut C,
    reg: &MessageRegistry,
    type_name: &str,
    out: &mut Vec<f64>,
) -> Result<(), RosDecodeError> {
    let fields = reg
        .fields(type_name)
        .ok_or_else(|| RosDecodeError::UnknownType(type_name.to_string()))?;
    for f in fields {
        match (&f.ty, f.array) {
            (FieldType::Primitive(p), ArrayKind::Single)
                if !matches!(p, PrimType::String | PrimType::Wstring) =>
            {
                out.push(cur.w_read_numeric(*p)?.as_f64());
            }
            (FieldType::Complex(name), ArrayKind::Single) => {
                collect_numeric_struct(cur, reg, name, out)?;
            }
            _ => {
                return Err(RosDecodeError::NotNumeric(format!(
                    "{type_name}.{} (non-numeric or array field in a flattened struct)",
                    f.name
                )));
            }
        }
    }
    Ok(())
}

fn scalar_to_extracted(p: PrimType, s: Scalar) -> Extracted {
    match (p, s) {
        // Float primitives -> Scalar; integer primitives -> Enum (exact).
        (PrimType::F32 | PrimType::F64, _) => Extracted::Scalar(s_as_f64(s)),
        (PrimType::Time | PrimType::Duration, _) => Extracted::Scalar(s_as_f64(s)),
        (_, Scalar::I(v)) => Extracted::Enum(v),
        (_, Scalar::F(v)) => Extracted::Scalar(v),
    }
}

fn s_as_f64(s: Scalar) -> f64 {
    s.as_f64()
}

// ---------------------------------------------------------------------------
// Leaf enumeration (for auto-surfacing plottable channels)
// ---------------------------------------------------------------------------

/// Enumerate every numeric leaf path reachable from the registry's root type,
/// descending into nested single complex fields and treating all-numeric
/// fixed-width structs / numeric arrays as vector leaves.
///
/// Skips: string fields, and complex arrays / dynamic struct sequences (these
/// are not single plottable channels). A numeric primitive array is reported
/// as one leaf with `dims = N` for fixed arrays, or `dims = 0` for dynamic
/// (length not known statically).
pub fn numeric_leaves(registry: &MessageRegistry) -> Vec<LeafInfo> {
    let mut out = Vec::new();
    let root = registry.root().to_string();
    let mut seen = Vec::new();
    walk_leaves(registry, &root, "", &mut out, &mut seen);
    out
}

fn walk_leaves(
    reg: &MessageRegistry,
    type_name: &str,
    prefix: &str,
    out: &mut Vec<LeafInfo>,
    stack: &mut Vec<String>,
) {
    // Guard against recursive type definitions.
    if stack.iter().any(|t| t == type_name) {
        return;
    }
    let fields = match reg.fields(type_name) {
        Some(f) => f,
        None => return,
    };
    stack.push(type_name.to_string());
    for f in fields {
        let path = if prefix.is_empty() {
            f.name.clone()
        } else {
            format!("{prefix}.{}", f.name)
        };
        match (&f.ty, f.array) {
            // Numeric scalar leaf.
            (FieldType::Primitive(p), ArrayKind::Single)
                if !matches!(p, PrimType::String | PrimType::Wstring) =>
            {
                out.push(LeafInfo {
                    path,
                    prim: *p,
                    dims: 1,
                });
            }
            // Numeric primitive array leaf.
            (FieldType::Primitive(p), ArrayKind::Fixed(n))
                if !matches!(p, PrimType::String | PrimType::Wstring) =>
            {
                out.push(LeafInfo {
                    path,
                    prim: *p,
                    dims: n,
                });
            }
            (FieldType::Primitive(p), ArrayKind::Dynamic)
                if !matches!(p, PrimType::String | PrimType::Wstring) =>
            {
                out.push(LeafInfo {
                    path,
                    prim: *p,
                    dims: 0,
                });
            }
            // Single nested complex: if it flattens to a numeric vector, emit
            // one vector leaf; otherwise descend to enumerate inner leaves.
            (FieldType::Complex(name), ArrayKind::Single) => {
                if let Some(dims) = numeric_struct_width(reg, name, &mut Vec::new()) {
                    // Emit the flattened vector leaf, AND descend so individual
                    // components (e.g. linear.x) remain addressable.
                    let prim = first_numeric_prim(reg, name).unwrap_or(PrimType::F64);
                    out.push(LeafInfo {
                        path: path.clone(),
                        prim,
                        dims,
                    });
                }
                walk_leaves(reg, name, &path, out, stack);
            }
            // String fields and complex arrays are skipped.
            _ => {}
        }
    }
    stack.pop();
}

/// If `type_name` is a flat all-numeric fixed-width struct, return its total
/// scalar width; otherwise `None`.
fn numeric_struct_width(
    reg: &MessageRegistry,
    type_name: &str,
    stack: &mut Vec<String>,
) -> Option<usize> {
    if stack.iter().any(|t| t == type_name) {
        return None;
    }
    let fields = reg.fields(type_name)?;
    stack.push(type_name.to_string());
    let mut total = 0usize;
    for f in fields {
        match (&f.ty, f.array) {
            (FieldType::Primitive(p), ArrayKind::Single)
                if !matches!(p, PrimType::String | PrimType::Wstring) =>
            {
                total += 1;
            }
            (FieldType::Complex(name), ArrayKind::Single) => match numeric_struct_width(
                reg,
                name,
                stack,
            ) {
                Some(w) => total += w,
                None => {
                    stack.pop();
                    return None;
                }
            },
            _ => {
                stack.pop();
                return None;
            }
        }
    }
    stack.pop();
    Some(total)
}

/// The primitive type of the first numeric scalar leaf of a flat struct.
fn first_numeric_prim(reg: &MessageRegistry, type_name: &str) -> Option<PrimType> {
    let fields = reg.fields(type_name)?;
    for f in fields {
        match (&f.ty, f.array) {
            (FieldType::Primitive(p), ArrayKind::Single)
                if !matches!(p, PrimType::String | PrimType::Wstring) =>
            {
                return Some(*p);
            }
            (FieldType::Complex(name), ArrayKind::Single) => {
                if let Some(p) = first_numeric_prim(reg, name) {
                    return Some(p);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests;
