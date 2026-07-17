//! Best-effort, purely informational lark-cli identity cross-check for `whoami`.
//!
//! This module never supplies anything that gets sent to seedaodb -- it only shells out to the
//! machine's own lark-cli installation (if any) so `whoami` can print "this machine's lark-cli
//! thinks you are ou_xxx" next to the identity this client authenticated with, as a sanity check
//! for the operator. Failure to find or run lark-cli is never fatal to `whoami`.
//!
//! lark-cli does not export a usable access token to external callers (only login state
//! metadata), so it cannot be "borrowed" to authenticate this client's own requests -- see
//! `auth::login_feishu` for how this client obtains its own token instead.
//!
//! On Windows, a globally npm-installed `lark-cli` is a `.cmd` shim, which `std::process::Command`
//! does not reliably invoke without an extra shell layer (and its own argument-escaping quirks).
//! The host project's own TypeScript tooling avoids this entirely by resolving lark-cli's
//! `run.js` script and invoking it directly with `node`, and this module mirrors the same
//! candidate-path search rather than calling `lark-cli`/`lark-cli.cmd` directly.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

/// Outcome of attempting to run `node <run.js> auth status --json`.
#[derive(Debug)]
pub enum LarkProbeResult {
    /// No candidate `run.js` path could be located.
    RunJsNotFound,
    /// A `run.js` path was found but `node` could not be spawned (e.g. not on `PATH`).
    SpawnFailed(String),
    /// The child process ran but exited non-zero.
    CommandFailed(String),
    /// The child process succeeded but its stdout was not valid JSON.
    UnparseableOutput,
    /// Successfully parsed `auth status --json` output.
    Identity(Value),
}

/// Resolves lark-cli's `run.js` using real process environment variables and `PATH`.
pub fn resolve_lark_run(explicit: Option<&str>) -> Option<PathBuf> {
    resolve_lark_run_with(explicit, |key| std::env::var(key).ok())
}

/// Core resolution logic, parameterized over an environment lookup so it can be unit-tested
/// without depending on the real machine's installed lark-cli/node/PATH.
///
/// Candidate order: an explicit override (`SEEDAODB_CLIENT_LARK_RUN`, passed in as `explicit`),
/// then the `LARK_RUN` environment variable, then a Windows nvm-symlink global-install path,
/// then `<node dir>/../lib/node_modules/...` (macOS/Linux and nvm-style installs), then
/// `<node dir>/node_modules/...` (Windows standard installs). The first candidate that exists on
/// disk wins.
pub fn resolve_lark_run_with(
    explicit: Option<&str>,
    env_lookup: impl Fn(&str) -> Option<String>,
) -> Option<PathBuf> {
    if let Some(v) = explicit.filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(v));
    }
    if let Some(v) = env_lookup("LARK_RUN").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(v));
    }

    let rel: PathBuf = ["@larksuite", "cli", "scripts", "run.js"].iter().collect();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(appdata) = env_lookup("APPDATA").filter(|v| !v.is_empty()) {
        candidates.push(
            Path::new(&appdata)
                .join("nvm_symlink")
                .join("node_modules")
                .join(&rel),
        );
    }

    if let Some(node_dir) = find_node_dir(&env_lookup) {
        candidates.push(node_dir.join("..").join("lib").join("node_modules").join(&rel));
        candidates.push(node_dir.join("node_modules").join(&rel));
    }

    candidates.into_iter().find(|c| c.exists())
}

/// Locates the directory containing the `node`/`node.exe` executable by scanning `PATH`, the
/// same directory `resolveLarkRun()` derives from `process.execPath` on the TypeScript side.
/// Unlike a lark-cli shim, the `node` executable itself is invoked by name later and does not
/// need this resolved path -- it is only used to build the `node_modules` candidate directories.
fn find_node_dir(env_lookup: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let path_var = env_lookup("PATH")?;
    let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(exe_name))
        .find(|candidate| candidate.exists())
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// Runs `node <run.js> auth status --json` and returns its parsed identity, or a reason it could
/// not be obtained. Always returns rather than propagating an error -- callers treat every
/// variant as non-fatal, informational-only.
pub fn probe_identity(explicit_lark_run: Option<&str>) -> LarkProbeResult {
    let Some(run_js) = resolve_lark_run(explicit_lark_run) else {
        return LarkProbeResult::RunJsNotFound;
    };

    match Command::new("node")
        .arg(&run_js)
        .arg("auth")
        .arg("status")
        .arg("--json")
        .output()
    {
        Ok(output) if output.status.success() => {
            match serde_json::from_slice::<Value>(&output.stdout) {
                Ok(v) => LarkProbeResult::Identity(v),
                Err(_) => LarkProbeResult::UnparseableOutput,
            }
        }
        Ok(output) => {
            LarkProbeResult::CommandFailed(String::from_utf8_lossy(&output.stderr).into_owned())
        }
        Err(e) => LarkProbeResult::SpawnFailed(e.to_string()),
    }
}

/// Renders a `LarkProbeResult` as a single line of text for `whoami` output.
pub fn describe(result: &LarkProbeResult) -> String {
    match result {
        LarkProbeResult::RunJsNotFound => {
            "lark-cli cross-check: skipped (could not locate lark-cli's run.js; set LARK_RUN or \
             SEEDAODB_CLIENT_LARK_RUN, or ignore this if lark-cli is not installed)"
                .to_string()
        }
        LarkProbeResult::SpawnFailed(e) => {
            format!("lark-cli cross-check: skipped (could not run node: {e})")
        }
        LarkProbeResult::CommandFailed(stderr) => {
            format!(
                "lark-cli cross-check: skipped (lark-cli exited with an error: {})",
                stderr.trim()
            )
        }
        LarkProbeResult::UnparseableOutput => {
            "lark-cli cross-check: skipped (lark-cli did not return valid JSON)".to_string()
        }
        LarkProbeResult::Identity(v) => {
            let user = &v["identities"]["user"];
            let open_id = user["openId"].as_str().unwrap_or("(unknown)");
            let user_name = user["userName"].as_str().unwrap_or("(unknown)");
            let token_status = user["tokenStatus"].as_str().unwrap_or("(unknown)");
            format!(
                "lark-cli cross-check: this machine's lark-cli identity is {user_name} \
                 (open_id={open_id}, tokenStatus={token_status}) -- compare against the open_id \
                 above; this is informational only and was never sent to seedaodb"
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_override_wins_over_everything_else() {
        let result = resolve_lark_run_with(Some("/explicit/run.js"), |key| {
            if key == "LARK_RUN" {
                Some("/should-not-be-used/run.js".to_string())
            } else {
                None
            }
        });
        assert_eq!(result, Some(PathBuf::from("/explicit/run.js")));
    }

    #[test]
    fn lark_run_env_var_used_when_no_explicit_value() {
        let result = resolve_lark_run_with(None, |key| {
            if key == "LARK_RUN" {
                Some("/via-env/run.js".to_string())
            } else {
                None
            }
        });
        assert_eq!(result, Some(PathBuf::from("/via-env/run.js")));
    }

    #[test]
    fn returns_none_when_nothing_resolves() {
        // An empty PATH guarantees find_node_dir locates nothing; no APPDATA/LARK_RUN configured
        // either, so every candidate directory is unreachable.
        let result = resolve_lark_run_with(None, |key| {
            if key == "PATH" {
                Some(String::new())
            } else {
                None
            }
        });
        assert_eq!(result, None);
    }

    #[test]
    fn describe_reports_missing_run_js_without_panicking() {
        let text = describe(&LarkProbeResult::RunJsNotFound);
        assert!(text.contains("skipped"));
    }

    #[test]
    fn describe_extracts_identity_fields_from_auth_status_shape() {
        let value = serde_json::json!({
            "identities": {
                "user": {
                    "openId": "ou_test123",
                    "userName": "Test User",
                    "tokenStatus": "ready"
                }
            }
        });
        let text = describe(&LarkProbeResult::Identity(value));
        assert!(text.contains("ou_test123"));
        assert!(text.contains("Test User"));
        assert!(text.contains("ready"));
    }
}
