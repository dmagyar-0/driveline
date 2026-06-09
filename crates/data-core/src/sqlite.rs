//! Minimal, read-only, pure-Rust SQLite file reader — just enough to read the
//! `topics` / `messages` / `message_definitions` tables of a ROS2 rosbag2
//! `.db3` bag directly from its bytes on `wasm32-unknown-unknown` (no C deps,
//! no `sql.js`, std only).
//!
//! Reference: the SQLite database file format,
//! <https://www.sqlite.org/fileformat2.html>. Only the read path is
//! implemented: header validation, the table b-tree (interior + leaf), the
//! record / serial-type decoder, varints, and the overflow-page chain. Indexes,
//! the freelist, WAL, and writes are all out of scope.
//!
//! This module is internal to `data-core`; it is consumed by
//! [`crate::ros2_db3::Ros2Db3Reader`].

use std::collections::HashMap;

/// A decoded SQLite column value. Covers every serial type SQLite can store.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Value {
    /// Borrow the value as a string slice if it is `Text`.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Text(s) => Some(s.as_str()),
            _ => None,
        }
    }

    /// Read the value as an integer (`Int`, or `Real` truncated).
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Int(i) => Some(*i),
            Value::Real(r) => Some(*r as i64),
            _ => None,
        }
    }

    /// Borrow the value as bytes if it is `Blob`.
    pub fn as_blob(&self) -> Option<&[u8]> {
        match self {
            Value::Blob(b) => Some(b.as_slice()),
            _ => None,
        }
    }
}

/// A read-only SQLite database, holding an owned copy of the file bytes.
pub struct SqliteDb {
    bytes: Vec<u8>,
    page_size: usize,
    /// Usable size per page = `page_size - reserved`. SQLite calls this `U`.
    usable: usize,
    /// Text encoding: 1 = UTF-8, 2 = UTF-16le, 3 = UTF-16be.
    text_encoding: u32,
    page_count: usize,
}

/// Parse error type, kept simple (a message). Mapped to
/// [`crate::Error::Ros2Db3`] by the caller.
#[derive(Debug)]
pub struct SqliteError(pub String);

impl std::fmt::Display for SqliteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sqlite: {}", self.0)
    }
}

impl std::error::Error for SqliteError {}

type Result<T> = std::result::Result<T, SqliteError>;

fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(SqliteError(msg.into()))
}

const HEADER_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// Decode a SQLite varint (big-endian base-128, 1..=9 bytes; the 9th byte
/// contributes all 8 of its bits). Returns `(value, bytes_consumed)`.
///
/// <https://www.sqlite.org/fileformat2.html#varint>
pub fn read_varint(buf: &[u8]) -> Result<(i64, usize)> {
    let mut result: u64 = 0;
    for i in 0..9 {
        let byte = *buf
            .get(i)
            .ok_or_else(|| SqliteError("varint runs past end of buffer".into()))?;
        if i == 8 {
            // 9th byte: use all 8 bits.
            result = (result << 8) | byte as u64;
            return Ok((result as i64, 9));
        }
        result = (result << 7) | (byte & 0x7f) as u64;
        if byte & 0x80 == 0 {
            return Ok((result as i64, i + 1));
        }
    }
    // Unreachable: the i == 8 branch always returns.
    err("varint exceeded 9 bytes")
}

/// B-tree page header decoded fields (relative to the page-content start).
struct BtreeHeader {
    page_type: u8,
    cell_count: usize,
    /// Byte offset (within the page) where the cell-pointer array begins.
    cell_pointer_array: usize,
    /// Interior pages carry a right-most child pointer.
    right_most: Option<u32>,
}

impl SqliteDb {
    /// Validate the 100-byte header and take ownership of the file bytes.
    pub fn open(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 100 {
            return err("file shorter than the 100-byte SQLite header");
        }
        if &bytes[0..16] != HEADER_MAGIC {
            return err("bad magic: not a 'SQLite format 3' file");
        }

        // Page size: BE u16 at offset 16; the special value 1 means 65536.
        let raw_page_size = u16::from_be_bytes([bytes[16], bytes[17]]);
        let page_size: usize = if raw_page_size == 1 {
            65536
        } else {
            raw_page_size as usize
        };
        if page_size < 512 || !page_size.is_power_of_two() {
            return err(format!("invalid page size {page_size}"));
        }

        // Reserved space at the end of each page (offset 20, usually 0).
        let reserved = bytes[20] as usize;
        if reserved >= page_size {
            return err("reserved space >= page size");
        }
        let usable = page_size - reserved;

        // Page count: BE u32 at offset 28. May be 0 in older files — derive
        // from the file length in that case.
        let header_page_count = u32::from_be_bytes([bytes[28], bytes[29], bytes[30], bytes[31]]);
        let page_count = if header_page_count == 0 {
            bytes.len() / page_size
        } else {
            header_page_count as usize
        };
        if page_count == 0 {
            return err("file contains no pages");
        }

        // Text encoding: BE u32 at offset 56 (1=UTF-8, 2=UTF-16le, 3=UTF-16be).
        let text_encoding = u32::from_be_bytes([bytes[56], bytes[57], bytes[58], bytes[59]]);
        if !matches!(text_encoding, 1..=3) {
            return err(format!("unknown text encoding {text_encoding}"));
        }

        Ok(SqliteDb {
            bytes: bytes.to_vec(),
            page_size,
            usable,
            text_encoding,
            page_count,
        })
    }

    /// Byte slice for 1-indexed page `n`. Page 1 includes the 100-byte file
    /// header at its start.
    fn page(&self, n: u32) -> Result<&[u8]> {
        if n == 0 || n as usize > self.page_count {
            return err(format!("page {n} out of range (1..={})", self.page_count));
        }
        let start = (n as usize - 1) * self.page_size;
        let end = start + self.page_size;
        self.bytes
            .get(start..end)
            .ok_or_else(|| SqliteError(format!("page {n} extends past end of file")))
    }

    /// Parse a b-tree page header. `page_one` shifts past the 100-byte file
    /// header that prefixes page 1's content.
    fn btree_header(&self, page: &[u8], page_one: bool) -> Result<BtreeHeader> {
        let base = if page_one { 100 } else { 0 };
        let page_type = *page
            .get(base)
            .ok_or_else(|| SqliteError("page too small for b-tree header".into()))?;
        if !matches!(page_type, 0x02 | 0x05 | 0x0a | 0x0d) {
            return err(format!("unknown b-tree page type 0x{page_type:02x}"));
        }
        let interior = matches!(page_type, 0x02 | 0x05);

        // cell count is BE u16 at header offset 3.
        let cell_count = u16::from_be_bytes([page[base + 3], page[base + 4]]) as usize;

        // Header is 8 bytes (leaf) or 12 bytes (interior, with right-most ptr).
        let (header_len, right_most) = if interior {
            let rm = u32::from_be_bytes([
                page[base + 8],
                page[base + 9],
                page[base + 10],
                page[base + 11],
            ]);
            (12usize, Some(rm))
        } else {
            (8usize, None)
        };

        Ok(BtreeHeader {
            page_type,
            cell_count,
            cell_pointer_array: base + header_len,
            right_most,
        })
    }

    /// Assemble a cell's full payload, following the overflow-page chain if it
    /// does not fit inline on the leaf page.
    ///
    /// Overflow threshold for a table-leaf cell (SQLite spec):
    /// - `U` = usable page size, `X = U - 35`.
    /// - If payload length `P <= X`, the whole payload is inline.
    /// - Else `M = ((U - 12) * 32 / 255) - 23` and
    ///   `K = M + ((P - M) % (U - 4))`; the bytes stored on the leaf are
    ///   `K` if `K <= X`, otherwise `M`. The remaining bytes follow a chain
    ///   of overflow pages, each prefixed by a 4-byte big-endian next-page
    ///   pointer (0 terminates) and carrying up to `U - 4` content bytes.
    fn read_payload(
        &self,
        page: &[u8],
        inline_start: usize,
        payload_len: usize,
    ) -> Result<Vec<u8>> {
        let u = self.usable;
        let x = u - 35; // table-leaf threshold
        if payload_len <= x {
            // Fully inline.
            let end = inline_start + payload_len;
            let slice = page
                .get(inline_start..end)
                .ok_or_else(|| SqliteError("inline payload past page end".into()))?;
            return Ok(slice.to_vec());
        }

        // Spilled. Compute how many bytes live on the leaf page.
        let m = ((u - 12) * 32 / 255) - 23;
        let k = m + ((payload_len - m) % (u - 4));
        let local = if k <= x { k } else { m };

        let mut out = Vec::with_capacity(payload_len);
        let leaf_end = inline_start + local;
        let leaf_slice = page
            .get(inline_start..leaf_end)
            .ok_or_else(|| SqliteError("local payload past page end".into()))?;
        out.extend_from_slice(leaf_slice);

        // The 4-byte overflow pointer follows the local bytes on the leaf page.
        let mut next = u32::from_be_bytes([
            *page
                .get(leaf_end)
                .ok_or_else(|| SqliteError("missing overflow pointer".into()))?,
            page[leaf_end + 1],
            page[leaf_end + 2],
            page[leaf_end + 3],
        ]);

        let mut guard = 0usize;
        while next != 0 && out.len() < payload_len {
            guard += 1;
            if guard > self.page_count + 1 {
                return err("overflow page chain too long (corrupt?)");
            }
            let ov = self.page(next)?;
            next = u32::from_be_bytes([ov[0], ov[1], ov[2], ov[3]]);
            let want = (payload_len - out.len()).min(u - 4);
            let content = ov
                .get(4..4 + want)
                .ok_or_else(|| SqliteError("overflow page content past end".into()))?;
            out.extend_from_slice(content);
        }

        if out.len() != payload_len {
            return err(format!(
                "assembled payload {} != declared length {}",
                out.len(),
                payload_len
            ));
        }
        Ok(out)
    }

    /// Visit all leaf cells of a table b-tree rooted at `rootpage`, in rowid
    /// order, pushing `(rowid, record_bytes)` into `out`.
    fn walk_table(&self, rootpage: u32, out: &mut Vec<(i64, Vec<u8>)>) -> Result<()> {
        // Iterative DFS with an explicit stack of pages to visit, preserving
        // left-to-right (ascending rowid) order. We push children in reverse so
        // they pop in order.
        let mut stack: Vec<u32> = vec![rootpage];
        // Bound the number of page visits to avoid infinite loops on a
        // corrupt/cyclic b-tree.
        let mut visits = 0usize;
        let max_visits = self.page_count * 4 + 16;

        while let Some(pageno) = stack.pop() {
            visits += 1;
            if visits > max_visits {
                return err("table b-tree traversal exceeded page budget (cycle?)");
            }
            let page = self.page(pageno)?;
            let page_one = pageno == 1;
            let hdr = self.btree_header(page, page_one)?;

            match hdr.page_type {
                0x0d => {
                    // Leaf table page: decode each cell.
                    for ci in 0..hdr.cell_count {
                        let ptr_off = hdr.cell_pointer_array + ci * 2;
                        let cell_off =
                            u16::from_be_bytes([page[ptr_off], page[ptr_off + 1]]) as usize;
                        // Cell: payload length (varint), rowid (varint), payload.
                        let (payload_len, n1) = read_varint(&page[cell_off..])?;
                        let (rowid, n2) = read_varint(&page[cell_off + n1..])?;
                        let payload_start = cell_off + n1 + n2;
                        let record =
                            self.read_payload(page, payload_start, payload_len as usize)?;
                        out.push((rowid, record));
                    }
                }
                0x05 => {
                    // Interior table page: left-child(BE u32) + rowid(varint)
                    // per cell, plus the right-most pointer. Push children so
                    // they are visited in ascending order.
                    let mut children: Vec<u32> = Vec::with_capacity(hdr.cell_count + 1);
                    for ci in 0..hdr.cell_count {
                        let ptr_off = hdr.cell_pointer_array + ci * 2;
                        let cell_off =
                            u16::from_be_bytes([page[ptr_off], page[ptr_off + 1]]) as usize;
                        let left = u32::from_be_bytes([
                            page[cell_off],
                            page[cell_off + 1],
                            page[cell_off + 2],
                            page[cell_off + 3],
                        ]);
                        children.push(left);
                    }
                    if let Some(rm) = hdr.right_most {
                        children.push(rm);
                    }
                    // Reverse so the first child pops first.
                    for child in children.into_iter().rev() {
                        stack.push(child);
                    }
                }
                other => {
                    return err(format!(
                        "expected table b-tree page (0x05/0x0d), found 0x{other:02x}"
                    ));
                }
            }
        }
        Ok(())
    }

    /// Decode a record (SQLite "record format") into a vector of [`Value`]s in
    /// column order.
    ///
    /// <https://www.sqlite.org/fileformat2.html#record_format>
    fn decode_record(&self, record: &[u8]) -> Result<Vec<Value>> {
        let (header_len, mut off) = read_varint(record)?;
        let header_len = header_len as usize;
        if header_len > record.len() {
            return err("record header length exceeds record");
        }
        // Collect serial types from the header region [off .. header_len).
        let mut serials: Vec<i64> = Vec::new();
        while off < header_len {
            let (st, n) = read_varint(&record[off..])?;
            serials.push(st);
            off += n;
        }

        // Body starts immediately after the header.
        let mut body = header_len;
        let mut values = Vec::with_capacity(serials.len());
        for st in serials {
            let (val, consumed) = self.decode_value(st, &record[body..])?;
            values.push(val);
            body += consumed;
        }
        Ok(values)
    }

    /// Decode one column value given its serial type. Returns the value and the
    /// number of body bytes consumed.
    fn decode_value(&self, serial: i64, body: &[u8]) -> Result<(Value, usize)> {
        let need = |n: usize| -> Result<&[u8]> {
            body.get(0..n)
                .ok_or_else(|| SqliteError("record body shorter than serial type".into()))
        };
        let v = match serial {
            0 => (Value::Null, 0),
            1 => {
                let b = need(1)?;
                (Value::Int(b[0] as i8 as i64), 1)
            }
            2 => {
                let b = need(2)?;
                (Value::Int(i16::from_be_bytes([b[0], b[1]]) as i64), 2)
            }
            3 => {
                let b = need(3)?;
                // 24-bit signed big-endian.
                let mut v = ((b[0] as i64) << 16) | ((b[1] as i64) << 8) | b[2] as i64;
                if v & 0x80_0000 != 0 {
                    v -= 0x100_0000;
                }
                (Value::Int(v), 3)
            }
            4 => {
                let b = need(4)?;
                (
                    Value::Int(i32::from_be_bytes([b[0], b[1], b[2], b[3]]) as i64),
                    4,
                )
            }
            5 => {
                let b = need(6)?;
                // 48-bit signed big-endian.
                let mut v = 0i64;
                for &byte in b {
                    v = (v << 8) | byte as i64;
                }
                if v & 0x8000_0000_0000 != 0 {
                    v -= 0x1_0000_0000_0000;
                }
                (Value::Int(v), 6)
            }
            6 => {
                let b = need(8)?;
                (
                    Value::Int(i64::from_be_bytes([
                        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
                    ])),
                    8,
                )
            }
            7 => {
                let b = need(8)?;
                (
                    Value::Real(f64::from_be_bytes([
                        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
                    ])),
                    8,
                )
            }
            8 => (Value::Int(0), 0),
            9 => (Value::Int(1), 0),
            10 | 11 => {
                // Reserved for internal use; treat as NULL with no body.
                (Value::Null, 0)
            }
            n if n >= 12 && n % 2 == 0 => {
                let len = ((n - 12) / 2) as usize;
                let b = need(len)?;
                (Value::Blob(b.to_vec()), len)
            }
            n if n >= 13 => {
                let len = ((n - 13) / 2) as usize;
                let b = need(len)?;
                let s = self.decode_text(b)?;
                (Value::Text(s), len)
            }
            other => return err(format!("invalid serial type {other}")),
        };
        Ok(v)
    }

    /// Decode a TEXT blob according to the database's text encoding.
    fn decode_text(&self, bytes: &[u8]) -> Result<String> {
        match self.text_encoding {
            1 => String::from_utf8(bytes.to_vec())
                .map_err(|e| SqliteError(format!("invalid UTF-8 text: {e}"))),
            2 | 3 => {
                // UTF-16 best-effort (rosbag2 is always UTF-8, so this is a
                // fallback). 2 = little-endian, 3 = big-endian.
                if !bytes.len().is_multiple_of(2) {
                    return err("UTF-16 text with odd byte length");
                }
                let le = self.text_encoding == 2;
                let units: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|c| {
                        if le {
                            u16::from_le_bytes([c[0], c[1]])
                        } else {
                            u16::from_be_bytes([c[0], c[1]])
                        }
                    })
                    .collect();
                String::from_utf16(&units)
                    .map_err(|e| SqliteError(format!("invalid UTF-16 text: {e}")))
            }
            other => err(format!("unsupported text encoding {other}")),
        }
    }

    /// Read every row of the `sqlite_master` schema table (rootpage 1). Each
    /// row is `(type, name, tbl_name, rootpage, sql)`.
    fn master_rows(&self) -> Result<Vec<Vec<Value>>> {
        let mut cells = Vec::new();
        self.walk_table(1, &mut cells)?;
        let mut rows = Vec::with_capacity(cells.len());
        for (_rowid, record) in cells {
            rows.push(self.decode_record(&record)?);
        }
        Ok(rows)
    }

    /// Find the `(rootpage, create_sql)` for a table by name from
    /// `sqlite_master`.
    fn table_info(&self, table: &str) -> Result<(u32, Option<String>)> {
        for row in self.master_rows()? {
            // Columns: 0 type, 1 name, 2 tbl_name, 3 rootpage, 4 sql.
            let is_table = row.first().and_then(|v| v.as_str()) == Some("table");
            let name = row.get(1).and_then(|v| v.as_str());
            if is_table && name == Some(table) {
                let rootpage = row
                    .get(3)
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| SqliteError(format!("table {table} has no rootpage")))?;
                let sql = row.get(4).and_then(|v| v.as_str()).map(|s| s.to_string());
                return Ok((rootpage as u32, sql));
            }
        }
        err(format!("table not found: {table}"))
    }

    /// Whether a table with the given name exists.
    pub fn has_table(&self, table: &str) -> bool {
        self.table_info(table).is_ok()
    }

    /// All rows of `table`, each as `(rowid, Vec<Value>)` in column order.
    pub fn rows(&self, table: &str) -> Result<Vec<(i64, Vec<Value>)>> {
        let (rootpage, _sql) = self.table_info(table)?;
        let mut cells = Vec::new();
        self.walk_table(rootpage, &mut cells)?;
        let mut out = Vec::with_capacity(cells.len());
        for (rowid, record) in cells {
            out.push((rowid, self.decode_record(&record)?));
        }
        Ok(out)
    }

    /// Column names for `table`, parsed from its `CREATE TABLE` SQL in
    /// `sqlite_master`. Falls back to an error if the SQL is absent/unparseable
    /// (callers map columns positionally in that case).
    pub fn columns(&self, table: &str) -> Result<Vec<String>> {
        let (_rootpage, sql) = self.table_info(table)?;
        let sql = sql.ok_or_else(|| SqliteError(format!("table {table} has no CREATE SQL")))?;
        parse_create_columns(&sql)
            .ok_or_else(|| SqliteError(format!("could not parse columns from: {sql}")))
    }
}

/// Light parser for the column names of a `CREATE TABLE name (...)` statement.
///
/// Splits the top-level (paren-depth 1) comma-separated entries inside the
/// outermost parentheses, then takes the first identifier of each entry as the
/// column name. Entries whose first token is a table constraint keyword
/// (PRIMARY/FOREIGN/UNIQUE/CHECK/CONSTRAINT) are skipped. Handles
/// double-quoted, backtick-quoted and bracketed identifiers. This is
/// deliberately minimal — good enough for rosbag2's simple schemas.
fn parse_create_columns(sql: &str) -> Option<Vec<String>> {
    let open = sql.find('(')?;
    // Find the matching close paren for the first '('.
    let mut depth = 0usize;
    let mut close = None;
    for (i, ch) in sql.char_indices().skip(open) {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let inner = &sql[open + 1..close?];

    // Split on top-level commas (ignoring commas inside nested parens).
    let mut entries: Vec<String> = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (i, ch) in inner.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                entries.push(inner[start..i].to_string());
                start = i + 1;
            }
            _ => {}
        }
    }
    entries.push(inner[start..].to_string());

    let mut cols = Vec::new();
    for entry in entries {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (name, _rest) = first_identifier(trimmed)?;
        let upper = name.to_ascii_uppercase();
        if matches!(
            upper.as_str(),
            "PRIMARY" | "FOREIGN" | "UNIQUE" | "CHECK" | "CONSTRAINT"
        ) {
            continue;
        }
        cols.push(name);
    }
    if cols.is_empty() {
        None
    } else {
        Some(cols)
    }
}

/// Read the first identifier token from a column-definition string, returning
/// `(identifier, remainder)`. Handles quoting via `"..."`, `` `...` `` and
/// `[...]`; unquoted identifiers run until whitespace or `(`.
fn first_identifier(s: &str) -> Option<(String, &str)> {
    let s = s.trim_start();
    let mut chars = s.char_indices();
    let (_, first) = chars.next()?;
    let (close, strip) = match first {
        '"' => ('"', true),
        '`' => ('`', true),
        '[' => (']', true),
        _ => (' ', false),
    };
    if strip {
        // Quoted: read until the matching close quote.
        let mut buf = String::new();
        for (_, ch) in chars.by_ref() {
            if ch == close {
                return Some((buf, ""));
            }
            buf.push(ch);
        }
        None
    } else {
        // Unquoted: until whitespace or '('.
        let end = s
            .find(|c: char| c.is_whitespace() || c == '(')
            .unwrap_or(s.len());
        Some((s[..end].to_string(), &s[end..]))
    }
}

/// Build a `name -> index` map from a column-name list (first occurrence wins).
pub fn column_index(columns: &[String]) -> HashMap<String, usize> {
    let mut m = HashMap::new();
    for (i, c) in columns.iter().enumerate() {
        m.entry(c.clone()).or_insert(i);
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_single_byte() {
        assert_eq!(read_varint(&[0x00]).unwrap(), (0, 1));
        assert_eq!(read_varint(&[0x7f]).unwrap(), (127, 1));
    }

    #[test]
    fn varint_multi_byte() {
        // 0x81 0x00 -> 0b1_0000000 = 128.
        assert_eq!(read_varint(&[0x81, 0x00]).unwrap(), (128, 2));
        // 0x82 0x2c -> (2 << 7) | 0x2c = 256 + 44 = 300.
        assert_eq!(read_varint(&[0x82, 0x2c]).unwrap(), (300, 2));
    }

    #[test]
    fn varint_nine_bytes_uses_all_bits() {
        // 9 bytes: first 8 have high bit set, 9th contributes all 8 bits.
        let bytes = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
        let (v, n) = read_varint(&bytes).unwrap();
        assert_eq!(n, 9);
        assert_eq!(v, -1i64); // all bits set -> u64::MAX -> -1 as i64
    }

    #[test]
    fn varint_truncated_errors() {
        // High bit set but no following byte.
        assert!(read_varint(&[0x81]).is_err());
    }

    /// Decode a hand-built record exercising several serial types.
    /// header: [hdr_len, st_text("hi"), st_int8, st_real, st_null]
    /// "hi" -> text len 2 -> serial 2*2+13 = 17
    /// i8 -> serial 1
    /// f64 -> serial 7
    /// null -> serial 0
    #[test]
    fn record_decode_mixed_serial_types() {
        let db = make_empty_db();
        let mut rec = Vec::new();
        // serial type list (will prepend header length once known)
        let serials = [17u8, 1u8, 7u8, 0u8];
        let header_len = 1 + serials.len(); // 1 byte for the header-length varint
        rec.push(header_len as u8); // header length varint (single byte)
        rec.extend_from_slice(&serials);
        // body
        rec.extend_from_slice(b"hi"); // text
        rec.push(0xfb); // i8 = -5
        rec.extend_from_slice(&3.5f64.to_be_bytes()); // real
                                                      // null has no body
        let vals = db.decode_record(&rec).unwrap();
        assert_eq!(
            vals,
            vec![
                Value::Text("hi".into()),
                Value::Int(-5),
                Value::Real(3.5),
                Value::Null,
            ]
        );
    }

    #[test]
    fn record_decode_int_constants_and_blob() {
        let db = make_empty_db();
        // serials: 8 (int 0, no body), 9 (int 1, no body), 16 (blob len 2)
        let serials = [8u8, 9u8, 16u8];
        let mut rec = vec![(1 + serials.len()) as u8];
        rec.extend_from_slice(&serials);
        rec.extend_from_slice(&[0xaa, 0xbb]); // blob
        let vals = db.decode_record(&rec).unwrap();
        assert_eq!(
            vals,
            vec![Value::Int(0), Value::Int(1), Value::Blob(vec![0xaa, 0xbb])]
        );
    }

    #[test]
    fn parse_create_columns_basic() {
        let sql = "CREATE TABLE messages (id INTEGER PRIMARY KEY, topic_id INTEGER, \
                   timestamp INTEGER, data BLOB)";
        let cols = parse_create_columns(sql).unwrap();
        assert_eq!(cols, vec!["id", "topic_id", "timestamp", "data"]);
    }

    #[test]
    fn parse_create_columns_skips_table_constraints_and_quotes() {
        let sql = "CREATE TABLE t (\"id\" INTEGER, `name` TEXT, value REAL, \
                   PRIMARY KEY(id), FOREIGN KEY(name) REFERENCES other(x))";
        let cols = parse_create_columns(sql).unwrap();
        assert_eq!(cols, vec!["id", "name", "value"]);
    }

    /// Build a minimal valid header-only db so we can call decode_* helpers
    /// (which only need `text_encoding`/`usable`).
    fn make_empty_db() -> SqliteDb {
        let mut bytes = vec![0u8; 4096];
        bytes[0..16].copy_from_slice(HEADER_MAGIC);
        bytes[16..18].copy_from_slice(&4096u16.to_be_bytes());
        bytes[28..32].copy_from_slice(&1u32.to_be_bytes());
        bytes[56..60].copy_from_slice(&1u32.to_be_bytes()); // UTF-8
                                                            // page 1 b-tree header: leaf table, 0 cells.
        bytes[100] = 0x0d;
        SqliteDb::open(&bytes).unwrap()
    }

    /// Synthesize a one-page table-leaf with a single big BLOB cell whose
    /// payload spills onto overflow pages, then verify `read_payload`
    /// reassembles it byte-for-byte. This is the only way to exercise the
    /// overflow chain since the committed fixtures keep all payloads inline.
    #[test]
    fn overflow_payload_reassembles() {
        let page_size = 512usize; // small page => low spill threshold
        let usable = page_size;
        let x = usable - 35; // 477

        // A payload comfortably larger than X so it must spill.
        let payload_len = 1500usize;
        let payload: Vec<u8> = (0..payload_len).map(|i| (i % 251) as u8).collect();

        // Overflow math (table leaf):
        let m = ((usable - 12) * 32 / 255) - 23;
        let k = m + ((payload_len - m) % (usable - 4));
        let local = if k <= x { k } else { m };
        let rest = payload_len - local;
        let per_ov = usable - 4; // content bytes per overflow page
        let n_ov = rest.div_ceil(per_ov);

        // Build the file: page1 = leaf table with one cell, then n_ov overflow
        // pages.
        let page_count = 1 + n_ov;
        let mut bytes = vec![0u8; page_count * page_size];
        // file header
        bytes[0..16].copy_from_slice(HEADER_MAGIC);
        bytes[16..18].copy_from_slice(&(page_size as u16).to_be_bytes());
        bytes[28..32].copy_from_slice(&(page_count as u32).to_be_bytes());
        bytes[56..60].copy_from_slice(&1u32.to_be_bytes());

        // Cell layout on page 1: we hand-place the cell near the page start
        // after the header + cell-pointer array. Header is at offset 100.
        // We'll put the cell content at offset 200 for simplicity.
        let cell_off = 200usize;
        // b-tree header (leaf table) at offset 100.
        bytes[100] = 0x0d;
        bytes[100 + 3..100 + 5].copy_from_slice(&1u16.to_be_bytes()); // cell count = 1
                                                                      // cell pointer array (1 entry, at offset 108) -> cell_off
        bytes[108..110].copy_from_slice(&(cell_off as u16).to_be_bytes());

        // Cell: payload-length varint, rowid varint, then `local` payload bytes
        // + 4-byte overflow pointer.
        let mut cell = Vec::new();
        // payload length varint
        let mut tmp = Vec::new();
        write_varint(payload_len as u64, &mut tmp);
        cell.extend_from_slice(&tmp);
        // rowid varint = 1
        cell.push(0x01);
        cell.extend_from_slice(&payload[..local]);
        let first_ov_page = 2u32; // page index of first overflow page
        cell.extend_from_slice(&first_ov_page.to_be_bytes());
        bytes[cell_off..cell_off + cell.len()].copy_from_slice(&cell);

        // Fill overflow pages.
        let mut written = local;
        for i in 0..n_ov {
            let page_idx = 2 + i; // 1-indexed page number
            let page_start = (page_idx - 1) * page_size;
            let next = if i + 1 < n_ov {
                (2 + i + 1) as u32
            } else {
                0u32
            };
            bytes[page_start..page_start + 4].copy_from_slice(&next.to_be_bytes());
            let take = (payload_len - written).min(per_ov);
            bytes[page_start + 4..page_start + 4 + take]
                .copy_from_slice(&payload[written..written + take]);
            written += take;
        }

        let db = SqliteDb::open(&bytes).unwrap();
        let page1 = db.page(1).unwrap().to_vec();
        // payload starts after the two varints in the cell.
        let (plen, n1) = read_varint(&page1[cell_off..]).unwrap();
        assert_eq!(plen as usize, payload_len);
        let (_rowid, n2) = read_varint(&page1[cell_off + n1..]).unwrap();
        let payload_start = cell_off + n1 + n2;
        let got = db.read_payload(&page1, payload_start, payload_len).unwrap();
        assert_eq!(got, payload, "overflow payload mismatch");
    }

    /// Helper: encode a u64 as a SQLite varint into `out` (test-only).
    fn write_varint(mut v: u64, out: &mut Vec<u8>) {
        if v == 0 {
            out.push(0);
            return;
        }
        // Collect 7-bit groups, least-significant first (test values stay well
        // under the 9-byte special case).
        let mut groups: Vec<u8> = Vec::new();
        while v > 0 {
            groups.push((v & 0x7f) as u8);
            v >>= 7;
        }
        // Emit most-significant first; set the continuation bit on all but the
        // final (least-significant) group.
        let n = groups.len();
        for (k, g) in groups.iter().rev().enumerate() {
            let last = k == n - 1;
            out.push(if last { *g } else { *g | 0x80 });
        }
    }

    // ----- Fixture-backed low-level tests -----

    fn read_fixture(name: &str) -> Vec<u8> {
        let path = format!(
            "{}/../../test-fixtures/ros/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    }

    #[test]
    fn synth_imu_tables_parse() {
        let bytes = read_fixture("synth_imu.db3");
        let db = SqliteDb::open(&bytes).unwrap();

        let cols = db.columns("topics").unwrap();
        assert_eq!(
            cols,
            vec![
                "id",
                "name",
                "type",
                "serialization_format",
                "offered_qos_profiles",
                "type_description_hash"
            ]
        );

        let topics = db.rows("topics").unwrap();
        assert_eq!(topics.len(), 2, "synth_imu has 2 topics");
        let names: Vec<&str> = topics.iter().filter_map(|(_, r)| r[1].as_str()).collect();
        assert!(names.contains(&"/imu/data"));
        assert!(names.contains(&"/temperature"));
        let types: Vec<&str> = topics.iter().filter_map(|(_, r)| r[2].as_str()).collect();
        assert!(types.contains(&"sensor_msgs/msg/Imu"));
        assert!(types.contains(&"std_msgs/msg/Float64"));

        let msgs = db.rows("messages").unwrap();
        assert_eq!(msgs.len(), 110, "synth_imu has 110 messages");
        // Every message has a non-empty data blob.
        for (_, r) in &msgs {
            let data = r[3].as_blob().expect("data column is blob");
            assert!(!data.is_empty());
        }
    }

    #[test]
    fn cdr_test_tables_parse() {
        let bytes = read_fixture("ros2_cdr_test.db3");
        let db = SqliteDb::open(&bytes).unwrap();

        assert!(db.has_table("topics"));
        assert!(db.has_table("messages"));

        let topics = db.rows("topics").unwrap();
        assert_eq!(topics.len(), 2);
        let types: Vec<&str> = topics.iter().filter_map(|(_, r)| r[2].as_str()).collect();
        assert!(types.contains(&"test_msgs/msg/BasicTypes"));
        assert!(types.contains(&"test_msgs/msg/Arrays"));

        let msgs = db.rows("messages").unwrap();
        assert_eq!(msgs.len(), 7, "cdr_test has 7 messages");
        for (_, r) in &msgs {
            assert!(r[3].as_blob().is_some());
        }
    }
}
