//! ROS1 walker — ROS1 (rosbag) wire format.
//!
//! ROS1 serialisation is much simpler than CDR:
//!
//! - **Little-endian** always.
//! - **Packed**: NO alignment padding anywhere.
//! - **No encapsulation header**: the body starts at byte 0.
//! - `string`: `u32` length (**NOT** including a NUL terminator) + `length`
//!   raw bytes.
//! - dynamic array (`T[]`): `u32` count + `count` packed elements.
//! - fixed array (`T[N]`): `N` packed elements, no count prefix.
//! - `time`/`duration`: two `u32` (sec, nsec).
//!
//! Because there is no padding, the byte offsets of fields differ from the CDR
//! encoding of the same message — that difference is exercised by the tests.

use super::error::RosDecodeError;
use super::cdr::Scalar;
use super::msgdef::{ArrayKind, FieldType, MessageRegistry, PrimType};

/// A cursor over a ROS1 packed body (little-endian, no header, no padding).
pub struct Ros1Cursor<'a> {
    body: &'a [u8],
    pos: usize,
}

impl<'a> Ros1Cursor<'a> {
    pub fn new(payload: &'a [u8]) -> Self {
        Ros1Cursor {
            body: payload,
            pos: 0,
        }
    }

    fn ensure(&self, needed: usize) -> Result<(), RosDecodeError> {
        if self.pos + needed > self.body.len() {
            return Err(RosDecodeError::UnexpectedEof {
                offset: self.pos,
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
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn read_u32(&mut self) -> Result<u32, RosDecodeError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn read_u64(&mut self) -> Result<u64, RosDecodeError> {
        let b = self.take(8)?;
        Ok(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    /// ROS1 string: u32 length (no NUL) + bytes.
    fn read_string(&mut self) -> Result<String, RosDecodeError> {
        let len = self.read_u32()? as usize;
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec())
            .map_err(|_| RosDecodeError::BadUtf8("<ros1 string>".to_string()))
    }

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

    fn skip_prim(&mut self, p: PrimType) -> Result<(), RosDecodeError> {
        match p {
            PrimType::String | PrimType::Wstring => {
                self.read_string()?;
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

    /// Read a dynamic array count.
    pub(crate) fn read_count(&mut self) -> Result<usize, RosDecodeError> {
        Ok(self.read_u32()? as usize)
    }

    #[allow(dead_code)]
    pub fn position(&self) -> usize {
        self.pos
    }
}

pub(crate) fn skip_field<'a>(
    cur: &mut Ros1Cursor<'a>,
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
            let count = cur.read_count()?;
            for _ in 0..count {
                skip_one(cur, reg, ty)?;
            }
            Ok(())
        }
    }
}

fn skip_one<'a>(
    cur: &mut Ros1Cursor<'a>,
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
