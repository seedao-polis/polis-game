//! Statement-level guard for the raw-SQL endpoints.
//!
//! This is a deliberately simple prefix/keyword check, not a SQL parser: it strips leading
//! whitespace and comments to find the statement's first keyword, rejects anything with more
//! than one statement, and matches that keyword against an allow-list (`/query`) or a
//! deny-list (`/exec`). It stops naive misuse; it is not a defense against a determined attacker
//! trying to hide a second statement inside string literals or dialect quirks -- a real
//! query-level control needs a proper SQL parser (see the project README's known-limitations
//! section).

/// Strips leading whitespace and `--`/`/* */` comments, returning what remains. Used only to
/// find the statement's leading keyword; the original SQL text is always what gets executed.
fn skip_leading_trivia(mut s: &str) -> &str {
    loop {
        let trimmed = s.trim_start();
        if let Some(rest) = trimmed.strip_prefix("--") {
            s = match rest.find('\n') {
                Some(idx) => &rest[idx + 1..],
                None => "",
            };
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("/*") {
            s = match rest.find("*/") {
                Some(idx) => &rest[idx + 2..],
                None => "",
            };
            continue;
        }
        return trimmed;
    }
}

/// True if, after stripping one optional trailing `;`, another `;` remains -- i.e. the caller
/// tried to smuggle a second statement into a single request.
fn has_multiple_statements(sql: &str) -> bool {
    let body = sql.trim().trim_end_matches(';');
    body.contains(';')
}

/// Validates a `POST /query` body: only `SELECT`, `PRAGMA table_info`, and `EXPLAIN` are
/// allowed, so this endpoint can never be used as a write side-channel.
pub fn validate_query(sql: &str) -> Result<(), String> {
    if has_multiple_statements(sql) {
        return Err("multiple statements are not allowed".to_string());
    }
    let head = skip_leading_trivia(sql).to_ascii_lowercase();
    if head.starts_with("select")
        || head.starts_with("pragma table_info")
        || head.starts_with("explain")
    {
        return Ok(());
    }
    Err("only SELECT, PRAGMA table_info, and EXPLAIN statements are allowed on /query".to_string())
}

/// Blocked statement prefixes for `POST /exec`: anything that changes schema, rewrites the
/// database file, or could otherwise destabilize concurrent readers/writers on the same file.
const EXEC_BLOCKLIST: &[&str] = &[
    "vacuum",
    "alter",
    "drop",
    "create",
    "attach",
    "detach",
    "pragma journal_mode",
    "pragma writable_schema",
    "reindex",
];

/// Validates a `POST /exec` body against the dangerous-statement deny-list. Ordinary
/// `INSERT`/`UPDATE`/`DELETE` (and anything else not on the list) pass through, since the actual
/// read/write permission check happens separately in the RBAC layer.
pub fn validate_exec(sql: &str) -> Result<(), String> {
    if has_multiple_statements(sql) {
        return Err("multiple statements are not allowed".to_string());
    }
    let head = skip_leading_trivia(sql).to_ascii_lowercase();
    for blocked in EXEC_BLOCKLIST {
        if head.starts_with(blocked) {
            return Err(format!(
                "statements starting with '{blocked}' are not allowed on /exec"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_plain_select() {
        assert!(validate_query("SELECT * FROM profiles").is_ok());
    }

    #[test]
    fn allows_pragma_table_info() {
        assert!(validate_query("pragma table_info(profiles)").is_ok());
    }

    #[test]
    fn rejects_insert_on_query() {
        assert!(validate_query("INSERT INTO profiles VALUES (1)").is_err());
    }

    #[test]
    fn rejects_commented_insert_on_query() {
        assert!(validate_query("-- sneaky\nINSERT INTO profiles VALUES (1)").is_err());
    }

    #[test]
    fn rejects_multi_statement_query() {
        assert!(validate_query("SELECT 1; DROP TABLE profiles").is_err());
    }

    #[test]
    fn allows_insert_update_delete_on_exec() {
        assert!(validate_exec("INSERT INTO profiles VALUES (1)").is_ok());
        assert!(validate_exec("UPDATE profiles SET x = 1").is_ok());
        assert!(validate_exec("DELETE FROM profiles").is_ok());
    }

    #[test]
    fn rejects_drop_table_on_exec() {
        assert!(validate_exec("DROP TABLE profiles").is_err());
    }

    #[test]
    fn rejects_vacuum_on_exec() {
        assert!(validate_exec("VACUUM").is_err());
    }

    #[test]
    fn rejects_pragma_journal_mode_on_exec() {
        assert!(validate_exec("PRAGMA journal_mode=DELETE").is_err());
    }
}
