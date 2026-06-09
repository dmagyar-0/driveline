//! ROS message-definition parser.
//!
//! Parses the concatenated message-definition text used by ROS1 bags and by
//! ROS2 MCAP schemas with the `ros2msg` encoding into a [`MessageRegistry`]:
//! a table from fully-qualified type name to its ordered list of wire fields.
//!
//! The concatenated format is:
//!
//! ```text
//! <top-level type's fields>
//! ================================================================================
//! MSG: pkg/Type            (ROS1) or  MSG: pkg/msg/Type  (ROS2)
//! <that type's fields>
//! ================================================================================
//! MSG: pkg2/Type2
//! ...
//! ```
//!
//! The separator line is exactly 80 `=` characters. Field lines are
//! `<type> <name>`; comments start with `#`; constant lines (`int32 NAME=5`)
//! are recorded but are *not* wire fields. The IDL encodings (`ros2idl` /
//! `omgidl`) are **not** parsed — [`MessageRegistry::parse`] returns
//! [`RosDecodeError::IdlUnsupported`] for them rather than panicking.

use super::error::RosDecodeError;
use std::collections::HashMap;

/// A primitive ROS field type.
///
/// `Byte` and `Char` are historical aliases for `U8` on the wire (both one
/// unsigned byte). `Time` and `Duration` are each two `u32` (sec, nsec).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrimType {
    Bool,
    Byte,
    Char,
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    F32,
    F64,
    String,
    Wstring,
    Time,
    Duration,
}

impl PrimType {
    /// Match a bare primitive token. Returns `None` for complex types.
    fn from_token(tok: &str) -> Option<Self> {
        Some(match tok {
            "bool" => PrimType::Bool,
            "byte" => PrimType::Byte,
            "char" => PrimType::Char,
            "int8" => PrimType::I8,
            "uint8" => PrimType::U8,
            "int16" => PrimType::I16,
            "uint16" => PrimType::U16,
            "int32" => PrimType::I32,
            "uint32" => PrimType::U32,
            "int64" => PrimType::I64,
            "uint64" => PrimType::U64,
            "float32" => PrimType::F32,
            "float64" => PrimType::F64,
            "string" => PrimType::String,
            "wstring" => PrimType::Wstring,
            "time" => PrimType::Time,
            "duration" => PrimType::Duration,
            _ => return None,
        })
    }

    /// True for the numeric primitives (everything except strings).
    /// `Time`/`Duration` are treated as non-scalar composites elsewhere.
    pub fn is_numeric_scalar(self) -> bool {
        !matches!(self, PrimType::String | PrimType::Wstring)
    }
}

/// Whether a field is a single value, a fixed-length array, or a
/// variable-length sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrayKind {
    Single,
    Fixed(usize),
    Dynamic,
}

/// A field's element type: either a primitive or a resolved (fully-qualified)
/// complex type name that can be looked up in the [`MessageRegistry`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldType {
    Primitive(PrimType),
    /// Fully-qualified `pkg/Type` name, resolved against the registry.
    Complex(String),
}

/// One wire field of a message type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldDef {
    pub name: String,
    pub ty: FieldType,
    pub array: ArrayKind,
}

/// A parsed constant declaration (`int32 NAME=5`). Recorded for completeness;
/// constants do not appear on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConstDef {
    pub name: String,
    pub prim: PrimType,
    /// The raw textual value (trimmed). Not type-coerced.
    pub value: String,
}

/// Type table built from a concatenated message definition.
#[derive(Debug, Clone)]
pub struct MessageRegistry {
    root: String,
    fields: HashMap<String, Vec<FieldDef>>,
    consts: HashMap<String, Vec<ConstDef>>,
}

/// Normalise a `MSG:` header / root type into a canonical `pkg/Type` key.
///
/// ROS2 uses `pkg/msg/Type`; we collapse the middle `msg` segment so both
/// `pkg/msg/Type` and `pkg/Type` resolve to the same key. Other interface
/// kinds (`srv`, `action`) are left intact in case they ever appear.
fn canonical_type_name(raw: &str) -> String {
    let raw = raw.trim();
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() == 3 && parts[1] == "msg" {
        format!("{}/{}", parts[0], parts[2])
    } else {
        raw.to_string()
    }
}

/// Strip a trailing `# comment` from a line. The ROS definition format does
/// not allow `#` inside field tokens, so a naive split is correct here.
fn strip_comment(line: &str) -> &str {
    match line.find('#') {
        Some(i) => &line[..i],
        None => line,
    }
}

impl MessageRegistry {
    /// Parse a concatenated message definition.
    ///
    /// `root_type` is the fully-qualified (or `pkg/msg/Type`) name of the
    /// top-level message; its fields are the first block, before any `=`*80
    /// separator. Returns [`RosDecodeError::IdlUnsupported`] if the text looks
    /// like an IDL (`ros2idl`/`omgidl`) definition.
    pub fn parse(root_type: &str, concatenated_def: &str) -> Result<Self, RosDecodeError> {
        // Cheap IDL sniff: real IDL uses `module`/`struct {`. We only parse
        // the line-oriented ros1/ros2msg text.
        if Self::looks_like_idl(concatenated_def) {
            return Err(RosDecodeError::IdlUnsupported);
        }

        let root = canonical_type_name(root_type);
        let mut fields: HashMap<String, Vec<FieldDef>> = HashMap::new();
        let mut consts: HashMap<String, Vec<ConstDef>> = HashMap::new();

        // Split into blocks separated by a line of >=80 `=` characters.
        // Block 0 belongs to `root`; later blocks each start with `MSG: name`.
        let mut current_type = root.clone();
        let mut is_first_block = true;

        // We parse line by line, tracking which package the current type lives
        // in (for resolving same-package bare names) and the current type name.
        let mut current_pkg = package_of(&current_type);

        for raw_line in concatenated_def.lines() {
            let line = strip_comment(raw_line).trim();
            if line.is_empty() {
                continue;
            }

            // Separator between dependent types.
            if is_separator(line) {
                is_first_block = false;
                // The next non-blank line should be `MSG: name`.
                current_type = String::new();
                continue;
            }

            if let Some(rest) = line.strip_prefix("MSG:") {
                current_type = canonical_type_name(rest);
                current_pkg = package_of(&current_type);
                fields.entry(current_type.clone()).or_default();
                continue;
            }

            // A field/constant line. If we just saw a separator but no MSG
            // header, the definition is malformed.
            if current_type.is_empty() {
                return Err(RosDecodeError::Parse(format!(
                    "field line `{line}` not preceded by a `MSG:` header"
                )));
            }

            // Distinguish constants from fields. A constant has `=` in the
            // value portion: `<prim> NAME=value` or `<prim> NAME = value`.
            // Arrays never appear on constants, and only primitives can be
            // constants, so check the type token first.
            let (ty_tok, remainder) = split_type_and_rest(line)?;

            if let Some(eq_pos) = remainder.find('=') {
                // Constant. Only valid for bare primitive (non-array) types.
                if let Some(prim) = PrimType::from_token(ty_tok) {
                    let name = remainder[..eq_pos].trim().to_string();
                    let value = remainder[eq_pos + 1..].trim().to_string();
                    consts
                        .entry(current_type.clone())
                        .or_default()
                        .push(ConstDef { name, prim, value });
                    if is_first_block {
                        // ensure root key exists even if all-constants so far
                        fields.entry(current_type.clone()).or_default();
                    }
                    continue;
                }
                // Complex type with `=` is not a thing; fall through as error.
                return Err(RosDecodeError::Parse(format!(
                    "unexpected `=` in field line `{line}`"
                )));
            }

            let field = parse_field(ty_tok, remainder.trim(), &current_pkg)?;
            fields.entry(current_type.clone()).or_default().push(field);
        }

        let mut reg = MessageRegistry {
            root,
            fields,
            consts,
        };
        reg.inject_builtins();
        Ok(reg)
    }

    /// Inject well-known builtin types if the definition did not include them.
    /// ROS messages commonly reference `Header` / `std_msgs/Header` and
    /// `builtin_interfaces/Time` without an inline `MSG:` block.
    fn inject_builtins(&mut self) {
        if !self.fields.contains_key("std_msgs/Header") {
            // ROS2 std_msgs/Header: builtin_interfaces/Time stamp; string frame_id.
            // (ROS1 had a uint32 seq first, but ROS2 dropped it. We model the
            // ROS2 layout; ROS1 Header is provided explicitly in bag defs so
            // an inline MSG: block, when present, takes precedence over this.)
            self.fields.insert(
                "std_msgs/Header".to_string(),
                vec![
                    FieldDef {
                        name: "stamp".to_string(),
                        ty: FieldType::Complex("builtin_interfaces/Time".to_string()),
                        array: ArrayKind::Single,
                    },
                    FieldDef {
                        name: "frame_id".to_string(),
                        ty: FieldType::Primitive(PrimType::String),
                        array: ArrayKind::Single,
                    },
                ],
            );
        }
        if !self.fields.contains_key("builtin_interfaces/Time") {
            self.fields.insert(
                "builtin_interfaces/Time".to_string(),
                vec![
                    FieldDef {
                        name: "sec".to_string(),
                        ty: FieldType::Primitive(PrimType::I32),
                        array: ArrayKind::Single,
                    },
                    FieldDef {
                        name: "nanosec".to_string(),
                        ty: FieldType::Primitive(PrimType::U32),
                        array: ArrayKind::Single,
                    },
                ],
            );
        }
        if !self.fields.contains_key("builtin_interfaces/Duration") {
            self.fields.insert(
                "builtin_interfaces/Duration".to_string(),
                vec![
                    FieldDef {
                        name: "sec".to_string(),
                        ty: FieldType::Primitive(PrimType::I32),
                        array: ArrayKind::Single,
                    },
                    FieldDef {
                        name: "nanosec".to_string(),
                        ty: FieldType::Primitive(PrimType::U32),
                        array: ArrayKind::Single,
                    },
                ],
            );
        }
    }

    fn looks_like_idl(text: &str) -> bool {
        // IDL definitions declare `module pkg { ... struct Name { ... }; };`.
        // The ros1/ros2msg text never contains `struct` or `module` keywords
        // as standalone tokens.
        text.lines().any(|l| {
            let t = strip_comment(l).trim();
            t.starts_with("module ") || t.starts_with("struct ") || t == "};" || t.ends_with('{')
        })
    }

    /// The canonical name of the top-level type.
    pub fn root(&self) -> &str {
        &self.root
    }

    /// The wire fields of `type_name` (canonicalised), if known.
    pub fn fields(&self, type_name: &str) -> Option<&[FieldDef]> {
        self.fields
            .get(&canonical_type_name(type_name))
            .map(|v| v.as_slice())
    }

    /// The constants declared on `type_name`, if any.
    pub fn consts(&self, type_name: &str) -> Option<&[ConstDef]> {
        self.consts
            .get(&canonical_type_name(type_name))
            .map(|v| v.as_slice())
    }
}

/// Package portion of `pkg/Type`, or empty string if unqualified.
fn package_of(type_name: &str) -> String {
    match type_name.rsplit_once('/') {
        Some((pkg, _)) => pkg.to_string(),
        None => String::new(),
    }
}

/// A separator is a line of exactly 80 `=` (we accept >= 3 to be lenient with
/// real-world generators, but the canonical form is 80).
fn is_separator(line: &str) -> bool {
    line.len() >= 3 && line.bytes().all(|b| b == b'=')
}

/// Split a field line into its type token and the remainder (name [+ value]).
fn split_type_and_rest(line: &str) -> Result<(&str, &str), RosDecodeError> {
    let mut it = line.splitn(2, char::is_whitespace);
    let ty = it
        .next()
        .ok_or_else(|| RosDecodeError::Parse(format!("empty field line `{line}`")))?;
    let rest = it
        .next()
        .ok_or_else(|| RosDecodeError::Parse(format!("field line `{line}` has no name")))?
        .trim();
    Ok((ty, rest))
}

/// Parse the type token (possibly with `[]` / `[N]`) and field name into a
/// [`FieldDef`], resolving complex names against `current_pkg`.
fn parse_field(ty_tok: &str, name: &str, current_pkg: &str) -> Result<FieldDef, RosDecodeError> {
    // Field name may carry whitespace artifacts; the caller trims, but guard.
    let name = name
        .split_whitespace()
        .next()
        .ok_or_else(|| RosDecodeError::Parse(format!("missing field name for `{ty_tok}`")))?
        .to_string();

    // Separate array suffix from the base type.
    let (base, array) = parse_array_suffix(ty_tok)?;

    let ty = match PrimType::from_token(base) {
        Some(p) => FieldType::Primitive(p),
        None => FieldType::Complex(resolve_complex(base, current_pkg)),
    };

    Ok(FieldDef { name, ty, array })
}

/// Split a `base[...]` token into base type and [`ArrayKind`].
fn parse_array_suffix(tok: &str) -> Result<(&str, ArrayKind), RosDecodeError> {
    match tok.find('[') {
        None => Ok((tok, ArrayKind::Single)),
        Some(open) => {
            if !tok.ends_with(']') {
                return Err(RosDecodeError::Parse(format!(
                    "malformed array suffix in `{tok}`"
                )));
            }
            let base = &tok[..open];
            let inner = &tok[open + 1..tok.len() - 1];
            if inner.is_empty() {
                Ok((base, ArrayKind::Dynamic))
            } else {
                // Some ROS2 defs use bounded arrays `T[<=N]`; treat as dynamic.
                let inner = inner.trim_start_matches("<=");
                let n = inner.parse::<usize>().map_err(|_| {
                    RosDecodeError::Parse(format!("bad fixed array size in `{tok}`"))
                })?;
                Ok((base, ArrayKind::Fixed(n)))
            }
        }
    }
}

/// Resolve a bare complex type name to `pkg/Type`.
///
/// - `pkg/Type` and `pkg/msg/Type` are canonicalised as-is.
/// - bare `Header` is special-cased to `std_msgs/Header` (ROS convention).
/// - any other bare `Type` resolves to `<current_pkg>/Type`.
fn resolve_complex(base: &str, current_pkg: &str) -> String {
    if base.contains('/') {
        return canonical_type_name(base);
    }
    if base == "Header" {
        return "std_msgs/Header".to_string();
    }
    if current_pkg.is_empty() {
        base.to_string()
    } else {
        format!("{current_pkg}/{base}")
    }
}
