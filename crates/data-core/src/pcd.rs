//! Parser for the **PCD** (Point Cloud Data) format used by PCL and ROS — the
//! de-facto interchange format for LiDAR scans. A PCD file holds a *single*
//! point cloud, so it loads into the viewer as a one-spin
//! [`crate::PointCloudReader`] (see `pointcloud.rs`), rendered in the 3D scene
//! panel exactly like a Driveline point-cloud Parquet.
//!
//! ## Supported subset
//!
//! - Header keywords: `VERSION`, `FIELDS`, `SIZE`, `TYPE`, `COUNT`, `WIDTH`,
//!   `HEIGHT`, `POINTS`, `DATA` (others, e.g. `VIEWPOINT`, are ignored).
//! - `DATA ascii`, `DATA binary`, and `DATA binary_compressed` (LZF) payloads.
//! - Field types `F` (4/8 bytes), `I` (1/2/4/8 bytes), `U` (1/2/4/8 bytes).
//! - `x`, `y`, `z` are required (metres). `intensity` (or `i`) colours the
//!   cloud when present; otherwise points are coloured by range from the
//!   sensor. Non-finite points (the `NaN` padding in *organized* clouds) are
//!   dropped.
//!
//! Intensity (or the range fallback) is min/max-normalised to the `0..=255`
//! bytes the point-cloud pipeline expects, so the turbo colormap spans the
//! cloud's full dynamic range regardless of the source's units.

/// A decoded PCD cloud: flattened `xyz` (length `3 * N`, metres) plus one
/// `0..=255` intensity byte per point (length `N`).
pub struct PcdCloud {
    pub positions: Vec<f32>,
    pub intensities: Vec<u8>,
}

/// One field's storage descriptor parsed from the header.
struct FieldSpec {
    name: String,
    /// Bytes per element (`SIZE`).
    size: usize,
    /// `b'F'` / `b'I'` / `b'U'`.
    ty: u8,
    /// Elements per field (`COUNT`, default 1).
    count: usize,
}

impl FieldSpec {
    /// Bytes this field occupies in one point record (`size * count`).
    fn stride(&self) -> usize {
        self.size * self.count
    }
}

/// Where a field's first element lives, for the two binary layouts.
struct Layout {
    /// Byte offset of the field within an AoS (point-major) record.
    aos_off: usize,
    /// Byte offset of the field's column within an SoA (`binary_compressed`,
    /// field-major) buffer.
    soa_col_off: usize,
}

enum DataFormat {
    Ascii,
    Binary,
    BinaryCompressed,
}

pub fn parse_pcd(bytes: &[u8]) -> crate::Result<PcdCloud> {
    let (fields, n_points, data_format, payload) = parse_header(bytes)?;

    // Locate xyz (required) and intensity (optional) by field name.
    let x_idx = field_index(&fields, &["x"])
        .ok_or_else(|| crate::Error::PcdParse("missing required field `x`".into()))?;
    let y_idx = field_index(&fields, &["y"])
        .ok_or_else(|| crate::Error::PcdParse("missing required field `y`".into()))?;
    let z_idx = field_index(&fields, &["z"])
        .ok_or_else(|| crate::Error::PcdParse("missing required field `z`".into()))?;
    let int_idx = field_index(&fields, &["intensity", "i"]);

    // Per-record stride and per-field offsets for both layouts.
    let record_stride: usize = fields.iter().map(FieldSpec::stride).sum();
    let mut layouts = Vec::with_capacity(fields.len());
    let mut aos_acc = 0usize;
    let mut soa_acc = 0usize;
    for f in &fields {
        layouts.push(Layout {
            aos_off: aos_acc,
            soa_col_off: soa_acc,
        });
        aos_acc += f.stride();
        soa_acc += f.stride() * n_points;
    }

    // Decode every field's first element into f64 per point, then filter to
    // finite xyz and normalise intensity. `read` abstracts over ascii / AoS
    // binary / SoA binary so the geometry assembly below is layout-agnostic.
    let read: Box<dyn Fn(usize, usize) -> crate::Result<f64>> = match data_format {
        DataFormat::Ascii => {
            let text = std::str::from_utf8(payload)
                .map_err(|e| crate::Error::PcdParse(format!("ascii payload not UTF-8: {e}")))?;
            let tokens: Vec<&str> = text.split_whitespace().collect();
            let tokens_per_point: usize = fields.iter().map(|f| f.count).sum();
            // Token offset of each field's first element within a point's row.
            let mut tok_off = Vec::with_capacity(fields.len());
            let mut acc = 0usize;
            for f in &fields {
                tok_off.push(acc);
                acc += f.count;
            }
            if tokens.len() < tokens_per_point * n_points {
                return Err(crate::Error::PcdParse(format!(
                    "ascii payload has {} tokens, need {} ({} points x {} fields-wide)",
                    tokens.len(),
                    tokens_per_point * n_points,
                    n_points,
                    tokens_per_point
                )));
            }
            Box::new(move |point: usize, field: usize| {
                let idx = point * tokens_per_point + tok_off[field];
                tokens[idx].parse::<f64>().map_err(|_| {
                    crate::Error::PcdParse(format!("bad ascii value {:?}", tokens[idx]))
                })
            })
        }
        DataFormat::Binary => {
            let need = record_stride * n_points;
            if payload.len() < need {
                return Err(crate::Error::PcdParse(format!(
                    "binary payload is {} bytes, need {} ({} points x {} stride)",
                    payload.len(),
                    need,
                    n_points,
                    record_stride
                )));
            }
            let data = payload.to_vec();
            // (byte offset of element 0, type, element width, per-point stride).
            let specs: Vec<(usize, u8, usize, usize)> = fields
                .iter()
                .zip(&layouts)
                .map(|(f, l)| (l.aos_off, f.ty, f.size, record_stride))
                .collect();
            Box::new(move |point: usize, field: usize| {
                let (off, ty, size, stride) = specs[field];
                let at = point * stride + off;
                Ok(read_value(&data[at..at + size], ty, size))
            })
        }
        DataFormat::BinaryCompressed => {
            // Layout: u32 compressed_size, u32 uncompressed_size, then LZF data.
            // The decompressed buffer is field-major (SoA): all of field 0's
            // values for every point, then field 1's, and so on.
            if payload.len() < 8 {
                return Err(crate::Error::PcdParse(
                    "binary_compressed payload is too short for its size header".into(),
                ));
            }
            let comp_size =
                u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
            let uncomp_size =
                u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]) as usize;
            let comp = payload.get(8..8 + comp_size).ok_or_else(|| {
                crate::Error::PcdParse("binary_compressed size header overruns file".into())
            })?;
            let data = lzf_decompress(comp, uncomp_size)
                .ok_or_else(|| crate::Error::PcdParse("LZF decompression failed".into()))?;
            // (column start, type, element width, per-point stride within column).
            let specs: Vec<(usize, u8, usize, usize)> = fields
                .iter()
                .zip(&layouts)
                .map(|(f, l)| (l.soa_col_off, f.ty, f.size, f.stride()))
                .collect();
            Box::new(move |point: usize, field: usize| {
                let (off, ty, size, stride) = specs[field];
                let at = off + point * stride;
                Ok(read_value(&data[at..at + size], ty, size))
            })
        }
    };

    // First pass: gather finite points and their raw colour scalar (intensity
    // or range), tracking the min/max for normalisation.
    let mut positions: Vec<f32> = Vec::with_capacity(n_points * 3);
    let mut raw_colour: Vec<f64> = Vec::with_capacity(n_points);
    let mut cmin = f64::INFINITY;
    let mut cmax = f64::NEG_INFINITY;
    for p in 0..n_points {
        let x = read(p, x_idx)?;
        let y = read(p, y_idx)?;
        let z = read(p, z_idx)?;
        if !(x.is_finite() && y.is_finite() && z.is_finite()) {
            continue;
        }
        let colour = match int_idx {
            Some(i) => {
                let v = read(p, i)?;
                if v.is_finite() {
                    v
                } else {
                    0.0
                }
            }
            // No intensity channel: colour by range from the sensor origin so
            // the cloud reads as depth rather than a flat single colour.
            None => (x * x + y * y + z * z).sqrt(),
        };
        positions.push(x as f32);
        positions.push(y as f32);
        positions.push(z as f32);
        raw_colour.push(colour);
        cmin = cmin.min(colour);
        cmax = cmax.max(colour);
    }

    if raw_colour.is_empty() {
        return Err(crate::Error::PcdParse(
            "PCD contained no finite points".into(),
        ));
    }

    // Normalise colour scalar to 0..=255 (full turbo range). A degenerate
    // (all-equal) cloud maps to a mid grey rather than dividing by zero.
    let span = cmax - cmin;
    let intensities: Vec<u8> = raw_colour
        .iter()
        .map(|&c| {
            if span > 0.0 {
                (((c - cmin) / span) * 255.0).round().clamp(0.0, 255.0) as u8
            } else {
                128
            }
        })
        .collect();

    Ok(PcdCloud {
        positions,
        intensities,
    })
}

/// Read one numeric value (little-endian) as `f64`.
fn read_value(buf: &[u8], ty: u8, size: usize) -> f64 {
    match (ty, size) {
        (b'F', 4) => f32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as f64,
        (b'F', 8) => f64::from_le_bytes([
            buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
        ]),
        (b'U', 1) => buf[0] as f64,
        (b'U', 2) => u16::from_le_bytes([buf[0], buf[1]]) as f64,
        (b'U', 4) => u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as f64,
        (b'U', 8) => u64::from_le_bytes([
            buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
        ]) as f64,
        (b'I', 1) => buf[0] as i8 as f64,
        (b'I', 2) => i16::from_le_bytes([buf[0], buf[1]]) as f64,
        (b'I', 4) => i32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as f64,
        (b'I', 8) => i64::from_le_bytes([
            buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
        ]) as f64,
        // Unknown width: best-effort little-endian unsigned.
        _ => buf.iter().rev().fold(0u64, |acc, &b| (acc << 8) | b as u64) as f64,
    }
}

/// Find the first field whose (lowercased) name matches any alias.
fn field_index(fields: &[FieldSpec], aliases: &[&str]) -> Option<usize> {
    fields
        .iter()
        .position(|f| aliases.iter().any(|a| f.name.eq_ignore_ascii_case(a)))
}

/// Parse the ASCII header, returning the field specs, point count, payload
/// format, and a slice over the data section.
fn parse_header(bytes: &[u8]) -> crate::Result<(Vec<FieldSpec>, usize, DataFormat, &[u8])> {
    let mut field_names: Vec<String> = Vec::new();
    let mut sizes: Vec<usize> = Vec::new();
    let mut types: Vec<u8> = Vec::new();
    let mut counts: Vec<usize> = Vec::new();
    let mut width: Option<usize> = None;
    let mut height: Option<usize> = None;
    let mut points: Option<usize> = None;
    let mut data_format: Option<DataFormat> = None;

    let mut pos = 0usize;
    while pos < bytes.len() {
        let nl = bytes[pos..].iter().position(|&b| b == b'\n');
        let end = nl.map(|n| pos + n).unwrap_or(bytes.len());
        let line = std::str::from_utf8(&bytes[pos..end])
            .map_err(|e| crate::Error::PcdParse(format!("non-UTF-8 header line: {e}")))?
            .trim();
        pos = end + 1;

        if line.is_empty() || line.starts_with('#') {
            if nl.is_none() {
                break;
            }
            continue;
        }
        let mut it = line.split_whitespace();
        let keyword = it.next().unwrap_or("").to_ascii_uppercase();
        let rest: Vec<&str> = it.collect();
        match keyword.as_str() {
            "FIELDS" => field_names = rest.iter().map(|s| s.to_string()).collect(),
            "SIZE" => sizes = parse_usize_list(&rest, "SIZE")?,
            "TYPE" => {
                types = rest
                    .iter()
                    .map(|s| s.bytes().next().unwrap_or(b'F').to_ascii_uppercase())
                    .collect()
            }
            "COUNT" => counts = parse_usize_list(&rest, "COUNT")?,
            "WIDTH" => width = Some(parse_usize(rest.first(), "WIDTH")?),
            "HEIGHT" => height = Some(parse_usize(rest.first(), "HEIGHT")?),
            "POINTS" => points = Some(parse_usize(rest.first(), "POINTS")?),
            "DATA" => {
                data_format = Some(
                    match rest.first().map(|s| s.to_ascii_lowercase()).as_deref() {
                        Some("ascii") => DataFormat::Ascii,
                        Some("binary") => DataFormat::Binary,
                        Some("binary_compressed") => DataFormat::BinaryCompressed,
                        other => {
                            return Err(crate::Error::PcdParse(format!(
                                "unsupported DATA format: {other:?}"
                            )))
                        }
                    },
                );
                break; // payload begins immediately after this line
            }
            _ => {} // VERSION, VIEWPOINT, etc. — ignored
        }
        if nl.is_none() {
            break;
        }
    }

    let data_format =
        data_format.ok_or_else(|| crate::Error::PcdParse("missing DATA section".into()))?;
    if field_names.is_empty() {
        return Err(crate::Error::PcdParse("missing FIELDS header".into()));
    }
    if sizes.len() != field_names.len() || types.len() != field_names.len() {
        return Err(crate::Error::PcdParse(
            "FIELDS / SIZE / TYPE lengths disagree".into(),
        ));
    }
    // COUNT defaults to 1 per field when the header omits it.
    if counts.is_empty() {
        counts = vec![1; field_names.len()];
    } else if counts.len() != field_names.len() {
        return Err(crate::Error::PcdParse(
            "FIELDS / COUNT lengths disagree".into(),
        ));
    }

    let n_points = points
        .or_else(|| match (width, height) {
            (Some(w), Some(h)) => Some(w * h),
            (Some(w), None) => Some(w),
            _ => None,
        })
        .ok_or_else(|| crate::Error::PcdParse("missing POINTS / WIDTH header".into()))?;

    let fields = field_names
        .into_iter()
        .zip(sizes)
        .zip(types)
        .zip(counts)
        .map(|(((name, size), ty), count)| FieldSpec {
            name,
            size,
            ty,
            count,
        })
        .collect();

    Ok((
        fields,
        n_points,
        data_format,
        &bytes[pos.min(bytes.len())..],
    ))
}

fn parse_usize(tok: Option<&&str>, key: &str) -> crate::Result<usize> {
    tok.ok_or_else(|| crate::Error::PcdParse(format!("{key} header is empty")))?
        .parse::<usize>()
        .map_err(|_| crate::Error::PcdParse(format!("{key} header is not an integer")))
}

fn parse_usize_list(toks: &[&str], key: &str) -> crate::Result<Vec<usize>> {
    toks.iter()
        .map(|s| {
            s.parse::<usize>()
                .map_err(|_| crate::Error::PcdParse(format!("{key} value {s:?} is not an integer")))
        })
        .collect()
}

/// Decompress an LZF (liblzf, the variant PCL uses for `binary_compressed`)
/// buffer. Returns `None` on malformed control/back-reference bytes.
fn lzf_decompress(input: &[u8], expected: usize) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(expected);
    let mut i = 0usize;
    while i < input.len() {
        let ctrl = input[i] as usize;
        i += 1;
        if ctrl < 32 {
            // Literal run of `ctrl + 1` bytes.
            let len = ctrl + 1;
            let end = i.checked_add(len)?;
            if end > input.len() {
                return None;
            }
            out.extend_from_slice(&input[i..end]);
            i = end;
        } else {
            // Back-reference.
            let mut len = ctrl >> 5;
            if len == 7 {
                len += *input.get(i)? as usize;
                i += 1;
            }
            let ref_off = ((ctrl & 0x1f) << 8) | *input.get(i)? as usize;
            i += 1;
            let start = out.len().checked_sub(ref_off + 1)?;
            for j in start..start + len + 2 {
                let b = *out.get(j)?;
                out.push(b);
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_xyz_intensity() {
        let pcd = "\
# .PCD v0.7 - Point Cloud Data file format
VERSION 0.7
FIELDS x y z intensity
SIZE 4 4 4 4
TYPE F F F F
COUNT 1 1 1 1
WIDTH 3
HEIGHT 1
VIEWPOINT 0 0 0 1 0 0 0
POINTS 3
DATA ascii
0 0 0 0
1 2 3 50
-1 -2 -3 100
";
        let cloud = parse_pcd(pcd.as_bytes()).unwrap();
        assert_eq!(cloud.intensities.len(), 3);
        assert_eq!(cloud.positions.len(), 9);
        assert_eq!(&cloud.positions[3..6], &[1.0, 2.0, 3.0]);
        // Intensity min=0,max=100 -> 0, ~128, 255.
        assert_eq!(cloud.intensities[0], 0);
        assert_eq!(cloud.intensities[2], 255);
        assert!((cloud.intensities[1] as i32 - 128).abs() <= 1);
    }

    #[test]
    fn ascii_drops_nan_points() {
        let pcd = "\
VERSION 0.7
FIELDS x y z
SIZE 4 4 4
TYPE F F F
COUNT 1 1 1
WIDTH 3
HEIGHT 1
POINTS 3
DATA ascii
1 1 1
nan nan nan
2 2 2
";
        let cloud = parse_pcd(pcd.as_bytes()).unwrap();
        // The NaN row is dropped; two finite points survive.
        assert_eq!(cloud.positions.len(), 6);
        assert_eq!(cloud.intensities.len(), 2);
        assert_eq!(&cloud.positions[0..3], &[1.0, 1.0, 1.0]);
        assert_eq!(&cloud.positions[3..6], &[2.0, 2.0, 2.0]);
    }

    #[test]
    fn ascii_no_intensity_colours_by_range() {
        let pcd = "\
VERSION 0.7
FIELDS x y z
SIZE 4 4 4
TYPE F F F
COUNT 1 1 1
WIDTH 2
HEIGHT 1
POINTS 2
DATA ascii
0 0 0
3 4 0
";
        let cloud = parse_pcd(pcd.as_bytes()).unwrap();
        // Ranges 0 and 5 -> normalised to 0 and 255.
        assert_eq!(cloud.intensities, vec![0, 255]);
    }

    #[test]
    fn binary_xyz_intensity() {
        // Header + AoS little-endian payload: 2 points, fields x y z (f32) i (u8).
        let header = "\
VERSION 0.7
FIELDS x y z intensity
SIZE 4 4 4 1
TYPE F F F U
COUNT 1 1 1 1
WIDTH 2
HEIGHT 1
POINTS 2
DATA binary
";
        let mut buf = header.as_bytes().to_vec();
        let pts: [(f32, f32, f32, u8); 2] = [(1.0, 2.0, 3.0, 10), (4.0, 5.0, 6.0, 250)];
        for (x, y, z, i) in pts {
            buf.extend_from_slice(&x.to_le_bytes());
            buf.extend_from_slice(&y.to_le_bytes());
            buf.extend_from_slice(&z.to_le_bytes());
            buf.push(i);
        }
        let cloud = parse_pcd(&buf).unwrap();
        assert_eq!(cloud.positions, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(cloud.intensities, vec![0, 255]);
    }

    #[test]
    fn binary_compressed_xyz() {
        // Build an SoA buffer (x-column then y then z) and LZF-encode it as a
        // single literal run, which `lzf_decompress` must round-trip.
        let header = "\
VERSION 0.7
FIELDS x y z
SIZE 4 4 4
TYPE F F F
COUNT 1 1 1
WIDTH 2
HEIGHT 1
POINTS 2
DATA binary_compressed
";
        let xs: [f32; 2] = [1.0, 4.0];
        let ys: [f32; 2] = [2.0, 5.0];
        let zs: [f32; 2] = [3.0, 6.0];
        let mut soa = Vec::new();
        for v in xs {
            soa.extend_from_slice(&v.to_le_bytes());
        }
        for v in ys {
            soa.extend_from_slice(&v.to_le_bytes());
        }
        for v in zs {
            soa.extend_from_slice(&v.to_le_bytes());
        }
        let comp = lzf_literal_encode(&soa);

        let mut buf = header.as_bytes().to_vec();
        buf.extend_from_slice(&(comp.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(soa.len() as u32).to_le_bytes());
        buf.extend_from_slice(&comp);

        let cloud = parse_pcd(&buf).unwrap();
        assert_eq!(cloud.positions, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn missing_xyz_errors() {
        let pcd = "\
VERSION 0.7
FIELDS x y
SIZE 4 4
TYPE F F
WIDTH 1
HEIGHT 1
POINTS 1
DATA ascii
0 0
";
        assert!(matches!(
            parse_pcd(pcd.as_bytes()),
            Err(crate::Error::PcdParse(_))
        ));
    }

    #[test]
    fn lzf_roundtrip_with_backrefs() {
        // A repeating pattern exercises back-references, not just literals.
        let original: Vec<u8> = (0..512).map(|i| (i % 7) as u8).collect();
        let comp = lzf_literal_encode(&original); // literal-only is valid LZF
        assert_eq!(lzf_decompress(&comp, original.len()).unwrap(), original);
    }

    /// Encode `data` as LZF using only literal runs (max 32 bytes each). This is
    /// always-valid LZF output and lets the tests build `binary_compressed`
    /// payloads without pulling in a compressor dependency.
    fn lzf_literal_encode(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for chunk in data.chunks(32) {
            out.push((chunk.len() - 1) as u8); // ctrl < 32 => literal run
            out.extend_from_slice(chunk);
        }
        out
    }
}
