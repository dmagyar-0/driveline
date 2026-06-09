//! CDR walker — ROS2 wire format.
//!
//! ROS2 serialises messages with OMG CDR (the "XCDR1 / plain CDR" subset that
//! `rclcpp`/`rmw` produce). The decoder here walks a payload dynamically given
//! a [`MessageRegistry`], without generating per-type code.
//!
//! ## Encapsulation header
//! Every CDR payload begins with a 4-byte encapsulation header:
//!
//! ```text
//! byte 0 : 0x00            (reserved)
//! byte 1 : representation id
//! byte 2 : options hi
//! byte 3 : options lo
//! ```
//!
//! The representation id selects endianness:
//!
//! | value | meaning            |
//! | ----- | ------------------ |
//! | 0x00  | CDR_BE (big)       |
//! | 0x01  | CDR_LE (little)    |
//! | 0x02  | PL_CDR_BE (big)    |
//! | 0x03  | PL_CDR_LE (little) |
//!
//! So endianness is big when `byte[1]` is even, little when odd.
//!
//! ## Alignment (the important rule)
//! The CDR body starts at offset 4. **All alignment offsets are computed
//! relative to the start of the body**, i.e. body offset 0 == buffer offset 4.
//! Each primitive aligns to its own size:
//!
//! | size | types                                   |
//! | ---- | --------------------------------------- |
//! | 8    | int64/uint64/float64                    |
//! | 4    | int32/uint32/float32, string/seq length |
//! | 2    | int16/uint16                            |
//! | 1    | int8/uint8/bool/byte/char               |
//!
//! Padding bytes are inserted before a read to reach the required alignment.
//!
//! ## Strings
//! `string`: align 4, read a `u32` length that **includes the NUL
//! terminator**, then `length` bytes (the last is the NUL). The decoded string
//! is `length - 1` bytes. `wstring` is decoded as UTF-16 here; the length
//! field is a `u32` count of **bytes** (the ROS2 / Fast-CDR convention), with
//! no terminator.
//!
//! ## Arrays
//! - Dynamic (`T[]`): align 4, read a `u32` count, then `count` elements (each
//!   element aligned per its own type).
//! - Fixed (`T[N]`): `N` elements back-to-back, **no** count prefix.
//!
//! Nested complex types recurse with *continued* alignment — there is no
//! realignment reset at a struct boundary.

use super::error::RosDecodeError;
use super::msgdef::{ArrayKind, FieldType, MessageRegistry, PrimType};

/// Endianness selected by the encapsulation header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endian {
    Big,
    Little,
}

/// A cursor over a CDR body. `body` excludes the 4-byte encapsulation header,
/// so `pos` *is* the alignment position (body offset 0 == alignment 0).
pub struct CdrCursor<'a> {
    body: &'a [u8],
    pos: usize,
    endian: Endian,
    /// Buffer offset of the body start (4), used only for error reporting so
    /// the reported offset matches the original buffer.
    base: usize,
}

impl<'a> CdrCursor<'a> {
    /// Build a cursor from a full payload (including the 4-byte header).
    pub fn new(payload: &'a [u8]) -> Result<Self, RosDecodeError> {
        if payload.len() < 4 {
            return Err(RosDecodeError::BadEncapsulation(format!(
                "payload is {} bytes, need >= 4 for the encapsulation header",
                payload.len()
            )));
        }
        // byte[1] selects endianness: even => big, odd => little.
        let endian = if payload[1] & 0x01 == 0 {
            Endian::Big
        } else {
            Endian::Little
        };
        Ok(CdrCursor {
            body: &payload[4..],
            pos: 0,
            endian,
            base: 4,
        })
    }

    /// The selected endianness.
    pub fn endian(&self) -> Endian {
        self.endian
    }

    /// Advance `pos` to the next multiple of `align` (alignment relative to the
    /// body start — CDR rule).
    fn align_to(&mut self, align: usize) {
        debug_assert!(align.is_power_of_two());
        let rem = self.pos % align;
        if rem != 0 {
            self.pos += align - rem;
        }
    }

    fn ensure(&self, needed: usize) -> Result<(), RosDecodeError> {
        if self.pos + needed > self.body.len() {
            return Err(RosDecodeError::UnexpectedEof {
                offset: self.base + self.pos,
                needed,
                remaining: self.body.len().saturating_sub(self.pos),
            });
        }
        Ok(())
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], RosDecodeError> {
        self.ensure(n)?;
        let s = &self.body[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn read_u8(&mut self) -> Result<u8, RosDecodeError> {
        Ok(self.take(1)?[0])
    }

    fn read_u16(&mut self) -> Result<u16, RosDecodeError> {
        self.align_to(2);
        let b = self.take(2)?;
        let a = [b[0], b[1]];
        Ok(match self.endian {
            Endian::Big => u16::from_be_bytes(a),
            Endian::Little => u16::from_le_bytes(a),
        })
    }

    fn read_u32(&mut self) -> Result<u32, RosDecodeError> {
        self.align_to(4);
        let b = self.take(4)?;
        let a = [b[0], b[1], b[2], b[3]];
        Ok(match self.endian {
            Endian::Big => u32::from_be_bytes(a),
            Endian::Little => u32::from_le_bytes(a),
        })
    }

    fn read_u64(&mut self) -> Result<u64, RosDecodeError> {
        self.align_to(8);
        let b = self.take(8)?;
        let a = [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]];
        Ok(match self.endian {
            Endian::Big => u64::from_be_bytes(a),
            Endian::Little => u64::from_le_bytes(a),
        })
    }

    /// Read a length-prefixed `string`. Length includes the NUL terminator.
    fn read_string(&mut self) -> Result<String, RosDecodeError> {
        let len = self.read_u32()? as usize;
        if len == 0 {
            // Malformed but tolerate as empty.
            return Ok(String::new());
        }
        let bytes = self.take(len)?;
        // Drop the trailing NUL terminator (last byte).
        let content = &bytes[..len - 1];
        String::from_utf8(content.to_vec())
            .map_err(|_| RosDecodeError::BadUtf8("<cdr string>".to_string()))
    }

    /// Read a `wstring` as UTF-16 (length field is a byte count, no NUL).
    fn read_wstring(&mut self) -> Result<String, RosDecodeError> {
        let byte_len = self.read_u32()? as usize;
        let bytes = self.take(byte_len)?;
        let mut units = Vec::with_capacity(byte_len / 2);
        for pair in bytes.chunks_exact(2) {
            let a = [pair[0], pair[1]];
            units.push(match self.endian {
                Endian::Big => u16::from_be_bytes(a),
                Endian::Little => u16::from_le_bytes(a),
            });
        }
        String::from_utf16(&units).map_err(|_| RosDecodeError::BadUtf8("<cdr wstring>".to_string()))
    }

    /// Read a CDR sequence/array length prefix (`u32`, aligned to 4).
    pub(crate) fn read_count_u32(&mut self) -> Result<usize, RosDecodeError> {
        self.read_u32().map(|v| v as usize)
    }

    /// Current body offset (alignment position). Exposed for callers/tests.
    #[allow(dead_code)]
    pub fn position(&self) -> usize {
        self.pos
    }
}

/// Numeric width of a primitive's wire alignment.
fn prim_align(p: PrimType) -> usize {
    match p {
        PrimType::Bool
        | PrimType::Byte
        | PrimType::Char
        | PrimType::I8
        | PrimType::U8
        | PrimType::String
        | PrimType::Wstring => 1,
        PrimType::I16 | PrimType::U16 => 2,
        PrimType::I32 | PrimType::U32 | PrimType::F32 => 4,
        // time/duration are two u32, aligned as u32 (4).
        PrimType::Time | PrimType::Duration => 4,
        PrimType::I64 | PrimType::U64 | PrimType::F64 => 8,
    }
}

/// Read one primitive scalar and return it widened to f64 (and the raw i64 for
/// integer leaves so `extract` can preserve exact integer enums elsewhere).
#[derive(Debug, Clone, Copy)]
pub(crate) enum Scalar {
    F(f64),
    I(i64),
}

impl Scalar {
    pub(crate) fn as_f64(&self) -> f64 {
        match self {
            Scalar::F(v) => *v,
            Scalar::I(v) => *v as f64,
        }
    }
}

impl<'a> CdrCursor<'a> {
    /// Read one numeric primitive scalar (not string). For `Time`/`Duration`
    /// this reads `sec` then `nsec` and returns `sec*1e9 + nsec` as f64.
    pub(crate) fn read_numeric(&mut self, p: PrimType) -> Result<Scalar, RosDecodeError> {
        Ok(match p {
            PrimType::Bool | PrimType::U8 | PrimType::Byte | PrimType::Char => {
                Scalar::I(self.read_u8()? as i64)
            }
            PrimType::I8 => Scalar::I(self.read_u8()? as i8 as i64),
            PrimType::U16 => Scalar::I(self.read_u16()? as i64),
            PrimType::I16 => Scalar::I(self.read_u16()? as i16 as i64),
            PrimType::U32 => Scalar::I(self.read_u32()? as i64),
            PrimType::I32 => Scalar::I(self.read_u32()? as i32 as i64),
            PrimType::U64 => Scalar::I(self.read_u64()? as i64),
            PrimType::I64 => Scalar::I(self.read_u64()? as i64),
            PrimType::F32 => Scalar::F(f32::from_bits(self.read_u32()?) as f64),
            PrimType::F64 => Scalar::F(f64::from_bits(self.read_u64()?)),
            PrimType::Time | PrimType::Duration => {
                let sec = self.read_u32()? as i64;
                let nsec = self.read_u32()? as i64;
                Scalar::F((sec * 1_000_000_000 + nsec) as f64)
            }
            PrimType::String | PrimType::Wstring => {
                return Err(RosDecodeError::NotNumeric("<string>".to_string()))
            }
        })
    }

    /// Structurally skip one primitive value (any kind, including strings).
    fn skip_prim(&mut self, p: PrimType) -> Result<(), RosDecodeError> {
        match p {
            PrimType::String => {
                self.read_string()?;
            }
            PrimType::Wstring => {
                self.read_wstring()?;
            }
            PrimType::Time | PrimType::Duration => {
                self.read_u32()?;
                self.read_u32()?;
            }
            _ => {
                self.read_numeric(p)?;
            }
        }
        Ok(())
    }
}

/// Skip an entire field (respecting its array kind) without collecting values.
pub(crate) fn skip_field<'a>(
    cur: &mut CdrCursor<'a>,
    reg: &MessageRegistry,
    ty: &FieldType,
    array: ArrayKind,
) -> Result<(), RosDecodeError> {
    match array {
        ArrayKind::Single => skip_one(cur, reg, ty),
        ArrayKind::Fixed(n) => {
            for _ in 0..n {
                skip_one(cur, reg, ty)?;
            }
            Ok(())
        }
        ArrayKind::Dynamic => {
            let count = cur.read_u32()? as usize;
            for _ in 0..count {
                skip_one(cur, reg, ty)?;
            }
            Ok(())
        }
    }
}

fn skip_one<'a>(
    cur: &mut CdrCursor<'a>,
    reg: &MessageRegistry,
    ty: &FieldType,
) -> Result<(), RosDecodeError> {
    match ty {
        FieldType::Primitive(p) => cur.skip_prim(*p),
        FieldType::Complex(name) => {
            let fields = reg
                .fields(name)
                .ok_or_else(|| RosDecodeError::UnknownType(name.clone()))?;
            for f in fields {
                skip_field(cur, reg, &f.ty, f.array)?;
            }
            Ok(())
        }
    }
}

/// Align hint for a complex type: the max alignment of its first primitive,
/// computed by recursion. Used only by the structural walker indirectly; the
/// per-primitive `align_to` calls inside reads handle real alignment, so this
/// is not needed for correctness. Kept for documentation/testing.
#[allow(dead_code)]
pub(crate) fn prim_align_of(p: PrimType) -> usize {
    prim_align(p)
}
