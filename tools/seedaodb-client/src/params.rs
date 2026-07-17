//! Parsing for repeatable `--param` values on the `query`/`exec` subcommands.

use serde_json::Value;

/// Parses a single `--param` CLI value into a JSON value for positional SQL binding.
///
/// Each value is first tried as JSON, so `null`, `true`/`false`, and integers/floats bind as
/// their native SQLite storage classes; anything that fails to parse as JSON (including a bare,
/// unquoted word) is sent as a plain JSON string instead, so an ordinary text value never needs
/// manual quoting on the command line.
pub fn parse_param(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_null() {
        assert_eq!(parse_param("null"), Value::Null);
    }

    #[test]
    fn parses_integer() {
        assert_eq!(parse_param("42"), json!(42));
    }

    #[test]
    fn parses_negative_float() {
        assert_eq!(parse_param("-3.14"), json!(-3.14));
    }

    #[test]
    fn parses_boolean() {
        assert_eq!(parse_param("true"), json!(true));
        assert_eq!(parse_param("false"), json!(false));
    }

    #[test]
    fn parses_quoted_json_string() {
        assert_eq!(parse_param("\"hello\""), json!("hello"));
    }

    #[test]
    fn falls_back_to_plain_string_on_parse_failure() {
        assert_eq!(parse_param("hello world"), json!("hello world"));
        assert_eq!(parse_param("ou_abc123"), json!("ou_abc123"));
    }
}
