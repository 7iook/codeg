//! Kiro CLI transcript parser.
//!
//! Kiro stores each CLI conversation as a single newline-delimited JSON file:
//!
//! ```text
//! <KIRO_HOME>/                     (default ~/.kiro, override via KIRO_HOME)
//! └── sessions/
//!     └── cli/
//!         └── <session-uuid>.jsonl
//! ```
//!
//! Every line is an envelope `{"version":"v1","kind":…,"data":{…}}`. codeg only
//! ever reads these files.
//!
//! The IDE/spec transcript layout (`<KIRO_HOME>/sessions/<hash>/sess_<uuid>/`)
//! is a different format and is deliberately out of scope.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::models::{ConversationDetail, ConversationSummary};
use crate::parsers::{AgentParser, ParseError};

/// Resolve Kiro's data home, honoring `KIRO_HOME`, else `~/.kiro`.
///
/// This is the single resolution point for every consumer of Kiro data
/// (transcripts, custom agent scan, MCP config read/write, and the ACP write
/// boundary) so they can never disagree on which root is in use.
pub(crate) fn resolve_kiro_home_dir() -> PathBuf {
    resolve_kiro_home_from(std::env::var_os("KIRO_HOME"), dirs::home_dir())
}

fn resolve_kiro_home_from(kiro_home_env: Option<OsString>, home_dir: Option<PathBuf>) -> PathBuf {
    kiro_home_env
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.unwrap_or_default().join(".kiro"))
}

/// Directory holding the CLI transcripts: `<KIRO_HOME>/sessions/cli`.
pub(crate) fn kiro_cli_sessions_dir() -> PathBuf {
    resolve_kiro_home_dir().join("sessions").join("cli")
}

pub struct KiroParser {
    base_dir: PathBuf,
}

impl KiroParser {
    pub fn new() -> Self {
        Self {
            base_dir: kiro_cli_sessions_dir(),
        }
    }

    /// Construct against an explicit transcript directory (tests inject a temp
    /// dir; mirrors the `_at` convention used elsewhere in the codebase).
    #[allow(dead_code)]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }
}

impl Default for KiroParser {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentParser for KiroParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        // TODO(kiro-W1-P1): enumerate `<base_dir>/*.jsonl`.
        let _ = &self.base_dir;
        Ok(Vec::new())
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        // TODO(kiro-W1-P1): parse the envelope stream into turns.
        Err(ParseError::ConversationNotFound(
            conversation_id.to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kiro_home_prefers_the_env_override() {
        let root = std::env::temp_dir().join("codeg-kiro-home-test");
        let resolved = resolve_kiro_home_from(
            Some(OsString::from(root.as_os_str())),
            Some(PathBuf::from("/should-not-be-used")),
        );
        assert_eq!(resolved, root);
    }

    #[test]
    fn kiro_home_falls_back_to_the_home_directory() {
        let home = std::env::temp_dir().join("codeg-kiro-fake-home");
        let resolved = resolve_kiro_home_from(None, Some(home.clone()));
        assert_eq!(resolved, home.join(".kiro"));
    }

    #[test]
    fn blank_kiro_home_falls_through_to_the_home_directory() {
        let home = std::env::temp_dir().join("codeg-kiro-fake-home");
        let resolved = resolve_kiro_home_from(Some(OsString::new()), Some(home.clone()));
        assert_eq!(resolved, home.join(".kiro"));
    }
}
