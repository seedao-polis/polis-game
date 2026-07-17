//! Role-based access control: `open_id -> role -> (datasource x read/write)`.
//!
//! Loaded once at startup from `acl.toml` (see `config/acl.toml.example`). A malformed or
//! missing ACL file is a hard startup failure -- this service never falls back to an empty,
//! all-permissive ACL.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::db::Operation;
use crate::error::AppError;

/// Sentinel role name meaning "reject any identity not explicitly listed".
const DENY_ROLE: &str = "deny";

#[derive(Debug, Deserialize)]
struct RoleDef {
    #[serde(default)]
    read: Vec<String>,
    #[serde(default)]
    write: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct UserEntry {
    open_id: String,
    role: String,
}

#[derive(Debug, Deserialize)]
struct AclFile {
    #[serde(default)]
    roles: HashMap<String, RoleDef>,
    #[serde(default, rename = "user")]
    user: Vec<UserEntry>,
    /// Role applied to an identity that authenticated successfully but has no `[[user]]` entry.
    /// Set to `"deny"` to reject everyone not explicitly listed.
    default_role: Option<String>,
}

pub struct AclConfig {
    roles: HashMap<String, RoleDef>,
    users: HashMap<String, String>,
    default_role: String,
}

impl AclConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading ACL file at {}", path.display()))?;
        Self::parse(&raw)
    }

    fn parse(raw: &str) -> Result<Self> {
        let parsed: AclFile = toml::from_str(raw).context("parsing acl.toml")?;
        let default_role = parsed.default_role.unwrap_or_else(|| DENY_ROLE.to_string());

        // Fail fast on a config typo rather than silently denying everyone at request time.
        if default_role != DENY_ROLE && !parsed.roles.contains_key(&default_role) {
            anyhow::bail!("default_role {default_role:?} is not defined under [roles.*]");
        }
        for entry in &parsed.user {
            if !parsed.roles.contains_key(&entry.role) {
                anyhow::bail!(
                    "user {:?} references undefined role {:?}",
                    entry.open_id,
                    entry.role
                );
            }
        }

        let users = parsed
            .user
            .into_iter()
            .map(|entry| (entry.open_id, entry.role))
            .collect();

        Ok(Self {
            roles: parsed.roles,
            users,
            default_role,
        })
    }

    fn role_for(&self, open_id: &str) -> Option<&str> {
        self.users
            .get(open_id)
            .map(String::as_str)
            .or(Some(self.default_role.as_str()))
    }

    /// Returns `Ok(())` if `open_id` may perform `operation` against `db`, otherwise a
    /// `Forbidden` error suitable for returning straight to the client.
    pub fn authorize(&self, open_id: &str, db: &str, operation: Operation) -> Result<(), AppError> {
        let role_name = self
            .role_for(open_id)
            .ok_or_else(|| AppError::Forbidden("no role resolved for this identity".to_string()))?;

        if role_name == DENY_ROLE {
            return Err(AppError::Forbidden(format!(
                "open_id {open_id} has no assigned role and default_role is deny"
            )));
        }

        let role = self.roles.get(role_name).ok_or_else(|| {
            AppError::Forbidden(format!("role {role_name:?} is not defined in the ACL"))
        })?;

        let allowed = match operation {
            Operation::Read => role.read.iter().any(|d| d == db),
            Operation::Write => role.write.iter().any(|d| d == db),
        };

        if allowed {
            Ok(())
        } else {
            let verb = match operation {
                Operation::Read => "read",
                Operation::Write => "write",
            };
            Err(AppError::Forbidden(format!(
                "role {role_name:?} cannot {verb} datasource {db:?}"
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
        default_role = "readonly"

        [roles.admin]
        read = ["soul", "shared"]
        write = ["soul", "shared"]

        [roles.readonly]
        read = ["soul", "shared"]
        write = []

        [[user]]
        open_id = "ou_admin"
        role = "admin"
    "#;

    #[test]
    fn admin_can_write_shared() {
        let acl = AclConfig::parse(SAMPLE).unwrap();
        assert!(acl.authorize("ou_admin", "shared", Operation::Write).is_ok());
    }

    #[test]
    fn unlisted_identity_falls_back_to_default_role() {
        let acl = AclConfig::parse(SAMPLE).unwrap();
        assert!(acl.authorize("ou_stranger", "soul", Operation::Read).is_ok());
        assert!(acl.authorize("ou_stranger", "soul", Operation::Write).is_err());
    }

    #[test]
    fn deny_default_role_rejects_unlisted_identity() {
        // Only the quoted `default_role` value is replaced; `[roles.readonly]` is untouched.
        let raw = SAMPLE.replacen("\"readonly\"", "\"deny\"", 1);
        let acl = AclConfig::parse(&raw).unwrap();
        assert!(acl.authorize("ou_stranger", "soul", Operation::Read).is_err());
    }

    #[test]
    fn undefined_default_role_fails_to_load() {
        // Points `default_role` at a role name that is never defined under `[roles.*]`.
        let raw = SAMPLE.replacen("\"readonly\"", "\"ghost\"", 1);
        assert!(AclConfig::parse(&raw).is_err());
    }
}
