pub(super) fn collapse_ws(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;

    for ch in input.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(ch);
        }
    }

    out
}

/// Shorten `text` to at most `max_chars` characters, ending with an ellipsis when cut.
pub(super) fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_and_trims_whitespace_without_an_intermediate_vec() {
        assert_eq!(collapse_ws("  alpha\tbeta\n gamma  "), "alpha beta gamma");
        assert_eq!(collapse_ws("\u{2003}alpha\u{00a0}beta"), "alpha beta");
        assert_eq!(collapse_ws("   "), "");
    }
}
