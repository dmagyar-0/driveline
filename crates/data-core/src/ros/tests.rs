//! Tests for the dynamic ROS message decoder.
//!
//! The byte buffers are hand-constructed with explicit comments citing the
//! relevant wire rule (CDR alignment relative to the body start; string length
//! includes the NUL in CDR but not in ROS1) so a reviewer can audit the layout.

use super::msgdef::{ArrayKind, FieldType, MessageRegistry, PrimType};
use super::*;

// ---------------------------------------------------------------------------
// Test message definitions (concatenated ros2msg / ros1 text)
// ---------------------------------------------------------------------------

/// An `sensor_msgs/Imu`-like definition with a Header, two Vector3 and a
/// Quaternion, plus a covariance fixed array.
const IMU_DEF: &str = "\
std_msgs/Header header
geometry_msgs/Quaternion orientation
float64[9] orientation_covariance
geometry_msgs/Vector3 angular_velocity
geometry_msgs/Vector3 linear_acceleration
================================================================================
MSG: std_msgs/Header
uint32 seq
time stamp
string frame_id
================================================================================
MSG: geometry_msgs/Vector3
float64 x
float64 y
float64 z
================================================================================
MSG: geometry_msgs/Quaternion
float64 x
float64 y
float64 z
float64 w
";

// ---------------------------------------------------------------------------
// Little helpers to build buffers
// ---------------------------------------------------------------------------

struct Buf {
    bytes: Vec<u8>,
    le: bool,
}

impl Buf {
    /// A CDR buffer: writes the 4-byte encapsulation header. `le` selects
    /// CDR_LE (0x01) vs CDR_BE (0x00). Alignment positions below are computed
    /// relative to the body start (right after this header).
    fn cdr(le: bool) -> Self {
        let rep = if le { 0x01 } else { 0x00 };
        Buf {
            bytes: vec![0x00, rep, 0x00, 0x00],
            le,
        }
    }
    /// A ROS1 buffer: no header, always little-endian, packed.
    fn ros1() -> Self {
        Buf {
            bytes: Vec::new(),
            le: true,
        }
    }
    /// Pad the body to the given alignment (CDR only).
    fn align(&mut self, a: usize) {
        // body offset is bytes.len() - 4 (header).
        let body = self.bytes.len() - 4;
        let rem = body % a;
        if rem != 0 {
            for _ in 0..(a - rem) {
                self.bytes.push(0x00);
            }
        }
    }
    fn u8(&mut self, v: u8) -> &mut Self {
        self.bytes.push(v);
        self
    }
    fn u16(&mut self, v: u16) -> &mut Self {
        let b = if self.le {
            v.to_le_bytes()
        } else {
            v.to_be_bytes()
        };
        self.bytes.extend_from_slice(&b);
        self
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        let b = if self.le {
            v.to_le_bytes()
        } else {
            v.to_be_bytes()
        };
        self.bytes.extend_from_slice(&b);
        self
    }
    fn f64(&mut self, v: f64) -> &mut Self {
        let b = if self.le {
            v.to_le_bytes()
        } else {
            v.to_be_bytes()
        };
        self.bytes.extend_from_slice(&b);
        self
    }
    fn f32(&mut self, v: f32) -> &mut Self {
        let b = if self.le {
            v.to_le_bytes()
        } else {
            v.to_be_bytes()
        };
        self.bytes.extend_from_slice(&b);
        self
    }
    fn raw(&mut self, bytes: &[u8]) -> &mut Self {
        self.bytes.extend_from_slice(bytes);
        self
    }
}

// ===========================================================================
// 1. Parsing
// ===========================================================================

#[test]
fn parse_multi_type_definition() {
    let reg = MessageRegistry::parse("sensor_msgs/Imu", IMU_DEF).unwrap();
    assert_eq!(reg.root(), "sensor_msgs/Imu");

    let root = reg.fields("sensor_msgs/Imu").unwrap();
    assert_eq!(root.len(), 5);
    assert_eq!(root[0].name, "header");
    assert_eq!(root[0].ty, FieldType::Complex("std_msgs/Header".into()));
    assert_eq!(root[0].array, ArrayKind::Single);

    // orientation_covariance is float64[9]
    assert_eq!(root[2].name, "orientation_covariance");
    assert_eq!(root[2].ty, FieldType::Primitive(PrimType::F64));
    assert_eq!(root[2].array, ArrayKind::Fixed(9));

    // Vector3 nested type resolved.
    let v3 = reg.fields("geometry_msgs/Vector3").unwrap();
    assert_eq!(v3.len(), 3);
    assert_eq!(v3[0].name, "x");
    assert_eq!(v3[0].ty, FieldType::Primitive(PrimType::F64));

    // Header explicitly defined in the text takes precedence (has seq).
    let hdr = reg.fields("std_msgs/Header").unwrap();
    assert_eq!(hdr[0].name, "seq");
    assert_eq!(hdr[1].name, "stamp");
    assert_eq!(hdr[1].ty, FieldType::Primitive(PrimType::Time));
    assert_eq!(hdr[2].name, "frame_id");
    assert_eq!(hdr[2].ty, FieldType::Primitive(PrimType::String));
}

#[test]
fn parse_ros2_msg_namespaced_header() {
    // ROS2 schemas use `pkg/msg/Type`; should canonicalise to `pkg/Type`.
    let def = "\
geometry_msgs/msg/Vector3 v
================================================================================
MSG: geometry_msgs/msg/Vector3
float64 x
float64 y
float64 z
";
    let reg = MessageRegistry::parse("my_pkg/msg/Foo", def).unwrap();
    assert_eq!(reg.root(), "my_pkg/Foo");
    let foo = reg.fields("my_pkg/Foo").unwrap();
    assert_eq!(
        foo[0].ty,
        FieldType::Complex("geometry_msgs/Vector3".into())
    );
    assert!(reg.fields("geometry_msgs/Vector3").is_some());
}

#[test]
fn parse_constants_and_comments() {
    let def = "\
int32 FOO=5  # a constant, not a wire field
uint8 status # a real field with a trailing comment
float64 value
";
    let reg = MessageRegistry::parse("p/T", def).unwrap();
    let fields = reg.fields("p/T").unwrap();
    assert_eq!(fields.len(), 2, "constant must not be a wire field");
    assert_eq!(fields[0].name, "status");
    assert_eq!(fields[1].name, "value");
    let consts = reg.consts("p/T").unwrap();
    assert_eq!(consts.len(), 1);
    assert_eq!(consts[0].name, "FOO");
    assert_eq!(consts[0].value, "5");
}

#[test]
fn parse_bare_header_resolves_to_std_msgs() {
    let def = "\
Header header
float64 v
";
    let reg = MessageRegistry::parse("p/T", def).unwrap();
    let f = reg.fields("p/T").unwrap();
    assert_eq!(f[0].ty, FieldType::Complex("std_msgs/Header".into()));
    // Injected builtin std_msgs/Header (ROS2 layout: stamp, frame_id).
    let hdr = reg.fields("std_msgs/Header").unwrap();
    assert_eq!(hdr[0].name, "stamp");
}

#[test]
fn parse_same_package_short_name() {
    let def = "\
Vector3 v
================================================================================
MSG: my_pkg/Vector3
float64 x
";
    let reg = MessageRegistry::parse("my_pkg/Thing", def).unwrap();
    let f = reg.fields("my_pkg/Thing").unwrap();
    // Bare `Vector3` in package my_pkg resolves to my_pkg/Vector3.
    assert_eq!(f[0].ty, FieldType::Complex("my_pkg/Vector3".into()));
}

#[test]
fn idl_definition_is_rejected_not_panicked() {
    let idl = "\
module geometry_msgs {
  struct Vector3 {
    double x;
  };
};
";
    let err = MessageRegistry::parse("geometry_msgs/Vector3", idl).unwrap_err();
    assert_eq!(err, RosDecodeError::IdlUnsupported);
}

// ===========================================================================
// 2. CDR decode
// ===========================================================================

/// Flat struct: uint8 a; (pad) uint32 b; float64 c.
/// Tests alignment after a 1-byte field.
const FLAT_DEF: &str = "\
uint8 a
uint32 b
float64 c
";

fn build_flat_cdr(le: bool) -> Vec<u8> {
    let mut b = Buf::cdr(le);
    // body offset 0: uint8 a (align 1)
    b.u8(0x07);
    // body offset 1: need uint32 b at align 4 -> pad to offset 4
    b.align(4);
    b.u32(0x0000_0100); // 256
                        // body offset 8: float64 c at align 8 -> already aligned (offset 8)
    b.align(8);
    b.f64(2.5);
    b.bytes
}

#[test]
fn cdr_flat_struct_both_endian() {
    let reg = MessageRegistry::parse("p/Flat", FLAT_DEF).unwrap();
    for le in [true, false] {
        let buf = build_flat_cdr(le);
        assert_eq!(
            extract(&reg, &buf, Wire::Cdr, "a").unwrap(),
            Extracted::Enum(7)
        );
        assert_eq!(
            extract(&reg, &buf, Wire::Cdr, "b").unwrap(),
            Extracted::Enum(256)
        );
        assert_eq!(
            extract(&reg, &buf, Wire::Cdr, "c").unwrap(),
            Extracted::Scalar(2.5)
        );
    }
}

const TWIST_DEF: &str = "\
geometry_msgs/Vector3 linear
geometry_msgs/Vector3 angular
================================================================================
MSG: geometry_msgs/Vector3
float64 x
float64 y
float64 z
";

fn build_twist_cdr(le: bool) -> Vec<u8> {
    let mut b = Buf::cdr(le);
    // linear.x,y,z then angular.x,y,z — all float64, body starts at align 0
    // which is 8-aligned already.
    b.f64(1.0).f64(2.0).f64(3.0); // linear
    b.f64(4.0).f64(5.0).f64(6.0); // angular
    b.bytes
}

#[test]
fn cdr_nested_vector3_extract_path() {
    let reg = MessageRegistry::parse("geometry_msgs/Twist", TWIST_DEF).unwrap();
    for le in [true, false] {
        let buf = build_twist_cdr(le);
        assert_eq!(
            extract(&reg, &buf, Wire::Cdr, "linear.x").unwrap(),
            Extracted::Scalar(1.0)
        );
        assert_eq!(
            extract(&reg, &buf, Wire::Cdr, "linear.z").unwrap(),
            Extracted::Scalar(3.0)
        );
        assert_eq!(
            extract(&reg, &buf, Wire::Cdr, "angular.y").unwrap(),
            Extracted::Scalar(5.0)
        );
        // The whole Vector3 leaf flattens to [x,y,z].
        assert_eq!(
            extract(&reg, &buf, Wire::Cdr, "angular").unwrap(),
            Extracted::Vector(vec![4.0, 5.0, 6.0])
        );
    }
}

const ARRAY_DEF: &str = "\
float64[] data
";

fn build_array_cdr(le: bool, vals: &[f64]) -> Vec<u8> {
    let mut b = Buf::cdr(le);
    // dynamic seq: align 4, u32 count, then count*float64 (each align 8).
    b.align(4);
    b.u32(vals.len() as u32);
    // First element aligns to 8: after the u32 count at body offset 0..4,
    // we are at offset 4 -> pad to 8.
    b.align(8);
    for &v in vals {
        b.f64(v);
    }
    b.bytes
}

#[test]
fn cdr_dynamic_float_array() {
    let reg = MessageRegistry::parse("p/Arr", ARRAY_DEF).unwrap();
    for le in [true, false] {
        let buf = build_array_cdr(le, &[1.5, 2.5, 3.5]);
        assert_eq!(
            extract(&reg, &buf, Wire::Cdr, "data").unwrap(),
            Extracted::Vector(vec![1.5, 2.5, 3.5])
        );
    }
}

const STR_THEN_NUM_DEF: &str = "\
string name
uint32 count
";

fn build_str_then_num_cdr(le: bool, name: &str, count: u32) -> Vec<u8> {
    let mut b = Buf::cdr(le);
    // string: align 4 (already 0), u32 length INCLUDING the NUL, then bytes.
    b.align(4);
    let len_with_nul = (name.len() + 1) as u32;
    b.u32(len_with_nul);
    b.raw(name.as_bytes());
    b.u8(0x00); // NUL terminator counted in the length
                // uint32 count: align 4 relative to body start. This is the
                // alignment-after-string check.
    b.align(4);
    b.u32(count);
    b.bytes
}

#[test]
fn cdr_alignment_after_string() {
    let reg = MessageRegistry::parse("p/Named", STR_THEN_NUM_DEF).unwrap();
    for le in [true, false] {
        // "hi" => length 3 (h,i,NUL). String ends at body offset 4+3=7.
        // count must be read at offset 8 (padded from 7 -> 8).
        let buf = build_str_then_num_cdr(le, "hi", 42);
        assert_eq!(
            extract(&reg, &buf, Wire::Cdr, "count").unwrap(),
            Extracted::Enum(42)
        );
    }
}

#[test]
fn cdr_endianness_is_read_from_header() {
    // Build a BE buffer but confirm the decoder follows byte[1], not a guess.
    let reg = MessageRegistry::parse("p/Flat", FLAT_DEF).unwrap();
    let be = build_flat_cdr(false);
    assert_eq!(be[1], 0x00, "BE rep id");
    let le = build_flat_cdr(true);
    assert_eq!(le[1], 0x01, "LE rep id");
    assert_eq!(
        extract(&reg, &be, Wire::Cdr, "b").unwrap(),
        extract(&reg, &le, Wire::Cdr, "b").unwrap()
    );
}

// ===========================================================================
// 3. ROS1 decode (packed LE, no padding, no header)
// ===========================================================================

#[test]
fn ros1_flat_struct_no_padding() {
    let reg = MessageRegistry::parse("p/Flat", FLAT_DEF).unwrap();
    let mut b = Buf::ros1();
    // packed: uint8 a, uint32 b, float64 c — NO padding between them.
    b.u8(0x07);
    b.u32(256);
    b.f64(2.5);
    let buf = b.bytes;
    // 1 + 4 + 8 = 13 bytes, vs CDR which padded to 16.
    assert_eq!(buf.len(), 13);
    assert_eq!(
        extract(&reg, &buf, Wire::Ros1, "a").unwrap(),
        Extracted::Enum(7)
    );
    assert_eq!(
        extract(&reg, &buf, Wire::Ros1, "b").unwrap(),
        Extracted::Enum(256)
    );
    assert_eq!(
        extract(&reg, &buf, Wire::Ros1, "c").unwrap(),
        Extracted::Scalar(2.5)
    );
}

#[test]
fn ros1_nested_vector3() {
    let reg = MessageRegistry::parse("geometry_msgs/Twist", TWIST_DEF).unwrap();
    let mut b = Buf::ros1();
    for v in [1.0, 2.0, 3.0, 4.0, 5.0, 6.0] {
        b.f64(v);
    }
    let buf = b.bytes;
    assert_eq!(
        extract(&reg, &buf, Wire::Ros1, "linear.x").unwrap(),
        Extracted::Scalar(1.0)
    );
    assert_eq!(
        extract(&reg, &buf, Wire::Ros1, "angular").unwrap(),
        Extracted::Vector(vec![4.0, 5.0, 6.0])
    );
}

#[test]
fn ros1_string_no_nul_then_num() {
    let reg = MessageRegistry::parse("p/Named", STR_THEN_NUM_DEF).unwrap();
    let mut b = Buf::ros1();
    // ROS1 string: u32 length WITHOUT NUL, then bytes, then packed u32.
    b.u32(2); // "hi" length, no NUL
    b.raw(b"hi");
    b.u32(42);
    let buf = b.bytes;
    // 4 + 2 + 4 = 10 bytes — and crucially count sits right after "hi" with no
    // padding (CDR would have padded to offset 8).
    assert_eq!(buf.len(), 10);
    assert_eq!(
        extract(&reg, &buf, Wire::Ros1, "count").unwrap(),
        Extracted::Enum(42)
    );
}

#[test]
fn ros1_dynamic_array() {
    let reg = MessageRegistry::parse("p/Arr", ARRAY_DEF).unwrap();
    let mut b = Buf::ros1();
    b.u32(3); // count
    b.f64(1.5).f64(2.5).f64(3.5);
    let buf = b.bytes;
    assert_eq!(
        extract(&reg, &buf, Wire::Ros1, "data").unwrap(),
        Extracted::Vector(vec![1.5, 2.5, 3.5])
    );
}

#[test]
fn ros1_and_cdr_offsets_differ() {
    // Same logical message decodes from different byte layouts: prove the ROS1
    // packed buffer is shorter than the CDR padded one for the flat struct.
    let cdr = build_flat_cdr(true);
    // CDR body padded to 16; +4 header = 20.
    assert_eq!(cdr.len(), 20);
    let mut b = Buf::ros1();
    b.u8(0x07);
    b.u32(256);
    b.f64(2.5);
    assert_eq!(b.bytes.len(), 13);
}

// ===========================================================================
// 4. numeric_leaves enumeration
// ===========================================================================

#[test]
fn numeric_leaves_for_nested_type() {
    let reg = MessageRegistry::parse("geometry_msgs/Twist", TWIST_DEF).unwrap();
    let leaves = numeric_leaves(&reg);
    let paths: Vec<&str> = leaves.iter().map(|l| l.path.as_str()).collect();
    // Vector3 flattens to a vector leaf AND its components are addressable.
    assert!(paths.contains(&"linear"));
    assert!(paths.contains(&"linear.x"));
    assert!(paths.contains(&"linear.y"));
    assert!(paths.contains(&"linear.z"));
    assert!(paths.contains(&"angular"));
    assert!(paths.contains(&"angular.z"));

    // The flattened linear leaf has dims 3.
    let linear = leaves.iter().find(|l| l.path == "linear").unwrap();
    assert_eq!(linear.dims, 3);
    assert_eq!(linear.prim, PrimType::F64);

    // Scalar component dims 1.
    let lx = leaves.iter().find(|l| l.path == "linear.x").unwrap();
    assert_eq!(lx.dims, 1);
}

#[test]
fn numeric_leaves_imu_skips_strings_reports_array() {
    let reg = MessageRegistry::parse("sensor_msgs/Imu", IMU_DEF).unwrap();
    let leaves = numeric_leaves(&reg);
    let paths: Vec<&str> = leaves.iter().map(|l| l.path.as_str()).collect();

    // header.seq is numeric; header.frame_id (string) is skipped.
    assert!(paths.contains(&"header.seq"));
    assert!(!paths.iter().any(|p| p.contains("frame_id")));

    // header.stamp is a `time` primitive -> numeric scalar leaf.
    assert!(paths.contains(&"header.stamp"));

    // Fixed array float64[9] reported once with dims 9.
    let cov = leaves
        .iter()
        .find(|l| l.path == "orientation_covariance")
        .unwrap();
    assert_eq!(cov.dims, 9);

    // Nested Vector3 / Quaternion components addressable.
    assert!(paths.contains(&"angular_velocity.x"));
    assert!(paths.contains(&"orientation.w"));
}

// ===========================================================================
// 5. Round-trip: define, manually serialise, decode, assert
// ===========================================================================

const RT_DEF: &str = "\
std_msgs/Header header
int16 temperature
float32 humidity
================================================================================
MSG: std_msgs/Header
uint32 seq
time stamp
string frame_id
";

#[test]
fn roundtrip_cdr_with_header_and_string() {
    let reg = MessageRegistry::parse("p/Reading", RT_DEF).unwrap();
    let le = true;
    let mut b = Buf::cdr(le);
    // header.seq: uint32 align 4 (body offset 0)
    b.align(4);
    b.u32(99);
    // header.stamp: time = two u32 (sec, nsec), align 4 each. Offset 4 -> ok.
    b.align(4);
    b.u32(1_700_000_000); // sec
    b.u32(123); // nsec
                // header.frame_id: string, align 4 (offset 12 ok), len incl NUL.
    b.align(4);
    let frame = "imu";
    b.u32((frame.len() + 1) as u32);
    b.raw(frame.as_bytes());
    b.u8(0x00);
    // temperature: int16, align 2. After string body offset = 12+4+3+1 = 20 -> aligned.
    b.align(2);
    b.u16((-40i16) as u16);
    // humidity: float32, align 4. body offset now 22 -> pad to 24.
    b.align(4);
    b.f32(55.5);
    let buf = b.bytes;

    assert_eq!(
        extract(&reg, &buf, Wire::Cdr, "header.seq").unwrap(),
        Extracted::Enum(99)
    );
    // time -> ns scalar
    assert_eq!(
        extract(&reg, &buf, Wire::Cdr, "header.stamp").unwrap(),
        Extracted::Scalar(1_700_000_000.0 * 1e9 + 123.0)
    );
    assert_eq!(
        extract(&reg, &buf, Wire::Cdr, "temperature").unwrap(),
        Extracted::Enum(-40)
    );
    assert_eq!(
        extract(&reg, &buf, Wire::Cdr, "humidity").unwrap(),
        Extracted::Scalar(55.5_f32 as f64)
    );
}

#[test]
fn roundtrip_ros1_with_header_and_string() {
    let reg = MessageRegistry::parse("p/Reading", RT_DEF).unwrap();
    let mut b = Buf::ros1();
    // packed, no padding, LE.
    b.u32(99); // seq
    b.u32(1_700_000_000).u32(123); // stamp sec, nsec
    b.u32(3).raw(b"imu"); // frame_id: len without NUL
    b.u16((-40i16) as u16); // temperature
    b.f32(55.5); // humidity
    let buf = b.bytes;

    assert_eq!(
        extract(&reg, &buf, Wire::Ros1, "header.seq").unwrap(),
        Extracted::Enum(99)
    );
    assert_eq!(
        extract(&reg, &buf, Wire::Ros1, "temperature").unwrap(),
        Extracted::Enum(-40)
    );
    assert_eq!(
        extract(&reg, &buf, Wire::Ros1, "humidity").unwrap(),
        Extracted::Scalar(55.5_f32 as f64)
    );
}

// ===========================================================================
// Error paths
// ===========================================================================

#[test]
fn missing_path_errors() {
    let reg = MessageRegistry::parse("p/Flat", FLAT_DEF).unwrap();
    let buf = build_flat_cdr(true);
    let err = extract(&reg, &buf, Wire::Cdr, "nope").unwrap_err();
    assert!(matches!(err, RosDecodeError::PathNotFound(_)));
}

#[test]
fn truncated_payload_errors() {
    let reg = MessageRegistry::parse("p/Flat", FLAT_DEF).unwrap();
    let mut buf = build_flat_cdr(true);
    buf.truncate(6); // header + a couple bytes only
    let err = extract(&reg, &buf, Wire::Cdr, "c").unwrap_err();
    assert!(matches!(err, RosDecodeError::UnexpectedEof { .. }));
}

#[test]
fn short_encapsulation_header_errors() {
    let reg = MessageRegistry::parse("p/Flat", FLAT_DEF).unwrap();
    let err = extract(&reg, &[0x00, 0x01], Wire::Cdr, "a").unwrap_err();
    assert!(matches!(err, RosDecodeError::BadEncapsulation(_)));
}

#[test]
fn string_leaf_is_not_numeric() {
    let reg = MessageRegistry::parse("p/Named", STR_THEN_NUM_DEF).unwrap();
    let buf = build_str_then_num_cdr(true, "hi", 1);
    let err = extract(&reg, &buf, Wire::Cdr, "name").unwrap_err();
    assert!(matches!(err, RosDecodeError::NotNumeric(_)));
}
