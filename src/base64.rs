//! Minimal Base64 encode/decode (RFC 4648, standard alphabet).

/// Decode standard Base64 text. Returns None on invalid input.
pub fn decode(input: &str) -> Option<Vec<u8>> {
    let mut vals = Vec::new();
    for c in input.bytes() {
        if c == b'=' {
            continue;
        }
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        vals.push(v as u32);
    }
    if vals.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(vals.len() * 3 / 4);
    let mut i = 0;
    while i + 4 <= vals.len() {
        let n = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
        out.push((n >> 16) as u8);
        out.push((n >> 8) as u8);
        out.push(n as u8);
        i += 4;
    }
    let rem = vals.len() - i;
    if rem == 2 {
        let n = (vals[i] << 18) | (vals[i + 1] << 12);
        out.push((n >> 16) as u8);
    } else if rem == 3 {
        let n = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6);
        out.push((n >> 16) as u8);
        out.push((n >> 8) as u8);
    }
    Some(out)
}
