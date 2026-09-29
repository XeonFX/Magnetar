const UNITS: [&str; 6] = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/// Formats a byte count as a binary size, e.g. "1.4 GiB".
pub fn format_bytes(bytes: f64) -> String {
    let mut size = bytes.max(0.0);
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    let rounded = (size * 10.0).round() / 10.0;
    format!("{rounded} {}", UNITS[unit])
}

/// Formats a per-second rate, e.g. "2.3 MiB/s".
pub fn format_rate(bytes_per_second: f64) -> String {
    format!("{}/s", format_bytes(bytes_per_second))
}

/// Parses "1.4 GiB" or "550.3 MB" into bytes; 0 when unparseable. Sites use binary units under both spellings.
pub fn parse_bytes(text: &str) -> u64 {
    let normalized = text.replace('\u{a0}', " ");
    let mut parts = normalized.split_whitespace();
    let (Some(value), Some(unit)) = (parts.next(), parts.next()) else { return 0 };
    let Ok(value) = leading_float(value) else { return 0 };
    let multiplier: f64 = match unit.to_ascii_uppercase().as_str() {
        "KIB" | "KB" => 1024.0,
        "MIB" | "MB" => 1024f64.powi(2),
        "GIB" | "GB" => 1024f64.powi(3),
        "TIB" | "TB" => 1024f64.powi(4),
        _ => 1.0,
    };
    (value * multiplier).trunc().max(0.0) as u64
}

/// `parseFloat`: the longest numeric prefix.
fn leading_float(text: &str) -> Result<f64, ()> {
    let end = text
        .char_indices()
        .find(|&(i, c)| !(c.is_ascii_digit() || c == '.' || (i == 0 && (c == '-' || c == '+'))))
        .map_or(text.len(), |(i, _)| i);
    text[..end].parse::<f64>().map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_and_parse_binary_units() {
        assert_eq!(format_bytes(1536.0), "1.5 KiB");
        assert_eq!(format_bytes(0.0), "0 B");
        assert_eq!(format_rate(2.0 * 1024.0 * 1024.0), "2 MiB/s");
        assert_eq!(parse_bytes("6.07 GiB"), 6517612871);
        assert_eq!(parse_bytes("1.1 GB"), 1181116006);
        assert_eq!(parse_bytes("624\u{a0}MiB"), 654311424);
        assert_eq!(parse_bytes("junk"), 0);
    }
}
